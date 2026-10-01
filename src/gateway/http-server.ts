import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { ExecutionApi } from "./execution-service.js";
import { handleMcpRequest } from "./mcp-server.js";

const MAX_BODY_BYTES = 1_048_576;
const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

export interface GatewayServerOptions {
  executions: ExecutionApi;
  token?: string;
}

export function createGatewayServer(options: GatewayServerOptions): Server {
  return createServer((request, response) => {
    void routeRequest(request, response, options).catch((error: unknown) => {
      if (response.headersSent) {
        response.end();
        return;
      }
      const message = error instanceof Error ? error.message : "Unexpected error";
      const status = statusForError(message);
      writeJson(response, status, { error: status === 500 ? "Internal server error" : message });
    });
  });
}

export function validateGatewayBinding(host: string, token: string | undefined): void {
  if (!isLoopback(host) && !token) {
    throw new Error(
      "NOCODE_GATEWAY_TOKEN is required when the gateway binds beyond loopback",
    );
  }
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: GatewayServerOptions,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method === "GET" && url.pathname === "/health") {
    writeJson(response, 200, { status: "ok" });
    return;
  }

  requireAuthorization(request, options.token);

  if (url.pathname === "/mcp") {
    if (request.method !== "POST") {
      writeJson(response, 405, mcpMethodNotAllowed());
      return;
    }
    await handleMcpRequest(
      request,
      response,
      await readJsonBody(request),
      options.executions,
    );
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/agents") {
    writeJson(response, 200, { agents: options.executions.listAgents() });
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/workflows") {
    writeJson(response, 200, { workflows: options.executions.listWorkflows() });
    return;
  }
  if (url.pathname === "/api/executions") {
    if (request.method === "GET") {
      writeJson(response, 200, { executions: options.executions.listSessions() });
      return;
    }
    if (request.method === "POST") {
      const body = requireObject(await readJsonBody(request));
      const execution = options.executions.launch({
        agentId: requireString(body.agentId, "agentId"),
        repositoryUrl: requireString(body.repositoryUrl, "repositoryUrl"),
        task: requireString(body.task, "task"),
        placement: requirePlacement(body.placement),
      });
      writeJson(response, 202, execution);
      return;
    }
  }
  const workflowMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)$/);
  if (request.method === "POST" && workflowMatch) {
    const body = requireObject(await readJsonBody(request));
    if (body.fresh !== undefined && typeof body.fresh !== "boolean") {
      throw new Error("fresh must be a boolean");
    }
    writeJson(
      response,
      202,
      options.executions.launchWorkflow({
        workflowId: decodeURIComponent(workflowMatch[1] ?? ""),
        repositoryUrl: requireString(body.repositoryUrl, "repositoryUrl"),
        fresh: body.fresh ?? false,
        placement: requirePlacement(body.placement),
      }),
    );
    return;
  }

  const match = url.pathname.match(
    /^\/api\/executions\/([^/]+)(?:\/(events|approval|cancel))?$/,
  );
  if (match) {
    const reference = decodeURIComponent(match[1] ?? "");
    const action = match[2];
    if (request.method === "GET" && action === undefined) {
      writeJson(response, 200, options.executions.getSession(reference));
      return;
    }
    if (request.method === "GET" && action === "events") {
      streamExecution(response, request, options.executions, reference);
      return;
    }
    if (request.method === "POST" && action === "approval") {
      const body = requireObject(await readJsonBody(request));
      if (typeof body.approved !== "boolean") {
        throw new Error("approved must be a boolean");
      }
      if (body.remember !== undefined && typeof body.remember !== "boolean") {
        throw new Error("remember must be a boolean");
      }
      writeJson(
        response,
        200,
        options.executions.resolveApproval(
          reference,
          body.approved,
          body.remember ?? false,
        ),
      );
      return;
    }
    if (request.method === "POST" && action === "cancel") {
      writeJson(response, 200, options.executions.cancel(reference));
      return;
    }
  }

  writeJson(response, 404, { error: "Route not found" });
}

function streamExecution(
  response: ServerResponse,
  request: IncomingMessage,
  executions: ExecutionApi,
  reference: string,
): void {
  executions.getSession(reference);
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const lastEventId = Number(request.headers["last-event-id"] ?? -1);
  let nextEvent = Number.isSafeInteger(lastEventId) ? lastEventId + 1 : 0;
  let closed = false;
  let unsubscribe = (): void => {};
  const flush = (): void => {
    if (closed) return;
    const session = executions.getSession(reference);
    while (nextEvent < session.events.length) {
      writeSse(response, "runtime", session.events[nextEvent], nextEvent);
      nextEvent += 1;
    }
    writeSse(response, "execution", session);
    if (TERMINAL_STATUSES.has(session.status)) {
      closed = true;
      unsubscribe();
      response.end();
    }
  };
  unsubscribe = executions.subscribe(flush);
  request.on("close", () => {
    closed = true;
    unsubscribe();
  });
  flush();
}

function writeSse(
  response: ServerResponse,
  event: string,
  value: unknown,
  id?: number,
): void {
  if (id !== undefined) response.write(`id: ${id}\n`);
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(value)}\n\n`);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
  function requirePlacement(value: unknown): "local" | "remote" {
    if (value !== "local" && value !== "remote") {
      throw new Error("placement must be local or remote");
    }
    return value;
  }
      throw new Error("Request body exceeds 1 MiB");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

function requireAuthorization(request: IncomingMessage, token?: string): void {
  if (!token) return;
  const provided = request.headers.authorization;
  if (!provided?.startsWith("Bearer ") || !tokensEqual(provided.slice(7), token)) {
    const error = new Error("Unauthorized");
    error.name = "UnauthorizedError";
    throw error;
  }
}

function tokensEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return (
    leftBuffer.length === rightBuffer.length &&
    timingSafeEqual(leftBuffer, rightBuffer)
  );
}

function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function requirePlacement(value: unknown): "local" | "remote" {
  if (value !== "local" && value !== "remote") {
    throw new Error("placement must be local or remote");
  }
  return value;
}

function statusForError(message: string): number {
  if (message === "Unauthorized") return 401;
  if (/not found/i.test(message)) return 404;
  if (/no pending approval|not running/i.test(message)) return 409;
  return 400;
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function mcpMethodNotAllowed(): object {
  return {
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed" },
    id: null,
  };
}

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}