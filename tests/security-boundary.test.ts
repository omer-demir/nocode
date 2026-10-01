import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runAgentSession } from "../src/agent/session.js";
import type {
  AgentMessage,
  ModelProvider,
  ModelResponse,
} from "../src/protocol/agent-protocol.js";
import type { RuntimeEvent } from "../src/runtime/runtime-events.js";
import type {
  CommandResult,
  ExecuteCommand,
  SandboxConfig,
  SandboxProvider,
  SandboxReference,
} from "../src/sandbox/sandbox-provider.js";
import type {
  PolicyDecision,
  PolicyEngine,
} from "../src/governance/policy-engine.js";
import { FixedApprovalHandler } from "../src/governance/policy-engine.js";

class EscapeAttemptModel implements ModelProvider {
  calls = 0;

  async complete(_messages: readonly AgentMessage[]): Promise<ModelResponse> {
    this.calls += 1;
    return {
      toolRequest: {
        id: "escape-attempt",
        name: "security.escape_attempt",
        arguments: {},
      },
    };
  }
}

class DenyEscapeAttemptPolicy implements PolicyEngine {
  async evaluate(): Promise<PolicyDecision> {
    return {
      outcome: "DENY",
      rule: "agent-policy:sandbox-escape-simulator",
      reason: "Host-boundary access is prohibited",
    };
  }
}

class RecordingSandbox implements SandboxProvider {
  readonly placement = "local" as const;
  readonly commands: ExecuteCommand[] = [];
  readonly terminated: string[] = [];

  async create(_config: SandboxConfig): Promise<SandboxReference> {
    return { id: "escape-sandbox", provider: "local-docker" };
  }

  async execute(input: ExecuteCommand): Promise<CommandResult> {
    this.commands.push(input);
    throw new Error("Escape attempts must never reach sandbox execution");
  }

  async terminate(sandboxId: string): Promise<void> {
    this.terminated.push(sandboxId);
  }
}

describe("security boundary enforcement", () => {
  it("fails the session and terminates the sandbox on an escape attempt", async () => {
    const model = new EscapeAttemptModel();
    const sandbox = new RecordingSandbox();
    const events: RuntimeEvent[] = [];

    await assert.rejects(
      runAgentSession({
        task: "Run the authorized sandbox escape simulation",
        workspacePath: ".",
        modelProvider: model,
        sandboxProvider: sandbox,
        policyEngine: new DenyEscapeAttemptPolicy(),
        approvalHandler: new FixedApprovalHandler(false),
        sessionId: "escape-session",
        agent: {
          id: "sandbox-escape-simulator",
          runtime: "node",
          identity: { subject: "agent://nocode/sandbox-escape-simulator" },
          version: "0.1.0",
          role: "security-test-agent",
          harness: { id: "sandbox-escape-attempt", version: 1 },
        },
        onEvent: (event) => events.push(event),
      }),
      /Execution halted after prohibited security\.escape_attempt request/,
    );

    assert.equal(model.calls, 1);
    assert.equal(sandbox.commands.length, 0);
    assert.deepEqual(sandbox.terminated, ["escape-sandbox"]);
    assert.equal(
      events.filter((event) => event.type === "security.detected").length,
      3,
    );
    assert.ok(events.some((event) => event.type === "session.failed"));
    assert.equal(events.at(-1)?.type, "sandbox.terminated");
  });
});