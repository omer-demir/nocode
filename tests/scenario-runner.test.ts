import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { FileCatalog, loadScenario } from "../src/catalog/file-catalog.js";
import { sandboxConfigForAgent } from "../src/scenarios/scenario-runner.js";
import { RepositoryWorkspaceManager } from "../src/scenarios/workspace-manager.js";

describe("scenario sandbox profiles", () => {
  it("gives implementation agents internet and write access", async () => {
    const catalog = await FileCatalog.load(resolve("samples/catalog"));
    assert.deepEqual(sandboxConfigForAgent(catalog.get("vue-migration-coder")), {
      isolation: "container",
      image: "nocode/coding-sandbox:0.2.0",
      cpuLimit: 1,
      memoryMb: 512,
      pidsLimit: 128,
      networkMode: "bridge",
      workspaceAccess: "read-write",
    });
  });

  it("enforces offline read-only review", async () => {
    const catalog = await FileCatalog.load(resolve("samples/catalog"));
    assert.deepEqual(sandboxConfigForAgent(catalog.get("offline-code-reviewer")), {
      isolation: "container",
      image: "nocode/coding-sandbox:0.2.0",
      cpuLimit: 1,
      memoryMb: 512,
      pidsLimit: 128,
      networkMode: "none",
      workspaceAccess: "read-only",
    });
  });

  it("selects the declared remote Hyper-V pool contract", async () => {
    const catalog = await FileCatalog.load(resolve("samples/catalog"));
    assert.deepEqual(
      sandboxConfigForAgent(catalog.get("vue-migration-coder"), "remote"),
      {
        isolation: "hyper-v",
        poolProfile: "node-hyperv-1cpu-2gi-egress",
        cpuLimit: 1,
        memoryMb: 2048,
        networkMode: "bridge",
        workspaceAccess: "read-write",
      },
    );
  });

  it("reuses testcase 1 output for testcase 3", async () => {
    const root = await mkdtemp(join(tmpdir(), "nocode-scenarios-"));
    const scenario = await loadScenario(
      resolve("samples/last-hour-vue-migration/scenario.json"),
    );
    const manager = new RepositoryWorkspaceManager(root);
    const codingWorkspace = manager.workspacePath(scenario.id, "testcase-1");
    await mkdir(codingWorkspace, { recursive: true });
    const reviewCase = scenario.testCases.find(
      (testCase) => testCase.id === "testcase-3",
    );

    try {
      assert.ok(reviewCase);
      assert.equal(
        await manager.prepare(scenario, reviewCase),
        codingWorkspace,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});