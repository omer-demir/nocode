import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import type {
  AgentDescriptor,
  WorkflowDescriptor,
} from "../src/catalog/catalog-types.js";
import { FileCatalog } from "../src/catalog/file-catalog.js";
import {
  ExecutionService,
  type ExecutionController,
  type ExecutionPlacement,
} from "../src/gateway/execution-service.js";
import { TuiSessionStore } from "../src/tui/session-store.js";

class RecordingController implements ExecutionController {
  readonly agentLaunches: ExecutionPlacement[] = [];
  readonly workflowLaunches: ExecutionPlacement[] = [];
  private nextId = 0;

  constructor(
    private readonly placement: ExecutionPlacement,
    private readonly agents: readonly AgentDescriptor[],
    private readonly workflows: readonly WorkflowDescriptor[],
    private readonly store: TuiSessionStore,
  ) {}

  sandboxPlacement(): ExecutionPlacement {
    return this.placement;
  }

  listAgents(): readonly AgentDescriptor[] {
    return this.agents;
  }

  listWorkflows(): readonly WorkflowDescriptor[] {
    return this.workflows;
  }

  launchAgent(input: {
    agentRef: string;
    repositoryUrl: string;
    placement: ExecutionPlacement;
    task: string;
  }): string {
    this.agentLaunches.push(input.placement);
    return this.createSession(input.agentRef, input.repositoryUrl);
  }

  launchWorkflow(
    reference: string,
    repositoryUrl: string,
    _fresh: boolean,
  ): string {
    this.workflowLaunches.push(this.placement);
    return this.createSession(reference, repositoryUrl);
  }

  resolveApproval(): void {}

  cancel(): void {}

  private createSession(agentId: string, repositoryUrl: string): string {
    this.nextId += 1;
    const id = `${this.placement}-execution-${this.nextId}`;
    this.store.create({
      id,
      agentId,
      agentName: agentId,
      repositoryUrl,
      placement: this.placement,
      status: "queued",
    });
    return id;
  }
}

describe("ExecutionService placement routing", () => {
  it("routes explicit local and remote launches without fallback", async () => {
    const catalog = await FileCatalog.load(resolve("samples/catalog"));
    const store = new TuiSessionStore();
    const local = new RecordingController(
      "local",
      catalog.list(),
      catalog.listWorkflows(),
      store,
    );
    const remote = new RecordingController(
      "remote",
      catalog.list(),
      catalog.listWorkflows(),
      store,
    );
    const service = new ExecutionService({ local, remote }, store);

    assert.deepEqual(service.listAgents()[0]?.availablePlacements, [
      "local",
      "remote",
    ]);
    assert.ok(service.listAgents()[0]?.sandboxProfiles.local);
    assert.ok(service.listAgents()[0]?.sandboxProfiles.remote);

    const localSession = service.launch({
      agentId: "vue-migration-coder",
      repositoryUrl: "https://github.com/example/local.git",
      task: "Run locally",
      placement: "local",
    });
    const remoteSession = service.launch({
      agentId: "vue-migration-coder",
      repositoryUrl: "https://github.com/example/remote.git",
      task: "Run remotely",
      placement: "remote",
    });

    assert.equal(localSession.placement, "local");
    assert.equal(remoteSession.placement, "remote");
    assert.deepEqual(local.agentLaunches, ["local"]);
    assert.deepEqual(remote.agentLaunches, ["remote"]);
  });

  it("rejects an unavailable placement instead of falling back", async () => {
    const catalog = await FileCatalog.load(resolve("samples/catalog"));
    const store = new TuiSessionStore();
    const local = new RecordingController(
      "local",
      catalog.list(),
      catalog.listWorkflows(),
      store,
    );
    const service = new ExecutionService({ local }, store);

    assert.throws(
      () =>
        service.launch({
          agentId: "vue-migration-coder",
          repositoryUrl: "https://github.com/example/remote.git",
          task: "Do not fall back",
          placement: "remote",
        }),
      /Placement remote is not available.*local/,
    );
    assert.deepEqual(local.agentLaunches, []);
  });
});