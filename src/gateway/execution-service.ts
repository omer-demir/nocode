import type { RuntimeEvent } from "../runtime/runtime-events.js";
import type {
  AgentDescriptor,
  AgentRuntime,
  HarnessReference,
  LocalSandboxProfile,
  RemoteSandboxProfile,
  WorkflowDescriptor,
} from "../catalog/catalog-types.js";
import {
  TuiSessionStore,
  type TuiSessionRunRecord,
  type TuiSessionStatus,
} from "../tui/session-store.js";

export type ExecutionPlacement = "local" | "remote";

export interface ExecutionController {
  sandboxPlacement(): ExecutionPlacement;
  listAgents(): readonly AgentDescriptor[];
  listWorkflows(): readonly WorkflowDescriptor[];
  launchAgent(input: {
    agentRef: string;
    repositoryUrl: string;
    placement: ExecutionPlacement;
    task: string;
  }): string;
  launchWorkflow(
    reference: string,
    repositoryUrl: string,
    fresh: boolean,
  ): string;
  resolveApproval(prefix: string, approved: boolean, remember?: boolean): void;
  cancel(prefix: string): void;
}

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  runtime: AgentRuntime;
  harness: HarnessReference;
  availablePlacements: readonly ExecutionPlacement[];
  sandboxProfiles: {
    local: LocalSandboxProfile;
    remote: RemoteSandboxProfile;
  };
}

export interface ExecutionSession {
  id: string;
  agentId: string;
  agentName: string;
  repositoryUrl: string;
  placement: ExecutionPlacement;
  status: TuiSessionStatus;
  summary?: string;
  error?: string;
  workspacePath?: string;
  runs: readonly TuiSessionRunRecord[];
  events: readonly RuntimeEvent[];
  startedAt: string;
  updatedAt: string;
}

export interface LaunchExecutionInput {
  agentId: string;
  repositoryUrl: string;
  task: string;
  placement: ExecutionPlacement;
}

export interface LaunchWorkflowInput {
  workflowId: string;
  repositoryUrl: string;
  fresh?: boolean;
  placement: ExecutionPlacement;
}

export interface ExecutionApi {
  listAgents(): readonly AgentSummary[];
  listWorkflows(): readonly WorkflowDescriptor[];
  listSessions(): readonly ExecutionSession[];
  getSession(reference: string): ExecutionSession;
  launch(input: LaunchExecutionInput): ExecutionSession;
  launchWorkflow(input: LaunchWorkflowInput): ExecutionSession;
  resolveApproval(
    reference: string,
    approved: boolean,
    remember?: boolean,
  ): ExecutionSession;
  cancel(reference: string): ExecutionSession;
  subscribe(listener: () => void): () => void;
}

export class ExecutionService implements ExecutionApi {
  private readonly availablePlacements: readonly ExecutionPlacement[];
  private readonly primaryController: ExecutionController;

  constructor(
    private readonly controllers: Readonly<
      Partial<Record<ExecutionPlacement, ExecutionController>>
    >,
    private readonly store: TuiSessionStore,
  ) {
    this.availablePlacements = (["local", "remote"] as const).filter(
      (placement) => controllers[placement] !== undefined,
    );
    const primaryPlacement = this.availablePlacements[0];
    if (!primaryPlacement) {
      throw new Error("ExecutionService requires at least one sandbox placement");
    }
    this.primaryController = this.controllerForPlacement(primaryPlacement);
    for (const placement of this.availablePlacements) {
      if (this.controllerForPlacement(placement).sandboxPlacement() !== placement) {
        throw new Error(
          `The ${placement} execution controller is configured for a different placement`,
        );
      }
    }
  }

  listAgents(): readonly AgentSummary[] {
    return this.primaryController.listAgents().map((agent) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      runtime: agent.runtime,
      harness: agent.harness,
      availablePlacements: this.availablePlacements,
      sandboxProfiles: agent.sandbox.profiles,
    }));
  }

  listWorkflows(): readonly WorkflowDescriptor[] {
    return this.primaryController.listWorkflows();
  }

  listSessions(): readonly ExecutionSession[] {
    return this.store.snapshot().sessions.map(toExecutionSession);
  }

  getSession(reference: string): ExecutionSession {
    const sessionId = this.store.resolveId(reference);
    const session = this.store.get(sessionId);
    if (!session) {
      throw new Error(`Session ${reference} was not found`);
    }
    return toExecutionSession(session);
  }

  launch(input: LaunchExecutionInput): ExecutionSession {
    const sessionId = this.controllerForPlacement(input.placement).launchAgent({
      agentRef: input.agentId,
      repositoryUrl: input.repositoryUrl,
      placement: input.placement,
      task: input.task,
    });
    return this.getSession(sessionId);
  }

  launchWorkflow(input: LaunchWorkflowInput): ExecutionSession {
    return this.getSession(
      this.controllerForPlacement(input.placement).launchWorkflow(
        input.workflowId,
        input.repositoryUrl,
        input.fresh ?? false,
      ),
    );
  }

  resolveApproval(
    reference: string,
    approved: boolean,
    remember = false,
  ): ExecutionSession {
    this.controllerForSession(reference).resolveApproval(
      reference,
      approved,
      remember,
    );
    return this.getSession(reference);
  }

  cancel(reference: string): ExecutionSession {
    this.controllerForSession(reference).cancel(reference);
    return this.getSession(reference);
  }

  subscribe(listener: () => void): () => void {
    return this.store.subscribe(listener);
  }

  private controllerForSession(reference: string): ExecutionController {
    return this.controllerForPlacement(this.getSession(reference).placement);
  }

  private controllerForPlacement(
    placement: ExecutionPlacement,
  ): ExecutionController {
    const controller = this.controllers[placement];
    if (!controller) {
      throw new Error(
        `Placement ${placement} is not available from this gateway; available placements: ${this.availablePlacements.join(", ") || "none"}`,
      );
    }
    return controller;
  }
}

function toExecutionSession(
  session: ReturnType<TuiSessionStore["snapshot"]>["sessions"][number],
): ExecutionSession {
  return {
    id: session.id,
    agentId: session.agentId,
    agentName: session.agentName,
    repositoryUrl: session.repositoryUrl,
    placement: session.placement,
    status: session.status,
    ...(session.summary === undefined ? {} : { summary: session.summary }),
    ...(session.error === undefined ? {} : { error: session.error }),
    ...(session.workspacePath === undefined
      ? {}
      : { workspacePath: session.workspacePath }),
    runs: session.runs,
    events: session.events,
    startedAt: session.startedAt,
    updatedAt: session.updatedAt,
  };
}