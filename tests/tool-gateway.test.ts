import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FixedApprovalHandler } from "../src/governance/policy-engine.js";
import type {
  PolicyDecision,
  PolicyEngine,
} from "../src/governance/policy-engine.js";
import type { ToolRequest } from "../src/protocol/agent-protocol.js";
import type {
  CommandResult,
  ExecuteCommand,
  SandboxConfig,
  SandboxProvider,
  SandboxReference,
} from "../src/sandbox/sandbox-provider.js";
import { ToolGateway } from "../src/tools/tool-gateway.js";

class AllowPolicy implements PolicyEngine {
  async evaluate(): Promise<PolicyDecision> {
    return { outcome: "ALLOW", rule: "test", reason: "test" };
  }
}

class DenyPolicy implements PolicyEngine {
  async evaluate(): Promise<PolicyDecision> {
    return {
      outcome: "DENY",
      rule: "agent-tool-allowlist",
      reason: "Tool is outside the agent profile",
    };
  }
}

class RecordingSandbox implements SandboxProvider {
  readonly commands: ExecuteCommand[] = [];
    readonly placement = "local" as const;

  async create(_config: SandboxConfig): Promise<SandboxReference> {
    return { id: "sandbox", provider: "local-docker" };
  }

  async execute(input: ExecuteCommand): Promise<CommandResult> {
    this.commands.push(input);
    return {
      exitCode: 0,
      stdout: input.command[1] === "status" ? " M package.json\n" : "diff output\n",
      stderr: "",
      durationMs: 1,
      truncated: false,
    };
  }

  async terminate(): Promise<void> {}
}

function gateway(
  sandbox: RecordingSandbox,
  runtime: "node" | "python" = "node",
): ToolGateway {
  return new ToolGateway({
    sandboxProvider: sandbox,
    sandboxId: "sandbox",
    policyEngine: new AllowPolicy(),
    approvalHandler: new FixedApprovalHandler(true),
    runtime,
  });
}

describe("catalog tool implementations", () => {
  it("reports hard policy denials as internal governance metadata", async () => {
    const sandbox = new RecordingSandbox();
    const result = await new ToolGateway({
      sandboxProvider: sandbox,
      sandboxId: "sandbox",
      policyEngine: new DenyPolicy(),
      approvalHandler: new FixedApprovalHandler(true),
    }).invoke({
      id: "blocked",
      name: "unregistered.tool",
      arguments: {},
    });

    assert.equal(result.success, false);
    assert.equal(result.telemetry?.policyOutcome, "DENY");
    assert.equal(result.telemetry?.policyRule, "agent-tool-allowlist");
    assert.equal(result.telemetry?.commandCount, 0);
    assert.equal(sandbox.commands.length, 0);
  });

  it("marks denied escape attempts for immediate halt with bounded detections", async () => {
    const sandbox = new RecordingSandbox();
    const result = await new ToolGateway({
      sandboxProvider: sandbox,
      sandboxId: "sandbox",
      policyEngine: new DenyPolicy(),
      approvalHandler: new FixedApprovalHandler(true),
    }).invoke({
      id: "escape-attempt",
      name: "security.escape_attempt",
      arguments: {},
    });

    assert.equal(result.success, false);
    assert.equal(result.telemetry?.haltExecution, true);
    assert.deepEqual(result.telemetry?.securityDetections, [
      { signal: "root-filesystem-access", boundary: "host" },
      { signal: "credential-discovery", boundary: "host" },
      { signal: "container-runtime-access", boundary: "host" },
    ]);
    assert.equal(result.telemetry?.commandCount, 0);
    assert.equal(sandbox.commands.length, 0);
  });

  it("constructs npm install without a shell", async () => {
    const sandbox = new RecordingSandbox();
    const result = await gateway(sandbox).invoke({
      id: "install",
      name: "package.install",
      arguments: { packages: ["vue@^3.5.0", "vite@^7.0.0"], development: true },
    });
    assert.equal(result.success, true);
    assert.deepEqual(sandbox.commands[0]?.command, [
      "npm",
      "install",
      "--save-dev",
      "vue@^3.5.0",
      "vite@^7.0.0",
    ]);
  });

  it("rejects package option injection", async () => {
    const sandbox = new RecordingSandbox();
    const request: ToolRequest = {
      id: "install",
      name: "package.install",
      arguments: { packages: ["--ignore-scripts"] },
    };
    const result = await gateway(sandbox).invoke(request);
    assert.equal(result.success, false);
    assert.match(result.output, /cannot be command options/);
    assert.equal(sandbox.commands.length, 0);
  });

  it("creates a Python virtual environment and installs requirements", async () => {
    const sandbox = new RecordingSandbox();
    const result = await gateway(sandbox, "python").invoke({
      id: "install",
      name: "package.install",
      arguments: { requirementsFile: "requirements-dev.txt" },
    });
    assert.equal(result.success, true);
    assert.deepEqual(sandbox.commands.map(({ command }) => command), [
      ["python3", "-m", "venv", ".venv"],
      [
        ".venv/bin/python",
        "-m",
        "pip",
        "install",
        "build",
        "pytest",
        "-r",
        "requirements-dev.txt",
      ],
    ]);
  });

  it("uses fixed Python test and build commands", async () => {
    const sandbox = new RecordingSandbox();
    await gateway(sandbox, "python").invoke({
      id: "test",
      name: "test.run",
      arguments: {},
    });
    await gateway(sandbox, "python").invoke({
      id: "build",
      name: "build.run",
      arguments: {},
    });
    assert.deepEqual(sandbox.commands.map(({ command }) => command), [
      [".venv/bin/python", "-m", "pytest"],
      [".venv/bin/python", "-m", "build"],
    ]);
  });

  it("rejects Python requirements paths outside the workspace", async () => {
    const sandbox = new RecordingSandbox();
    const result = await gateway(sandbox, "python").invoke({
      id: "install",
      name: "package.install",
      arguments: { requirementsFile: "../requirements.txt" },
    });
    assert.equal(result.success, false);
    assert.match(result.output, /cannot escape the workspace/);
    assert.equal(sandbox.commands.length, 0);
  });

  it("returns Git status and diff through fixed commands", async () => {
    const sandbox = new RecordingSandbox();
    const result = await gateway(sandbox).invoke({
      id: "diff",
      name: "git.diff",
      arguments: {},
    });
    assert.equal(result.success, true);
    assert.equal(sandbox.commands.length, 2);
    assert.deepEqual(sandbox.commands[0]?.command, ["git", "status", "--short"]);
    assert.match(result.output, /diff output/);
  });
});