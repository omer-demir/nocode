import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  chmod,
  chown,
  lchown,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create, extract } from "tar";

const PORT = parsePositiveInteger(process.env.NOCODE_SESSION_PORT ?? "3000");
const WORKSPACE = process.env.NOCODE_WORKSPACE_PATH ?? "/workspace";
const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const COMMAND_UID = 1000;
const COMMAND_GID = 1000;

let workspaceReady = false;
let workspaceEnvironment = {};
let executing = false;

const server = createServer((request, response) => {
  void route(request, response).catch((error) => {
    const status = error instanceof HttpError ? error.status : 500;
    const message = error instanceof Error ? error.message : String(error);
    sendJson(response, status, { error: message });
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`NoCode session server listening on port ${PORT}`);
});

async function route(request, response) {
  const url = new URL(request.url ?? "/", "http://session.local");
  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { ready: workspaceReady, executing });
    return;
  }
  if (request.method === "POST" && url.pathname === "/workspace/import") {
    await importWorkspace(request);
    sendJson(response, 200, { ready: true });
    return;
  }
  if (request.method === "GET" && url.pathname === "/workspace/export") {
    requireWorkspace();
    console.log("workspace export started");
    response.writeHead(200, { "Content-Type": "application/gzip" });
    const archive = create({ cwd: WORKSPACE, gzip: true, portable: true }, ["."]);
    archive.once("error", (error) => response.destroy(error));
    archive.pipe(response);
    return;
  }
  if (request.method === "POST" && url.pathname === "/execute") {
    requireWorkspace();
    if (executing) {
      throw new HttpError(409, "A command is already running");
    }
    const body = JSON.parse((await readBody(request, MAX_JSON_BYTES)).toString("utf8"));
    const command = validateCommand(body.command);
    const timeoutMs = validateTimeout(body.timeoutMs);
    const stdin = body.stdin === undefined ? undefined : String(body.stdin);
    executing = true;
    try {
      console.log("command execution started");
      const result = await runCommand(command, stdin, timeoutMs);
      console.log(
        `command execution completed exitCode=${result.exitCode} durationMs=${Math.round(result.durationMs)} truncated=${result.truncated}`,
      );
      sendJson(
        response,
        200,
        result,
      );
    } finally {
      executing = false;
    }
    return;
  }
  throw new HttpError(404, "Route not found");
}

async function importWorkspace(request) {
  if (executing) {
    throw new HttpError(409, "A command is already running");
  }
  const access = request.headers["x-nocode-workspace-access"] ?? "read-write";
  if (access !== "read-only" && access !== "read-write") {
    throw new HttpError(400, "Invalid workspace access mode");
  }
  workspaceEnvironment = validateEnvironment(
    JSON.parse(request.headers["x-nocode-environment"] ?? "{}"),
  );
  const archive = await readBody(request, MAX_ARCHIVE_BYTES);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "nocode-import-"));
  const archivePath = join(temporaryDirectory, `${randomUUID()}.tar.gz`);
  try {
    await writeFile(archivePath, archive);
    await rm(WORKSPACE, { recursive: true, force: true });
    await mkdir(WORKSPACE, { recursive: true });
    await extract({
      cwd: WORKSPACE,
      file: archivePath,
      gzip: true,
      preservePaths: false,
      strict: true,
    });
    await applyWorkspaceAccess(WORKSPACE, access);
    workspaceReady = true;
    console.log(`workspace import completed access=${access} bytes=${archive.length}`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function applyWorkspaceAccess(path, access) {
  const entry = await lstat(path);
  if (entry.isSymbolicLink()) {
    await lchown(path, access === "read-write" ? COMMAND_UID : 0, access === "read-write" ? COMMAND_GID : 0);
    return;
  }
  await chown(path, access === "read-write" ? COMMAND_UID : 0, access === "read-write" ? COMMAND_GID : 0);
  if (entry.isDirectory()) {
    await chmod(path, access === "read-write" ? 0o755 : 0o555);
    const children = await readdir(path);
    for (const child of children) {
      await applyWorkspaceAccess(join(path, child), access);
    }
    return;
  }
  const executable = (entry.mode & 0o111) !== 0;
  await chmod(
    path,
    access === "read-write" ? (entry.mode & 0o777) | 0o200 : executable ? 0o555 : 0o444,
  );
}

async function runCommand(command, stdin, timeoutMs) {
  const startedAt = performance.now();
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: WORKSPACE,
      env: { ...process.env, ...workspaceEnvironment },
      gid: COMMAND_GID,
      uid: COMMAND_UID,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let truncated = false;
    let timedOut = false;
    let spawnError;

    const capture = (target, chunk) => {
      const remaining = MAX_OUTPUT_BYTES - outputBytes;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      const captured = chunk.subarray(0, remaining);
      target.push(captured);
      outputBytes += captured.length;
      truncated ||= captured.length < chunk.length;
    };

    child.stdout.on("data", (chunk) => capture(stdout, chunk));
    child.stderr.on("data", (chunk) => capture(stderr, chunk));
    child.once("error", (error) => {
      spawnError = error;
    });
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.once("close", (code) => {
      clearTimeout(timeout);
      const errorText = spawnError ? `${spawnError.message}\n` : "";
      const timeoutText = timedOut
        ? `Command exceeded ${timeoutMs}ms timeout\n`
        : "";
      resolve({
        exitCode: timedOut ? 124 : spawnError ? 127 : (code ?? 1),
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: `${Buffer.concat(stderr).toString("utf8")}${errorText}${timeoutText}`,
        durationMs: performance.now() - startedAt,
        truncated,
      });
    });
    child.stdin.end(stdin);
  });
}

async function readBody(request, maximumBytes) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) {
      throw new HttpError(413, `Request exceeds ${maximumBytes} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function validateCommand(value) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 128 ||
    value.some(
      (part) =>
        typeof part !== "string" ||
        part.length === 0 ||
        part.length > 32_768 ||
        part.includes("\0"),
    )
  ) {
    throw new HttpError(400, "Invalid command");
  }
  return value;
}

function validateEnvironment(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "Invalid environment");
  }
  return Object.fromEntries(
    Object.entries(value).map(([name, entry]) => {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name) || typeof entry !== "string") {
        throw new HttpError(400, `Invalid environment variable: ${name}`);
      }
      return [name, entry];
    }),
  );
}

function validateTimeout(value) {
  if (!Number.isInteger(value) || value < 1 || value > 3_600_000) {
    throw new HttpError(400, "Invalid command timeout");
  }
  return value;
}

function requireWorkspace() {
  if (!workspaceReady) {
    throw new HttpError(409, "Workspace has not been imported");
  }
}

function parsePositiveInteger(value) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`Invalid session server port: ${value}`);
  }
  return parsed;
}

function sendJson(response, status, body) {
  if (response.headersSent) return;
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}