import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { FileCatalog, loadScenario } from "../src/catalog/file-catalog.js";
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
import { TuiController } from "../src/tui/controller.js";
import { TuiSessionStore } from "../src/tui/session-store.js";
import { RepositoryWorkspaceManager } from "../src/scenarios/workspace-manager.js";

class ApprovalSequenceModel implements ModelProvider {
  private step = 0;

  async complete(_messages: readonly AgentMessage[]): Promise<ModelResponse> {
    this.step += 1;
    if (this.step <= 2) {
      return {
        toolRequest: {
          id: `write-${this.step}`,
          name: "filesystem.write",
          arguments: { path: `file-${this.step}.txt`, content: "content" },
        },
      };
    }
    return { content: "completed" };
  }
}

class RepeatedFailedBuildModel implements ModelProvider {
  private step = 0;

  constructor(private readonly buildAttempts: number) {}

  async complete(_messages: readonly AgentMessage[]): Promise<ModelResponse> {
    this.step += 1;
    if (this.step <= this.buildAttempts) {
      return {
        toolRequest: {
          id: `build-${this.step}`,
          name: "build.run",
          arguments: {},
        },
      };
    }
    return { content: "build fixed" };
  }
}

class SuccessfulSandboxProvider implements SandboxProvider {
  readonly placement = "local" as const;
  createCount = 0;
  workspacePaths: string[] = [];

  async create(config: SandboxConfig): Promise<SandboxReference> {
    this.createCount += 1;
    this.workspacePaths.push(config.workspacePath);
    return { id: "sandbox", provider: "local-docker" };
  }

  async execute(_input: ExecuteCommand): Promise<CommandResult> {
    return {
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 1,
      truncated: false,
    };
  }

  async terminate(_sandboxId: string): Promise<void> {}
}

class FailedBuildSandboxProvider extends SuccessfulSandboxProvider {
  terminateCount = 0;

  override async execute(_input: ExecuteCommand): Promise<CommandResult> {
    return {
      exitCode: 1,
      stdout: "",
      stderr: "build failed",
      durationMs: 1,
      truncated: false,
    };
  }

  override async terminate(_sandboxId: string): Promise<void> {
    this.terminateCount += 1;
  }
}

async function controller(): Promise<TuiController> {
  return new TuiController({
    catalog: await FileCatalog.load(resolve("samples/catalog")),
    scenario: await loadScenario(
      resolve("samples/last-hour-vue-migration/scenario.json"),
    ),
    workspaceManager: new RepositoryWorkspaceManager(resolve(".agent-workspaces")),
    store: new TuiSessionStore(),
  });
}

describe("TUI controller", () => {
  it("resolves friendly aliases through the registry", async () => {
    const instance = await controller();
    assert.equal(instance.resolveAgent("vue-migrator").id, "vue-migration-coder");
    assert.equal(instance.resolveAgent("offline-reviewer").id, "offline-code-reviewer");
  });

  it("lists and resolves workflows through the registry", async () => {
    const instance = await controller();
    assert.deepEqual(
      instance.listWorkflows().map((workflow) => workflow.id),
      ["review-repair", "vue-migration-developer-flow"],
    );
  });

  it("rejects placement that does not match the configured provider", async () => {
    const instance = await controller();
    assert.throws(
      () =>
        instance.launchAgent({
          agentRef: "vue-migrator",
          repositoryUrl: "https://github.com/omer-demir/LastHour",
          placement: "remote",
          task: "Migrate to Vue",
        }),
      /configured sandbox provider supports local placement, not remote/,
    );
  });

  it("launches review-repair as one approval-gated TUI session", async () => {
    const store = new TuiSessionStore();
    const sandboxProvider = new SuccessfulSandboxProvider();
    const preparedRepositoryUrls: string[] = [];
    const instance = new TuiController({
      catalog: await FileCatalog.load(resolve("samples/catalog")),
      scenario: await loadScenario(
        resolve("samples/last-hour-vue-migration/scenario.json"),
      ),
      workspaceManager: {
        prepare: async (scenario: { repository: { url: string } }) => {
          preparedRepositoryUrls.push(scenario.repository.url);
          return "/workspace";
        },
      } as unknown as RepositoryWorkspaceManager,
      store,
      sandboxProvider,
      modelFactory: (agent) => ({
        complete: async () => ({ content: `${agent.id} complete` }),
      }),
    });

    const repositoryUrl = "https://github.com/example/runtime-target.git";
    const workflowId = instance.launchReviewRepairWorkflow(repositoryUrl, true);
    await waitFor(() => store.get(workflowId)?.status === "awaiting-approval");
    instance.resolveApproval(workflowId, true);
    await instance.waitForIdle();

    assert.equal(store.get(workflowId)?.status, "completed");
    assert.equal(store.get(workflowId)?.summary, "vue-migration-repairer complete");
    assert.equal(sandboxProvider.createCount, 3);
    assert.deepEqual(
      store.get(workflowId)?.runs.map((run) => [run.label, run.agentId]),
      [
        ["code", "vue-migration-coder"],
        ["review", "offline-code-reviewer"],
        ["repair", "vue-migration-repairer"],
      ],
    );
    assert.deepEqual(preparedRepositoryUrls, [
      repositoryUrl,
      repositoryUrl,
      repositoryUrl,
    ]);
    assert.ok(
      store
        .get(workflowId)
        ?.events.every((event) => event.sessionId === workflowId),
    );
  });

  it("continues a session and runs another agent in the persisted workspace", async () => {
    const store = new TuiSessionStore();
    const sandboxProvider = new SuccessfulSandboxProvider();
    const instance = new TuiController({
      catalog: await FileCatalog.load(resolve("samples/catalog")),
      scenario: await loadScenario(
        resolve("samples/last-hour-vue-migration/scenario.json"),
      ),
      workspaceManager: {
        prepare: async () => "/persisted/workspace",
      } as unknown as RepositoryWorkspaceManager,
      store,
      sandboxProvider,
      modelFactory: (agent) => ({
        complete: async () => ({ content: `${agent.id} complete` }),
      }),
    });
    const sessionId = instance.launchAgent({
      agentRef: "vue-migrator",
      repositoryUrl: "https://github.com/example/repository.git",
      placement: "local",
      task: "Initial migration",
    });
    await instance.waitForIdle();

    instance.continueSession(sessionId, "Add integration tests");
    await instance.waitForIdle();
    instance.runAgentInSession(
      sessionId,
      "offline-reviewer",
      "Review current changes",
    );
    await instance.waitForIdle();

    assert.deepEqual(sandboxProvider.workspacePaths, [
      "/persisted/workspace",
      "/persisted/workspace",
      "/persisted/workspace",
    ]);
    assert.deepEqual(
      store.get(sessionId)?.runs.map((run) => [run.kind, run.agentId]),
      [
        ["agent", "vue-migration-coder"],
        ["message", "vue-migration-coder"],
        ["agent", "offline-code-reviewer"],
      ],
    );
    assert.equal(store.get(sessionId)?.status, "completed");
  });

  for (const decision of [
    { approved: true, mode: "allow-all" },
    { approved: false, mode: "deny-all" },
  ] as const) {
    it(`remembers ${decision.mode} for later requests in the execution`, async () => {
      const store = new TuiSessionStore();
      const instance = new TuiController({
        catalog: await FileCatalog.load(resolve("samples/catalog")),
        scenario: await loadScenario(
          resolve("samples/last-hour-vue-migration/scenario.json"),
        ),
        workspaceManager: {
          prepare: async () => "/workspace",
        } as unknown as RepositoryWorkspaceManager,
        store,
        sandboxProvider: new SuccessfulSandboxProvider(),
        modelFactory: () => new ApprovalSequenceModel(),
      });
      const sessionId = instance.launchAgent({
        agentRef: "vue-migrator",
        repositoryUrl: "https://github.com/omer-demir/LastHour",
        placement: "local",
        task: "Exercise remembered approvals",
      });

      await waitFor(() => store.get(sessionId)?.status === "awaiting-approval");
      instance.resolveApproval(sessionId, decision.approved, true);
      await instance.waitForIdle();

      assert.equal(store.get(sessionId)?.status, "completed");
      const approvals = store
        .get(sessionId)
        ?.events.filter((event) => event.type === "approval.resolved");
      assert.equal(approvals?.length, 2);
      assert.equal(approvals?.[1]?.attributes?.approvalMode, decision.mode);
      assert.equal(approvals?.[1]?.attributes?.remembered, true);
    });
  }

  it("does not treat continue as approval for a governed tool", async () => {
    const store = new TuiSessionStore();
    const instance = new TuiController({
      catalog: await FileCatalog.load(resolve("samples/catalog")),
      scenario: await loadScenario(
        resolve("samples/last-hour-vue-migration/scenario.json"),
      ),
      workspaceManager: {
        prepare: async () => "/workspace",
      } as unknown as RepositoryWorkspaceManager,
      store,
      sandboxProvider: new SuccessfulSandboxProvider(),
      modelFactory: () => new ApprovalSequenceModel(),
    });
    const sessionId = instance.launchAgent({
      agentRef: "vue-migrator",
      repositoryUrl: "https://github.com/omer-demir/LastHour",
      placement: "local",
      task: "Exercise approval isolation",
    });

    await waitFor(() => store.get(sessionId)?.status === "awaiting-approval");
    assert.throws(
      () => instance.resolveIterationLimit(sessionId, true),
      /waiting for a tool approval/,
    );
    instance.resolveApproval(sessionId, false, true);
    await instance.waitForIdle();

    assert.equal(store.get(sessionId)?.status, "completed");
  });

  it("keeps the sandbox alive and continues after the iteration limit", async () => {
    const store = new TuiSessionStore();
    const sandboxProvider = new FailedBuildSandboxProvider();
    const instance = new TuiController({
      catalog: await FileCatalog.load(resolve("samples/catalog")),
      scenario: await loadScenario(
        resolve("samples/last-hour-vue-migration/scenario.json"),
      ),
      workspaceManager: {
        prepare: async () => "/workspace",
      } as unknown as RepositoryWorkspaceManager,
      store,
      sandboxProvider,
      modelFactory: () => new RepeatedFailedBuildModel(21),
    });
    const sessionId = instance.launchAgent({
      agentRef: "vue-migrator",
      repositoryUrl: "https://github.com/omer-demir/LastHour",
      placement: "local",
      task: "Repair the build",
    });

    await waitFor(() => store.get(sessionId)?.status === "awaiting-approval");
    assert.equal(sandboxProvider.createCount, 1);
    assert.equal(sandboxProvider.terminateCount, 0);
    assert.equal(
      store.get(sessionId)?.events.at(-1)?.attributes?.decisionKind,
      "iteration-limit",
    );

    instance.resolveIterationLimit(sessionId, true);
    await instance.waitForIdle();

    assert.equal(store.get(sessionId)?.status, "completed");
    assert.equal(store.get(sessionId)?.summary, "build fixed");
    assert.equal(sandboxProvider.createCount, 1);
    assert.equal(sandboxProvider.terminateCount, 1);
  });

  it("cancels cleanly when the user stops at the iteration limit", async () => {
    const store = new TuiSessionStore();
    const sandboxProvider = new FailedBuildSandboxProvider();
    const instance = new TuiController({
      catalog: await FileCatalog.load(resolve("samples/catalog")),
      scenario: await loadScenario(
        resolve("samples/last-hour-vue-migration/scenario.json"),
      ),
      workspaceManager: {
        prepare: async () => "/workspace",
      } as unknown as RepositoryWorkspaceManager,
      store,
      sandboxProvider,
      modelFactory: () => new RepeatedFailedBuildModel(Number.POSITIVE_INFINITY),
    });
    const sessionId = instance.launchAgent({
      agentRef: "vue-migrator",
      repositoryUrl: "https://github.com/omer-demir/LastHour",
      placement: "local",
      task: "Repair the build",
    });

    await waitFor(() => store.get(sessionId)?.status === "awaiting-approval");
    instance.resolveIterationLimit(sessionId, false);
    await instance.waitForIdle();

    assert.equal(store.get(sessionId)?.status, "cancelled");
    assert.equal(sandboxProvider.terminateCount, 1);
    assert.ok(
      store
        .get(sessionId)
        ?.events.some((event) => event.type === "session.cancelled"),
    );
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
  }
  throw new Error("Timed out waiting for controller state");
}