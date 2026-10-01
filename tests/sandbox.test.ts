import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { LocalDockerSandboxProvider } from "../src/sandbox/local-docker-sandbox-provider.js";
import type {
  ProcessRunner,
  ProcessRunOptions,
  ProcessRunResult,
} from "../src/sandbox/process-runner.js";

class RecordingRunner implements ProcessRunner {
  readonly calls: Array<{ executable: string; args: readonly string[] }> = [];
  private callCount = 0;

  async run(
    executable: string,
    args: readonly string[],
    _options: ProcessRunOptions,
  ): Promise<ProcessRunResult> {
    this.calls.push({ executable, args });
    this.callCount += 1;
    return {
      exitCode: 0,
      stdout: this.callCount === 1 ? "container-123\n" : "",
      stderr: "",
      durationMs: 1,
      truncated: false,
    };
  }
}

describe("LocalDockerSandboxProvider", () => {
  it("creates a constrained, non-root sandbox", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nocode-unit-"));
    const runner = new RecordingRunner();
    const provider = new LocalDockerSandboxProvider({ runner });

    try {
      const sandbox = await provider.create({ workspacePath: workspace });
      assert.equal(sandbox.id, "container-123");
      assert.deepEqual(runner.calls[0]?.args.slice(0, 3), [
        "create",
        "--label",
        "nocode.sandbox=true",
      ]);
      assert.ok(runner.calls[0]?.args.includes("none"));
      assert.ok(runner.calls[0]?.args.includes("--read-only"));
      assert.ok(runner.calls[0]?.args.includes("no-new-privileges"));
      assert.ok(runner.calls[0]?.args.includes("1000:1000"));
      assert.deepEqual(runner.calls[1]?.args, ["start", "container-123"]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("applies declared network and workspace access", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nocode-profile-"));
    const runner = new RecordingRunner();
    const provider = new LocalDockerSandboxProvider({ runner });

    try {
      await provider.create({
        workspacePath: workspace,
        networkMode: "bridge",
        workspaceAccess: "read-only",
        environment: { HTTPS_PROXY: "http://proxy.example:8080" },
      });
      const args = runner.calls[0]?.args ?? [];
      assert.equal(args[args.indexOf("--network") + 1], "bridge");
      assert.equal(
        args[args.indexOf("--volume") + 1],
        `${await realpath(workspace)}:/workspace:ro`,
      );
      assert.ok(args.includes("HTTPS_PROXY=http://proxy.example:8080"));
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it(
    "executes inside a real Docker container",
    { skip: process.env.RUN_DOCKER_TESTS !== "1", timeout: 90_000 },
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), "nocode-integration-"));
      const provider = new LocalDockerSandboxProvider();
      const sandbox = await provider.create({
        workspacePath: workspace,
        image: "nocode/coding-sandbox:0.2.0",
      });

      try {
        const result = await provider.execute({
          sandboxId: sandbox.id,
          command: ["node", "-e", "console.log('sandbox-ok')"],
        });
        assert.equal(result.exitCode, 0);
        assert.equal(result.stdout.trim(), "sandbox-ok");
        const environment = await provider.execute({
          sandboxId: sandbox.id,
          command: ["python3", "-m", "venv", ".venv"],
        });
        const pip = await provider.execute({
          sandboxId: sandbox.id,
          command: [".venv/bin/python", "-m", "pip", "--version"],
        });
        assert.equal(environment.exitCode, 0, environment.stderr);
        assert.equal(pip.exitCode, 0, pip.stderr);
        assert.match(pip.stdout, /pip/);
      } finally {
        await provider.terminate(sandbox.id);
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  it(
    "allows internet and workspace writes for the coding profile",
    { skip: process.env.RUN_DOCKER_TESTS !== "1", timeout: 90_000 },
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), "nocode-online-"));
      const endpoint = await startHostEndpoint();
      const provider = new LocalDockerSandboxProvider();
      const sandbox = await provider.create({
        workspacePath: workspace,
        image: "nocode/coding-sandbox:0.2.0",
        networkMode: "bridge",
        workspaceAccess: "read-write",
      });

      try {
        const result = await provider.execute({
          sandboxId: sandbox.id,
          command: [
            "node",
            "-e",
            `require('node:fs').writeFileSync('proof.txt', 'ok'); fetch('http://host.docker.internal:${endpoint.port}').then(r => { if (!r.ok) process.exit(1); console.log('online'); })`,
          ],
          timeoutMs: 15_000,
        });
        assert.equal(result.exitCode, 0, result.stderr);
        assert.match(result.stdout, /online/);
      } finally {
        await provider.terminate(sandbox.id);
        await endpoint.close();
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );

  it(
    "blocks network and writes for the offline review profile",
    { skip: process.env.RUN_DOCKER_TESTS !== "1", timeout: 90_000 },
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), "nocode-offline-"));
      const endpoint = await startHostEndpoint();
      const provider = new LocalDockerSandboxProvider();
      const sandbox = await provider.create({
        workspacePath: workspace,
        image: "nocode/coding-sandbox:0.2.0",
        networkMode: "none",
        workspaceAccess: "read-only",
      });

      try {
        const git = await provider.execute({
          sandboxId: sandbox.id,
          command: ["git", "--version"],
        });
        const write = await provider.execute({
          sandboxId: sandbox.id,
          command: [
            "node",
            "-e",
            "require('node:fs').writeFileSync('forbidden.txt', 'no')",
          ],
        });
        const network = await provider.execute({
          sandboxId: sandbox.id,
          command: [
            "node",
            "-e",
            `fetch('http://host.docker.internal:${endpoint.port}', { signal: AbortSignal.timeout(3000) }).then(() => process.exit(1)).catch(() => console.log('blocked'))`,
          ],
          timeoutMs: 10_000,
        });
        assert.equal(git.exitCode, 0, git.stderr);
        assert.notEqual(write.exitCode, 0);
        assert.equal(network.exitCode, 0, network.stderr);
        assert.match(network.stdout, /blocked/);
      } finally {
        await provider.terminate(sandbox.id);
        await endpoint.close();
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});

async function startHostEndpoint(): Promise<{
  port: number;
  close: () => Promise<void>;
}> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("ok");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "0.0.0.0", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

after(() => {
  assert.ok(true);
});