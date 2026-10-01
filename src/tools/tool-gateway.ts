import { posix } from "node:path";
import { SpanStatusCode, trace, type Tracer } from "@opentelemetry/api";
import type {
  ToolRequest,
  ToolResult,
} from "../protocol/agent-protocol.js";
import type { SandboxProvider } from "../sandbox/sandbox-provider.js";
import type {
  ApprovalHandler,
  PolicyEngine,
} from "../governance/policy-engine.js";

const READ_SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const target = path.resolve("/workspace", process.argv[1]);
if (target !== "/workspace" && !target.startsWith("/workspace/")) process.exit(64);
process.stdout.write(fs.readFileSync(target, "utf8"));
`;

const WRITE_SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const target = path.resolve("/workspace", process.argv[1]);
if (!target.startsWith("/workspace/")) process.exit(64);
fs.mkdirSync(path.dirname(target), { recursive: true });
const chunks = [];
process.stdin.on("data", chunk => chunks.push(chunk));
process.stdin.on("end", () => fs.writeFileSync(target, Buffer.concat(chunks)));
`;

const SEARCH_SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const query = process.argv[1];
const root = path.resolve("/workspace", process.argv[2]);
if (root !== "/workspace" && !root.startsWith("/workspace/")) process.exit(64);
const ignored = new Set([".git", "node_modules", "dist", "coverage"]);
let matches = 0;
function search(target) {
  if (matches >= 200) return;
  const stat = fs.statSync(target);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
      if (!ignored.has(entry.name)) search(path.join(target, entry.name));
    }
    return;
  }
  const content = fs.readFileSync(target, "utf8");
  content.split(/\r?\n/).forEach((line, index) => {
    if (matches < 200 && line.includes(query)) {
      console.log(path.relative("/workspace", target) + ":" + (index + 1) + ":" + line);
      matches += 1;
    }
  });
}
search(root);
`;

const ESCAPE_ATTEMPT_DETECTIONS = [
  { signal: "root-filesystem-access", boundary: "host" },
  { signal: "credential-discovery", boundary: "host" },
  { signal: "container-runtime-access", boundary: "host" },
] as const;

export interface ToolExecutor {
  invoke(request: ToolRequest): Promise<ToolResult>;
}

export interface ToolGatewayOptions {
  sandboxProvider: SandboxProvider;
  sandboxId: string;
  policyEngine: PolicyEngine;
  approvalHandler: ApprovalHandler;
  runtime?: "node" | "python";
  tracer?: Tracer;
}

export class ToolGateway implements ToolExecutor {
  private readonly tracer: Tracer;
  private commandExecutions = 0;

  constructor(private readonly options: ToolGatewayOptions) {
    this.tracer = options.tracer ?? trace.getTracer("nocode.tools");
  }

  async invoke(request: ToolRequest): Promise<ToolResult> {
    return this.tracer.startActiveSpan("tool.invoke", async (span) => {
      span.setAttribute("tool.name", request.name);
      const commandsBefore = this.commandExecutions;
      let decision: Awaited<ReturnType<PolicyEngine["evaluate"]>> | undefined;
      let approvalGranted: boolean | undefined;
      try {
        decision = await this.options.policyEngine.evaluate(request);
        let approved = decision.outcome === "ALLOW";
        if (decision.outcome === "ASK") {
          approved = await this.options.approvalHandler.request(request, decision);
          approvalGranted = approved;
        }

        if (!approved || decision.outcome === "DENY") {
          span.setStatus({ code: SpanStatusCode.ERROR, message: "Policy denied" });
          return {
            toolCallId: request.id,
            success: false,
            output: `Denied by policy rule ${decision.rule}: ${decision.reason}`,
            telemetry: this.telemetry(
              decision,
              approvalGranted,
              this.commandExecutions - commandsBefore,
              request.name,
            ),
          };
        }

        const result = await this.executeTool(request);
        span.setAttributes({
          "tool.success": result.success,
          "sandbox.id": this.options.sandboxId,
        });
        span.setStatus({
          code: result.success ? SpanStatusCode.OK : SpanStatusCode.ERROR,
        });
        return {
          ...result,
          telemetry: this.telemetry(
            decision,
            approvalGranted,
            this.commandExecutions - commandsBefore,
            request.name,
          ),
        };
      } catch (error) {
        const exception = error instanceof Error ? error : new Error(String(error));
        span.recordException(exception);
        span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
        return {
          toolCallId: request.id,
          success: false,
          output: exception.message,
          ...(decision === undefined
            ? {}
            : {
                telemetry: this.telemetry(
                  decision,
                  approvalGranted,
                  this.commandExecutions - commandsBefore,
                  request.name,
                  isRateLimitError(exception) ? "sandbox-provider" : undefined,
                ),
              }),
        };
      } finally {
        span.end();
      }
    });
  }

  private async executeTool(request: ToolRequest): Promise<ToolResult> {
    switch (request.name) {
      case "filesystem.read":
        return this.execute(request, [
          "node",
          "-e",
          READ_SCRIPT,
          this.relativePath(request.arguments.path),
        ]);
      case "filesystem.write": {
        const content = this.stringArgument(request.arguments.content, "content");
        return this.execute(
          request,
          ["node", "-e", WRITE_SCRIPT, this.relativePath(request.arguments.path)],
          content,
        );
      }
      case "filesystem.search":
        return this.execute(request, [
          "node",
          "-e",
          SEARCH_SCRIPT,
          this.stringArgument(request.arguments.query, "query"),
          this.relativePath(request.arguments.path ?? "."),
        ]);
      case "test.run":
        return this.options.runtime === "python"
          ? this.execute(request, [".venv/bin/python", "-m", "pytest"])
          : this.execute(request, ["npm", "test"]);
      case "build.run":
        return this.options.runtime === "python"
          ? this.execute(request, [".venv/bin/python", "-m", "build"])
          : this.execute(request, ["npm", "run", "build"]);
      case "package.install": {
        if (this.options.runtime === "python") {
          return this.installPythonPackages(request);
        }
        if (request.arguments.requirementsFile !== undefined) {
          throw new Error("requirementsFile is only supported by Python agents");
        }
        const packages = this.packageArguments(request.arguments.packages);
        const command: [string, ...string[]] = ["npm", "install"];
        if (request.arguments.development === true) {
          command.push("--save-dev");
        }
        command.push(...packages);
        return this.execute(request, command);
      }
      case "git.diff":
        return this.gitDiff(request);
      default:
        return {
          toolCallId: request.id,
          success: false,
          output: `Unknown tool: ${request.name}`,
        };
    }
  }

  private async installPythonPackages(request: ToolRequest): Promise<ToolResult> {
    const packages =
      request.arguments.packages === undefined
        ? []
        : this.packageArguments(request.arguments.packages);
    const requirementsFile =
      request.arguments.requirementsFile === undefined
        ? undefined
        : this.relativePath(request.arguments.requirementsFile);
    if (packages.length === 0 && requirementsFile === undefined) {
      throw new Error("Python package installation requires packages or requirementsFile");
    }
    const environment = await this.execute(request, [
      "python3",
      "-m",
      "venv",
      ".venv",
    ]);
    if (!environment.success) {
      return environment;
    }
    const command: [string, ...string[]] = [
      ".venv/bin/python",
      "-m",
      "pip",
      "install",
      "build",
      "pytest",
    ];
    if (requirementsFile !== undefined) {
      command.push("-r", requirementsFile);
    }
    command.push(...packages);
    return this.execute(request, command);
  }

  private async execute(
    request: ToolRequest,
    command: [string, ...string[]],
    stdin?: string,
  ): Promise<ToolResult> {
    this.commandExecutions += 1;
    const result = await this.options.sandboxProvider.execute({
      sandboxId: this.options.sandboxId,
      command,
      ...(stdin === undefined ? {} : { stdin }),
      timeoutMs:
        request.name === "test.run" ||
        request.name === "build.run" ||
        request.name === "package.install"
          ? 120_000
          : 30_000,
    });
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    return {
      toolCallId: request.id,
      success: result.exitCode === 0,
      output: output || (result.exitCode === 0 ? "Completed" : "Command failed"),
    };
  }

  private async gitDiff(request: ToolRequest): Promise<ToolResult> {
    this.commandExecutions += 1;
    const status = await this.options.sandboxProvider.execute({
      sandboxId: this.options.sandboxId,
      command: ["git", "status", "--short"],
      timeoutMs: 30_000,
    });
    this.commandExecutions += 1;
    const diff = await this.options.sandboxProvider.execute({
      sandboxId: this.options.sandboxId,
      command: ["git", "diff", "--no-ext-diff", "--no-color", "HEAD", "--"],
      timeoutMs: 30_000,
    });
    const success = status.exitCode === 0 && diff.exitCode === 0;
    return {
      toolCallId: request.id,
      success,
      output: [
        "Git status:",
        status.stdout || status.stderr || "clean",
        "Git diff:",
        diff.stdout || diff.stderr || "no tracked changes",
      ].join("\n"),
    };
  }

  private relativePath(value: unknown): string {
    const path = this.stringArgument(value, "path");
    if (path.includes("\0") || posix.isAbsolute(path)) {
      throw new Error("Tool path must be relative to the workspace");
    }
    const normalized = posix.normalize(path);
    if (normalized === ".." || normalized.startsWith("../")) {
      throw new Error("Tool path cannot escape the workspace");
    }
    return normalized;
  }

  private stringArgument(value: unknown, name: string): string {
    if (typeof value !== "string" || value.length === 0) {
      throw new Error(`Tool argument ${name} must be a non-empty string`);
    }
    return value;
  }

  private packageArguments(value: unknown): string[] {
    if (!Array.isArray(value)) {
      throw new Error("Tool argument packages must be an array");
    }
    return value.map((item) => {
      const packageName = this.stringArgument(item, "packages[]");
      if (packageName.startsWith("-")) {
        throw new Error("Package names cannot be command options");
      }
      return packageName;
    });
  }

  private telemetry(
    decision: Awaited<ReturnType<PolicyEngine["evaluate"]>>,
    approvalGranted: boolean | undefined,
    commandCount: number,
    toolName: string,
    rateLimitSource?: "sandbox-provider",
  ): NonNullable<ToolResult["telemetry"]> {
    const escapeAttemptDenied =
      toolName === "security.escape_attempt" && decision.outcome === "DENY";
    return {
      policyOutcome: decision.outcome,
      policyRule: decision.rule,
      approvalRequired: decision.outcome === "ASK",
      ...(approvalGranted === undefined ? {} : { approvalGranted }),
      commandCount,
      ...(escapeAttemptDenied
        ? {
            securityDetections: [...ESCAPE_ATTEMPT_DETECTIONS],
            haltExecution: true,
          }
        : {}),
      ...(rateLimitSource === undefined ? {} : { rateLimitSource }),
    };
  }
}

function isRateLimitError(error: Error): boolean {
  return /(?:HTTP\s*)?429|rate.?limit|too many requests/i.test(error.message);
}