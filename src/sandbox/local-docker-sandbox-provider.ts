import { realpath, stat } from "node:fs/promises";
import { SpanStatusCode, trace, type Tracer } from "@opentelemetry/api";
import {
  SpawnProcessRunner,
  type ProcessRunner,
} from "./process-runner.js";
import type {
  CommandResult,
  ExecuteCommand,
  SandboxConfig,
  SandboxProvider,
  SandboxReference,
} from "./sandbox-provider.js";

const DEFAULT_IMAGE = "node:22-alpine";
const CONTROL_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1_048_576;

export interface LocalDockerSandboxProviderOptions {
  runner?: ProcessRunner;
  tracer?: Tracer;
}

export class LocalDockerSandboxProvider implements SandboxProvider {
  readonly placement = "local" as const;
  private readonly runner: ProcessRunner;
  private readonly tracer: Tracer;

  constructor(options: LocalDockerSandboxProviderOptions = {}) {
    this.runner = options.runner ?? new SpawnProcessRunner();
    this.tracer = options.tracer ?? trace.getTracer("nocode.sandbox");
  }

  async create(config: SandboxConfig): Promise<SandboxReference> {
    return this.tracer.startActiveSpan("sandbox.create", async (span) => {
      span.setAttribute("sandbox.provider", "local-docker");
      let containerId: string | undefined;

      try {
        if (config.isolation && config.isolation !== "container") {
          throw new Error(
            `Local Docker cannot enforce ${config.isolation} isolation`,
          );
        }
        if (config.poolProfile) {
          throw new Error("Local Docker does not support Azure pool profiles");
        }
        const workspacePath = await realpath(config.workspacePath);
        const workspaceStat = await stat(workspacePath);
        if (!workspaceStat.isDirectory()) {
          throw new Error("Sandbox workspace must be a directory");
        }

        const createArgs = [
          "create",
          "--label",
          "nocode.sandbox=true",
          "--network",
          config.networkMode ?? "none",
          "--read-only",
          "--tmpfs",
          "/tmp:rw,nosuid,nodev,size=64m",
          "--pids-limit",
          String(config.pidsLimit ?? 128),
          "--memory",
          `${config.memoryMb ?? 512}m`,
          "--cpus",
          String(config.cpuLimit ?? 1),
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--user",
          "1000:1000",
          "--workdir",
          "/workspace",
          "--volume",
          `${workspacePath}:/workspace:${config.workspaceAccess === "read-only" ? "ro" : "rw"}`,
        ];
        for (const [name, value] of Object.entries(config.environment ?? {}).sort()) {
          if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
            throw new Error(`Invalid sandbox environment variable: ${name}`);
          }
          createArgs.push("--env", `${name}=${value}`);
        }
        createArgs.push(
          config.image ?? DEFAULT_IMAGE,
          "sleep",
          "infinity",
        );
        const createResult = await this.runDocker(createArgs);

        if (createResult.exitCode !== 0) {
          throw new Error(`Failed to create sandbox: ${createResult.stderr}`);
        }

        containerId = createResult.stdout.trim();
        const startResult = await this.runDocker(["start", containerId]);
        if (startResult.exitCode !== 0) {
          throw new Error(`Failed to start sandbox: ${startResult.stderr}`);
        }

        span.setAttribute("sandbox.id", containerId);
        span.setStatus({ code: SpanStatusCode.OK });
        return { id: containerId, provider: "local-docker" as const };
      } catch (error) {
        if (containerId) {
          await this.runDocker(["rm", "-f", containerId]);
        }
        this.recordError(span, error);
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async execute(input: ExecuteCommand): Promise<CommandResult> {
    return this.tracer.startActiveSpan("sandbox.execute", async (span) => {
      span.setAttributes({
        "sandbox.id": input.sandboxId,
        "sandbox.provider": "local-docker",
        "process.executable.name": input.command[0],
      });

      try {
        const args = ["exec"];
        if (input.stdin !== undefined) {
          args.push("-i");
        }
        args.push(input.sandboxId, ...input.command);

        const result = await this.runner.run("docker", args, {
          ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
          timeoutMs: input.timeoutMs ?? CONTROL_TIMEOUT_MS,
          maxOutputBytes: MAX_OUTPUT_BYTES,
        });
        span.setAttributes({
          "process.exit.code": result.exitCode,
          "execution.duration": result.durationMs,
          "tool.success": result.exitCode === 0,
        });
        span.setStatus({
          code:
            result.exitCode === 0 ? SpanStatusCode.OK : SpanStatusCode.ERROR,
        });
        return result;
      } catch (error) {
        this.recordError(span, error);
        throw error;
      } finally {
        span.end();
      }
    });
  }

  async terminate(sandboxId: string): Promise<void> {
    await this.tracer.startActiveSpan("sandbox.terminate", async (span) => {
      span.setAttributes({
        "sandbox.id": sandboxId,
        "sandbox.provider": "local-docker",
      });
      try {
        const result = await this.runDocker(["rm", "-f", sandboxId]);
        if (result.exitCode !== 0) {
          throw new Error(`Failed to terminate sandbox: ${result.stderr}`);
        }
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error) {
        this.recordError(span, error);
        throw error;
      } finally {
        span.end();
      }
    });
  }

  private runDocker(args: readonly string[]): ReturnType<ProcessRunner["run"]> {
    return this.runner.run("docker", args, {
      timeoutMs: CONTROL_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
  }

  private recordError(
    span: Parameters<Tracer["startSpan"]>[1] extends never ? never : import("@opentelemetry/api").Span,
    error: unknown,
  ): void {
    const exception = error instanceof Error ? error : new Error(String(error));
    span.recordException(exception);
    span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
  }
}