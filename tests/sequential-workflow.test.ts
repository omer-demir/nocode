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
import { SequentialWorkflow } from "../src/workflows/sequential-workflow.js";

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
  constructor(private readonly summary: string) {}

  async complete(_messages: readonly AgentMessage[]): Promise<ModelResponse> {
    return { content: this.summary };
  }
}

describe("sequential workflow", () => {
  it("hands the first agent workspace to the second agent in a new sandbox", async () => {
    const catalog = await FileCatalog.load(resolve("samples/catalog"));
    const scenario = await loadScenario(
      resolve("samples/last-hour-vue-migration/scenario.json"),
    );
    const definition = catalog.getWorkflow("vue-migration-developer-flow");
    assert.equal(definition.kind, "sequential");
    if (definition.kind !== "sequential") return;

    const provider = new RecordingSandboxProvider();
    const preparedCases: Array<{ id: string; source: string }> = [];
    const workflow = new SequentialWorkflow({
      catalog,
      workspaceManager: {
        prepare: async (_scenario, testCase) => {
          preparedCases.push({
            id: testCase.id,
            source:
              testCase.workspace.source === "clone"
                ? "clone"
                : testCase.workspace.testCaseId,
          });
          return "/work/vue-migration-developer-flow-implement";
        },
      },
      sandboxProviderFactory: () => provider,
      approvalHandler: new FixedApprovalHandler(true),
      modelFactory: (agent: AgentDescriptor) =>
        new SummaryModel(`${agent.id} completed`),
    });

    const result = await workflow.run({
      scenario,
      definition,
      fresh: true,
    });

    assert.deepEqual(
      result.runs.map(({ stepId, agentId, workspacePath }) => ({
        stepId,
        agentId,
        workspacePath,
      })),
      [
        {
          stepId: "implement",
          agentId: "vue-migration-coder",
          workspacePath: "/work/vue-migration-developer-flow-implement",
        },
        {
          stepId: "review-and-improve",
          agentId: "vue-migration-reviewer-implementor",
          workspacePath: "/work/vue-migration-developer-flow-implement",
        },
      ],
    );
    assert.deepEqual(preparedCases, [
      { id: "vue-migration-developer-flow-implement", source: "clone" },
      {
        id: "vue-migration-developer-flow-review-and-improve",
        source: "vue-migration-developer-flow-implement",
      },
    ]);
    assert.equal(provider.created.length, 2);
    assert.deepEqual(provider.terminated, ["sandbox-1", "sandbox-2"]);
  });
});
