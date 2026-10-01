import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { DefaultAzureCredential } from "@azure/identity";
import { SpanStatusCode, trace, type Span, type Tracer } from "@opentelemetry/api";
import { z } from "zod";
import type {
  CommandResult,
  ExecuteCommand,
  SandboxConfig,
  SandboxProvider,
  SandboxReference,
} from "./sandbox-provider.js";
import { packWorkspace, replaceWorkspace } from "./workspace-archive.js";

const DYNAMIC_SESSIONS_SCOPE = "https://dynamicsessions.io/.default";
const MANAGEMENT_API_VERSION = "2025-02-02-preview";
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const TRANSFER_TIMEOUT_MS = 120_000;
const EXECUTION_TIMEOUT_OVERHEAD_MS = 10_000;

const commandResultSchema = z.object({
  exitCode: z.number().int(),
  stdout: z.string(),
  stderr: z.string(),
  durationMs: z.number().nonnegative(),
  truncated: z.boolean(),
});

interface ActiveSession {
  workspacePath: string;
  workspaceAccess: "read-only" | "read-write";
}

export interface AzureContainerAppsSessionPoolProviderOptions {
  endpoint: string;
  networkMode: "none" | "bridge";
  poolProfile?: string;
  cpuLimit?: number;
  memoryMb?: number;
  tokenProvider?: () => Promise<string>;
  fetch?: typeof fetch;
  tracer?: Tracer;
}

export class AzureContainerAppsSessionPoolProvider implements SandboxProvider {
  readonly placement = "remote" as const;
  private readonly endpoint: URL;
  private readonly fetch: typeof fetch;
  private readonly tokenProvider: () => Promise<string>;
  private readonly tracer: Tracer;
  private readonly sessions = new Map<string, ActiveSession>();

  constructor(private readonly options: AzureContainerAppsSessionPoolProviderOptions) {
    this.endpoint = normalizeEndpoint(options.endpoint);
    this.fetch = options.fetch ?? globalThis.fetch;
    this.tracer = options.tracer ?? trace.getTracer("nocode.sandbox");
    if (options.tokenProvider) {
      this.tokenProvider = options.tokenProvider;
    } else {
      const credential = new DefaultAzureCredential();
      this.tokenProvider = async () => {
        const token = await credential.getToken(DYNAMIC_SESSIONS_SCOPE);
        if (!token) {
          throw new Error("Unable to acquire an Azure Container Apps session token");
        }
        return token.token;
      };
    }
  }

  async create(config: SandboxConfig): Promise<SandboxReference> {
    return this.tracer.startActiveSpan("sandbox.create", async (span) => {
      const identifier = randomUUID();
      let allocationAttempted = false;
      span.setAttributes({
        "sandbox.id": identifier,
        "sandbox.provider": "azure-container-apps-session-pool",
      });
      try {
        const requestedNetworkMode = config.networkMode ?? "none";
        if (config.isolation && config.isolation !== "hyper-v") {
          throw new Error(
            `Azure Container Apps sessions cannot enforce ${config.isolation} isolation`,
          );
        }
        if (
          config.poolProfile &&
          config.poolProfile !==
            (this.options.poolProfile ?? "node-hyperv-1cpu-2gi-egress")
        ) {
          throw new Error(
            `Session pool profile does not satisfy ${config.poolProfile}`,
          );
        }
        if (requestedNetworkMode !== this.options.networkMode) {
          throw new Error(
            `Session pool network mode is ${this.options.networkMode}, but the agent requires ${requestedNetworkMode}`,
          );
        }
        if (
          config.cpuLimit !== undefined &&
          config.cpuLimit !== (this.options.cpuLimit ?? 1)
        ) {
          throw new Error(`Session pool cannot enforce ${config.cpuLimit} CPU`);
        }
        if (
          config.memoryMb !== undefined &&
          config.memoryMb !== (this.options.memoryMb ?? 2048)
        ) {
          throw new Error(
            `Session pool cannot enforce ${config.memoryMb} MiB memory`,
          );
        }
        if (config.pidsLimit !== undefined) {
          throw new Error(
            "Azure Container Apps sessions do not expose a per-session PID limit",
          );
        }
        const workspacePath = await realpath(config.workspacePath);
        const workspaceStat = await stat(workspacePath);
        if (!workspaceStat.isDirectory()) {
          throw new Error("Sandbox workspace must be a directory");
        }
        const archive = await packWorkspace(workspacePath);
        if (archive.byteLength > MAX_ARCHIVE_BYTES) {
          throw new Error(
            `Workspace archive exceeds ${MAX_ARCHIVE_BYTES} bytes`,
          );
        }
        allocationAttempted = true;
        const response = await this.request(
          "/workspace/import",
          identifier,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/gzip",
              "X-NoCode-Workspace-Access":
                config.workspaceAccess ?? "read-write",
              "X-NoCode-Environment": JSON.stringify(config.environment ?? {}),
            },
            body: Uint8Array.from(archive),
          },
          TRANSFER_TIMEOUT_MS,
        );
        await requireSuccess(response, "Workspace import failed");
        this.sessions.set(identifier, {
          workspacePath,
          workspaceAccess: config.workspaceAccess ?? "read-write",
        });
        span.setStatus({ code: SpanStatusCode.OK });
        return {
          id: identifier,
          provider: "azure-container-apps-session-pool" as const,
        };
      } catch (error) {
        if (allocationAttempted) {
          await this.stopBestEffort(identifier);
        }
        recordError(span, error);
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
        "sandbox.provider": "azure-container-apps-session-pool",
        "process.executable.name": input.command[0],
      });
      try {
        this.requireSession(input.sandboxId);
        const timeoutMs = input.timeoutMs ?? 30_000;
        const response = await this.request(
          "/execute",
          input.sandboxId,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              command: input.command,
              ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
              timeoutMs,
            }),
          },
          timeoutMs + EXECUTION_TIMEOUT_OVERHEAD_MS,
        );
        await requireSuccess(response, "Remote command failed");
        const result = commandResultSchema.parse(await response.json());
        span.setAttributes({
          "process.exit.code": result.exitCode,
          "execution.duration": result.durationMs,
          "tool.success": result.exitCode === 0,
        });
        span.setStatus({
          code: result.exitCode === 0 ? SpanStatusCode.OK : SpanStatusCode.ERROR,
        });
        return result;
      } catch (error) {
        recordError(span, error);
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
        "sandbox.provider": "azure-container-apps-session-pool",
      });
      const session = this.requireSession(sandboxId);
      const errors: unknown[] = [];
      try {
        if (session.workspaceAccess === "read-write") {
          try {
            const response = await this.request(
              "/workspace/export",
              sandboxId,
              { method: "GET" },
              TRANSFER_TIMEOUT_MS,
            );
            await requireSuccess(response, "Workspace export failed");
            const archive = Buffer.from(await response.arrayBuffer());
            if (archive.byteLength > MAX_ARCHIVE_BYTES) {
              throw new Error(
                `Workspace archive exceeds ${MAX_ARCHIVE_BYTES} bytes`,
              );
            }
            await replaceWorkspace(session.workspacePath, archive);
          } catch (error) {
            errors.push(error);
          }
        }
        try {
          const response = await this.request(
            "/.management/stopSession",
            sandboxId,
            { method: "POST" },
            30_000,
            MANAGEMENT_API_VERSION,
          );
          await requireSuccess(response, "Session stop failed");
        } catch (error) {
          errors.push(error);
        }
        if (errors.length > 0) {
          throw new AggregateError(errors, `Failed to terminate session ${sandboxId}`);
        }
        span.setStatus({ code: SpanStatusCode.OK });
      } catch (error) {
        recordError(span, error);
        throw error;
      } finally {
        this.sessions.delete(sandboxId);
        span.end();
      }
    });
  }

  private requireSession(sandboxId: string): ActiveSession {
    const session = this.sessions.get(sandboxId);
    if (!session) {
      throw new Error(`Unknown Azure Container Apps session: ${sandboxId}`);
    }
    return session;
  }

  private async request(
    path: string,
    identifier: string,
    init: RequestInit,
    timeoutMs: number,
    apiVersion?: string,
  ): Promise<Response> {
    const url = new URL(path.replace(/^\//, ""), this.endpoint);
    url.searchParams.set("identifier", identifier);
    if (apiVersion) {
      url.searchParams.set("api-version", apiVersion);
    }
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await this.tokenProvider()}`);
    return this.fetch(url, {
      ...init,
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  private async stopBestEffort(identifier: string): Promise<void> {
    try {
      const response = await this.request(
        "/.management/stopSession",
        identifier,
        { method: "POST" },
        30_000,
        MANAGEMENT_API_VERSION,
      );
      await response.body?.cancel();
    } catch {
      // Preserve the original creation error.
    }
  }
}

function normalizeEndpoint(value: string): URL {
  const endpoint = new URL(value.endsWith("/") ? value : `${value}/`);
  if (endpoint.protocol !== "https:") {
    throw new Error("Azure Container Apps session pool endpoint must use HTTPS");
  }
  return endpoint;
}

async function requireSuccess(
  response: Response,
  message: string,
): Promise<void> {
  if (response.ok) return;
  const detail = (await response.text()).slice(0, 4_096);
  throw new Error(`${message}: HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
}

function recordError(span: Span, error: unknown): void {
  const exception = error instanceof Error ? error : new Error(String(error));
  span.recordException(exception);
  span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
}