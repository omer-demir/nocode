import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { AzureContainerAppsSessionPoolProvider } from "../src/sandbox/azure-container-apps-session-pool-provider.js";
import { packWorkspace } from "../src/sandbox/workspace-archive.js";

describe("AzureContainerAppsSessionPoolProvider", () => {
  it("uploads, executes, restores, and stops a remote session", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "nocode-aca-local-"));
    const remoteWorkspace = await mkdtemp(join(tmpdir(), "nocode-aca-remote-"));
    await writeFile(join(workspace, "before.txt"), "before");
    await writeFile(join(remoteWorkspace, "after.txt"), "after");
    const exportedArchive = await packWorkspace(remoteWorkspace);
    const requests: Array<{ url: URL; init: RequestInit }> = [];
    const fetchMock = (async (
      input: string | URL | Request,
      init: RequestInit = {},
    ): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requests.push({ url, init });
      if (url.pathname === "/execute") {
        return Response.json({
          exitCode: 0,
          stdout: "remote-ok\n",
          stderr: "",
          durationMs: 12,
          truncated: false,
        });
      }
      if (url.pathname === "/workspace/export") {
        return new Response(Uint8Array.from(exportedArchive));
      }
      return new Response("ok", { status: 200 });
    }) as typeof fetch;
    const provider = new AzureContainerAppsSessionPoolProvider({
      endpoint: "https://pool.example.azurecontainerapps.io",
      networkMode: "bridge",
      tokenProvider: async () => "test-token",
      fetch: fetchMock,
    });

    try {
      const sandbox = await provider.create({
        workspacePath: workspace,
        networkMode: "bridge",
        workspaceAccess: "read-write",
      });
      const result = await provider.execute({
        sandboxId: sandbox.id,
        command: ["node", "--version"],
      });
      await provider.terminate(sandbox.id);

      assert.equal(provider.placement, "remote");
      assert.equal(sandbox.provider, "azure-container-apps-session-pool");
      assert.equal(result.stdout, "remote-ok\n");
      assert.equal(await readFile(join(workspace, "after.txt"), "utf8"), "after");
      assert.deepEqual(
        requests.map(({ url }) => url.pathname),
        [
          "/workspace/import",
          "/execute",
          "/workspace/export",
          "/.management/stopSession",
        ],
      );
      const identifiers = new Set(
        requests.map(({ url }) => url.searchParams.get("identifier")),
      );
      assert.equal(identifiers.size, 1);
      assert.equal(
        new Headers(requests[0]?.init.headers).get("Authorization"),
        "Bearer test-token",
      );
      assert.equal(
        requests.at(-1)?.url.searchParams.get("api-version"),
        "2025-02-02-preview",
      );
    } finally {
      await rm(workspace, { recursive: true, force: true });
      await rm(remoteWorkspace, { recursive: true, force: true });
    }
  });

  it("rejects a network profile that the pool cannot enforce", async () => {
    let requestCount = 0;
    const provider = new AzureContainerAppsSessionPoolProvider({
      endpoint: "https://pool.example.azurecontainerapps.io",
      networkMode: "none",
      tokenProvider: async () => "test-token",
      fetch: (async () => {
        requestCount += 1;
        return new Response("ok");
      }) as typeof fetch,
    });

    await assert.rejects(
      provider.create({ workspacePath: ".", networkMode: "bridge" }),
      /pool network mode is none, but the agent requires bridge/,
    );
    assert.equal(requestCount, 0);
  });

  it("rejects an incompatible Hyper-V pool contract before allocation", async () => {
    let requestCount = 0;
    const provider = new AzureContainerAppsSessionPoolProvider({
      endpoint: "https://pool.example.azurecontainerapps.io",
      networkMode: "bridge",
      poolProfile: "node-hyperv-1cpu-2gi-egress",
      cpuLimit: 1,
      memoryMb: 2048,
      tokenProvider: async () => "test-token",
      fetch: (async () => {
        requestCount += 1;
        return new Response("ok");
      }) as typeof fetch,
    });

    await assert.rejects(
      provider.create({
        workspacePath: ".",
        isolation: "hyper-v",
        poolProfile: "node-hyperv-2cpu-4gi-no-egress",
        cpuLimit: 2,
        memoryMb: 4096,
        networkMode: "none",
      }),
      /pool profile does not satisfy/,
    );
    assert.equal(requestCount, 0);
  });
});