import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import type { AgentDescriptor } from "../src/catalog/catalog-types.js";
import { FileCatalog, loadScenario } from "../src/catalog/file-catalog.js";
import { FixedApprovalHandler } from "../src/governance/policy-engine.js";
import type {
  AgentMessage,
  ModelProvider,
  ModelResponse,
} from "../src/protocol/agent-protocol.js";
import type {
  CommandResult,
  ExecuteCommand,
  SandboxConfig,
  SandboxProvider,
  SandboxReference,
} from "../src/sandbox/sandbox-provider.js";
import { ReviewRepairWorkflow } from "../src/workflows/review-repair-workflow.js";

class RecordingSandboxProvider implements SandboxProvider {
  readonly placement = "local" as const;
  readonly created: SandboxConfig[] = [];
  readonly terminated: string[] = [];

  async create(config: SandboxConfig): Promise<SandboxReference> {
    this.created.push(config);
    return { id: `sandbox-${this.created.length}`, provider: "local-docker" };
  }

  async execute(_input: ExecuteCommand): Promise<CommandResult> {
    throw new Error("A summary-only model should not execute tools");
  }

  async terminate(sandboxId: string): Promise<void> {
    this.terminated.push(sandboxId);
  }
}

class SummaryModel implements ModelProvider {
  constructor(
    private readonly summary: string,
    private readonly captureTask: (task: string) => void,
  ) {}

  async complete(messages: readonly AgentMessage[]): Promise<ModelResponse> {
    const task = messages.find((message) => message.role === "user")?.content;
    this.captureTask(task ?? "");
    return { content: this.summary };
  }
}

describe("review-repair workflow", () => {
  it("isolates code, review, and accepted repair in separate sandboxes", async () => {
    const catalog = await FileCatalog.load(resolve("samples/catalog"));
    const scenario = await loadScenario(
      resolve("samples/last-hour-vue-migration/scenario.json"),
    );
    const provider = new RecordingSandboxProvider();
    const tasks = new Map<string, string>();
    let gatedReview = "";
    const workflow = new ReviewRepairWorkflow({
      catalog,
      workspaceManager: {
        prepare: async (_scenario, testCase) =>
          `/work/${
            testCase.workspace.source === "clone"
              ? testCase.id
              : testCase.workspace.testCaseId
          }`,
      },
      sandboxProviderFactory: () => provider,
      approvalHandler: new FixedApprovalHandler(true),
      reviewGate: async ({ reviewSummary }) => {
        gatedReview = reviewSummary;
        return true;
      },
      modelFactory: (agent: AgentDescriptor) =>
        new SummaryModel(`${agent.id} summary`, (task) => tasks.set(agent.id, task)),
    });

    const result = await workflow.run({
      scenario,
      coderCaseId: "testcase-1",
      reviewerCaseId: "testcase-3",
      repairAgentId: "vue-migration-repairer",
      fresh: true,
    });

    assert.equal(result.status, "completed");
    assert.deepEqual(
      result.runs.map((run) => run.phase),
      ["code", "review", "repair"],
    );
    assert.deepEqual(
      provider.created.map(({ networkMode, workspaceAccess }) => ({
        networkMode,
        workspaceAccess,
      })),
      [
        { networkMode: "bridge", workspaceAccess: "read-write" },
        { networkMode: "none", workspaceAccess: "read-only" },
        { networkMode: "bridge", workspaceAccess: "read-write" },
      ],
    );
    assert.deepEqual(provider.terminated, ["sandbox-1", "sandbox-2", "sandbox-3"]);
    assert.equal(gatedReview, "offline-code-reviewer summary");
    assert.match(
      tasks.get("vue-migration-repairer") ?? "",
      /Accepted reviewer findings:\noffline-code-reviewer summary/,
    );
  });

  it("does not allocate a repair sandbox when review is rejected", async () => {
    const catalog = await FileCatalog.load(resolve("samples/catalog"));
    const scenario = await loadScenario(
      resolve("samples/last-hour-vue-migration/scenario.json"),
    );
    const provider = new RecordingSandboxProvider();
    const workflow = new ReviewRepairWorkflow({
      catalog,
      workspaceManager: {
        prepare: async () => "/work/testcase-1",
      },
      sandboxProviderFactory: () => provider,
      approvalHandler: new FixedApprovalHandler(true),
      reviewGate: async () => false,
      modelFactory: (agent) => new SummaryModel(`${agent.id} summary`, () => {}),
    });

    const result = await workflow.run({
      scenario,
      coderCaseId: "testcase-1",
      reviewerCaseId: "testcase-3",
      repairAgentId: "vue-migration-repairer",
    });

    assert.equal(result.status, "review-rejected");
    assert.equal(provider.created.length, 2);
    assert.equal(provider.terminated.length, 2);
  });
});