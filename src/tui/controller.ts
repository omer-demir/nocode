import { createHash, randomUUID } from "node:crypto";
import type {
  AgentDescriptor,
  AgentScenario,
  ScenarioTestCase,
  ToolDefinition,
  WorkflowDescriptor,
} from "../catalog/catalog-types.js";
import { FileCatalog } from "../catalog/file-catalog.js";
import { resolveAgentModelConfiguration } from "../catalog/model-configuration.js";
import { FoundryModelProvider } from "../agent/foundry-model-provider.js";
import { FoundryGuardrailProbeModelProvider } from "../agent/foundry-guardrail-probe-model-provider.js";
import { GuardrailCanaryModelProvider } from "../agent/guardrail-canary-model-provider.js";
import { runAgentSession } from "../agent/session.js";
import { AgentStoppedError } from "../agent/agent-loop.js";
import { CatalogPolicyEngine } from "../governance/catalog-policy-engine.js";
import type {
  ApprovalHandler,
  PolicyDecision,
} from "../governance/policy-engine.js";
import type {
  ModelProvider,
  ToolRequest,
} from "../protocol/agent-protocol.js";
import { runtimeEvent } from "../runtime/runtime-events.js";
import { LocalDockerSandboxProvider } from "../sandbox/local-docker-sandbox-provider.js";
import type { SandboxProvider } from "../sandbox/sandbox-provider.js";
import { sandboxConfigForAgent } from "../scenarios/scenario-runner.js";
import { RepositoryWorkspaceManager } from "../scenarios/workspace-manager.js";
import {
  TuiSessionStore,
  type TuiSessionRecord,
} from "./session-store.js";
import { ReviewRepairWorkflow } from "../workflows/review-repair-workflow.js";
import { SequentialWorkflow } from "../workflows/sequential-workflow.js";
import {
  GitWorkspacePublisher,
  type WorkspacePublisher,
} from "./workspace-publisher.js";

const AGENT_ALIASES: Readonly<Record<string, string>> = {
  "vue-migrator": "vue-migration-coder",
  "vue-reviewer": "vue-migration-reviewer-implementor",
  "offline-reviewer": "offline-code-reviewer",
  "python-coder": "python-repository-coder",
};

interface PendingApproval {
  resolve: (approved: boolean) => void;
  kind: "tool" | "iteration-limit";
  label: string;
  request?: ToolRequest;
}

type RememberedApproval = "allow-all" | "deny-all";

export interface TuiControllerOptions {
  catalog: FileCatalog;
  scenario: AgentScenario;
  workspaceManager: RepositoryWorkspaceManager;
  store: TuiSessionStore;
  sandboxProvider?: SandboxProvider;
  modelFactory?: (
    agent: AgentDescriptor,
    tools: readonly ToolDefinition[],
  ) => ModelProvider;
  workspacePublisher?: WorkspacePublisher;
  reasoningSummary?: "auto" | "concise" | "detailed";
}

export class TuiController {
  private readonly sandboxProvider: SandboxProvider;
  private readonly abortControllers = new Map<string, AbortController>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();
  private readonly rememberedApprovals = new Map<string, RememberedApproval>();
  private readonly activeRuns = new Set<Promise<void>>();
  private readonly publishingSessions = new Set<string>();
  private readonly workspacePublisher: WorkspacePublisher;

  constructor(private readonly options: TuiControllerOptions) {
    this.sandboxProvider =
      options.sandboxProvider ?? new LocalDockerSandboxProvider();
    this.workspacePublisher =
      options.workspacePublisher ?? new GitWorkspacePublisher();
  }

  listAgents(): readonly AgentDescriptor[] {
    return this.options.catalog.list();
  }

  listTestCases(): readonly ScenarioTestCase[] {
    return this.options.scenario.testCases;
  }

  listWorkflows(): readonly WorkflowDescriptor[] {
    return this.options.catalog.listWorkflows();
  }

  resolveAgent(reference: string): AgentDescriptor {
    const id = AGENT_ALIASES[reference] ?? reference;
    return this.options.catalog.get(id);
  }

  sandboxPlacement(): "local" | "remote" {
    return this.sandboxProvider.placement;
  }

  launchAgent(input: {
    agentRef: string;
    repositoryUrl: string;
    placement: "local" | "remote";
    task: string;
  }): string {
    this.requireConfiguredPlacement(input.placement);
    validateRepositoryUrl(input.repositoryUrl);
    const agent = this.resolveAgent(input.agentRef);
    const sessionId = randomUUID();
    this.createSession(sessionId, agent, input.repositoryUrl, input.placement);
    const scenario: AgentScenario = {
      id: "interactive",
      name: "Interactive agent run",
      description: "TUI-launched agent session",
      repository: { url: input.repositoryUrl },
      testCases: [],
    };
    const testCase: ScenarioTestCase = {
      id: sessionId,
      name: "Interactive run",
      description: "TUI-launched agent session",
      agentId: agent.id,
      task: input.task,
      workspace: { source: "clone" },
    };
    this.track(this.execute(sessionId, agent, scenario, testCase, true));
    return sessionId;
  }

  launchTestCases(
    testCaseId: string,
    placement: "local" | "remote",
    fresh: boolean,
  ): string[] {
    this.requireConfiguredPlacement(placement);
    const cases =
      testCaseId === "all"
        ? this.options.scenario.testCases
        : this.options.scenario.testCases.filter(
            (testCase) => testCase.id === testCaseId,
          );
    if (cases.length === 0) {
      throw new Error(`Test case ${testCaseId} was not found`);
    }
    const launches = cases.map((testCase) => {
      const sessionId = randomUUID();
      const agent = this.options.catalog.get(testCase.agentId);
      this.createSession(
        sessionId,
        agent,
        this.options.scenario.repository.url,
        placement,
      );
      return { sessionId, agent, testCase };
    });
    this.track(this.executeTestSequence(launches, fresh));
    return launches.map((launch) => launch.sessionId);
  }

  launchReviewRepairWorkflow(repositoryUrl: string, fresh: boolean): string {
    return this.launchWorkflow("review-repair", repositoryUrl, fresh);
  }

  launchWorkflow(
    reference: string,
    repositoryUrl: string,
    fresh: boolean,
  ): string {
    validateRepositoryUrl(repositoryUrl);
    const workflow = this.options.catalog.getWorkflow(reference);
    const workflowId = randomUUID();
    const scenario = this.workflowScenario(workflow, repositoryUrl);
    this.options.store.create({
      id: workflowId,
      agentId: workflow.id,
      agentIdentity: workflow.identity.subject,
      agentName: workflow.name,
      repositoryUrl,
      placement: this.sandboxProvider.placement,
      status: "queued",
    });
    this.options.store.message(
      "info",
      `Queued ${workflow.id} workflow ${shortId(workflowId)}`,
    );
    this.track(this.executeWorkflow(workflowId, workflow, scenario, fresh));
    return workflowId;
  }

  continueSession(prefix: string, message: string): string {
    const session = this.requireReusableSession(prefix);
    const agentId =
      [...session.runs]
        .reverse()
        .find((run) => run.agentId && run.kind !== "publish")?.agentId ??
      session.agentId;
    const agent = this.options.catalog.get(agentId);
    const task = [
      "Continue work in the existing persisted session workspace.",
      session.summary ? `Previous result: ${session.summary}` : undefined,
      `User request: ${message}`,
    ]
      .filter((value): value is string => value !== undefined)
      .join("\n\n");
    this.startSessionRun(session.id, agent, task, "message", "Follow-up message");
    return session.id;
  }

  runAgentInSession(prefix: string, agentRef: string, task: string): string {
    const session = this.requireReusableSession(prefix);
    const agent = this.resolveAgent(agentRef);
    this.startSessionRun(session.id, agent, task, "agent", agent.name);
    return session.id;
  }

  publishSession(prefix: string, branch: string): string {
    const session = this.requireReusableSession(prefix);
    const workspacePath = session.workspacePath;
    const startedAt = new Date().toISOString();
    this.publishingSessions.add(session.id);
    this.options.store.message(
      "info",
      `Publishing ${shortId(session.id)} to ${branch}`,
    );
    this.track(
      this.workspacePublisher
        .publish({
          workspacePath,
          branch,
          sessionId: session.id,
        })
        .then((result) => {
          const completedAt = new Date().toISOString();
          const summary = `Published ${result.commit.slice(0, 12)} to ${result.branch}`;
          this.options.store.appendRun(session.id, {
            id: randomUUID(),
            kind: "publish",
            label: result.branch,
            summary,
            workspacePath,
            status: "completed",
            startedAt,
            completedAt,
          });
          this.options.store.message("success", summary);
        })
        .catch((error: unknown) => {
          const completedAt = new Date().toISOString();
          const summary = error instanceof Error ? error.message : String(error);
          this.options.store.appendRun(session.id, {
            id: randomUUID(),
            kind: "publish",
            label: branch,
            summary,
            workspacePath,
            status: "failed",
            startedAt,
            completedAt,
          });
          this.options.store.message(
            "error",
            `Publish failed for ${shortId(session.id)}: ${summary}`,
          );
        })
        .finally(() => this.publishingSessions.delete(session.id)),
    );
    return session.id;
  }

  resolveApproval(prefix: string, approved: boolean, remember = false): void {
    this.resolvePendingDecision(prefix, approved, remember);
  }

  resolveIterationLimit(prefix: string, shouldContinue: boolean): void {
    this.resolvePendingDecision(
      prefix,
      shouldContinue,
      false,
      "iteration-limit",
    );
  }

  private resolvePendingDecision(
    prefix: string,
    approved: boolean,
    remember: boolean,
    expectedKind?: PendingApproval["kind"],
  ): void {
    const sessionId = this.options.store.resolveId(prefix);
    const pending = this.pendingApprovals.get(sessionId);
    if (!pending) {
      throw new Error(`Session ${prefix} has no pending approval`);
    }
    if (expectedKind !== undefined && pending.kind !== expectedKind) {
      throw new Error(
        `Session ${prefix} is waiting for a tool approval; use /approve or /deny`,
      );
    }
    this.pendingApprovals.delete(sessionId);
    if (remember && pending.kind === "tool") {
      this.rememberedApprovals.set(
        sessionId,
        approved ? "allow-all" : "deny-all",
      );
    }
    this.options.store.appendEvent(
      runtimeEvent(
        "approval.resolved",
        sessionId,
        `${pending.label} ${approved ? "approved" : "denied"}`,
        {
          decisionKind: pending.kind,
          ...(pending.request === undefined
            ? {}
            : { toolName: pending.request.name }),
          approved,
          ...(remember && pending.kind === "tool"
            ? { approvalMode: approved ? "allow-all" : "deny-all" }
            : {}),
        },
      ),
    );
    this.options.store.update(sessionId, { status: "running" });
    pending.resolve(approved);
  }

  cancel(prefix: string): void {
    const sessionId = this.options.store.resolveId(prefix);
    const controller = this.abortControllers.get(sessionId);
    if (!controller) {
      throw new Error(`Session ${prefix} is not running`);
    }
    this.pendingApprovals.get(sessionId)?.resolve(false);
    this.pendingApprovals.delete(sessionId);
    this.rememberedApprovals.delete(sessionId);
    controller.abort(new Error("Cancelled by user"));
    this.options.store.update(sessionId, { status: "cancelled" });
    this.options.store.message("warning", `Session ${shortId(sessionId)} cancelled`);
  }

  cancelAll(): void {
    for (const controller of this.abortControllers.values()) {
      controller.abort(new Error("TUI closed"));
    }
    for (const pending of this.pendingApprovals.values()) {
      pending.resolve(false);
    }
    this.pendingApprovals.clear();
    this.rememberedApprovals.clear();
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.activeRuns]);
  }

  private async executeWorkflow(
    workflowId: string,
    definition: WorkflowDescriptor,
    scenario: AgentScenario,
    fresh: boolean,
  ): Promise<void> {
    const cancellation = new AbortController();
    this.abortControllers.set(workflowId, cancellation);
    this.options.store.update(workflowId, { status: "running" });
    try {
      if (definition.kind === "sequential") {
        const workflow = new SequentialWorkflow({
          catalog: this.options.catalog,
          workspaceManager: this.options.workspaceManager,
          sandboxProviderFactory: () => this.sandboxProvider,
          approvalHandler: this.approvalHandler(workflowId),
          modelFactory: (agent, tools) => this.createModel(agent, tools),
          onEvent: (event) =>
            this.options.store.appendEvent({
              ...event,
              sessionId: workflowId,
              attributes: {
                ...event.attributes,
                "phase.session.id": event.sessionId,
              },
            }),
        });
        const result = await workflow.run({
          workflowId,
          scenario,
          definition,
          fresh,
          signal: cancellation.signal,
          onIterationLimit: (input) =>
            this.iterationLimitHandler(workflowId, input),
        });
        const completedAt = new Date().toISOString();
        for (const run of result.runs) {
          this.options.store.appendRun(workflowId, {
            id: run.sessionId,
            kind: "workflow-step",
            label: run.stepId,
            agentId: run.agentId,
            summary: run.summary,
            workspacePath: run.workspacePath,
            status: "completed",
            startedAt: completedAt,
            completedAt,
          });
        }
        this.options.store.update(workflowId, {
          status: "completed",
          summary:
            result.runs.at(-1)?.summary ??
            `${definition.name} completed without a summary.`,
          ...(result.runs[0]?.workspacePath === undefined
            ? {}
            : { workspacePath: result.runs[0].workspacePath }),
        });
        this.options.store.message(
          "success",
          `Workflow ${shortId(workflowId)} completed`,
        );
        return;
      }
      const workflow = new ReviewRepairWorkflow({
        catalog: this.options.catalog,
        workspaceManager: this.options.workspaceManager,
        sandboxProviderFactory: () => this.sandboxProvider,
        approvalHandler: this.approvalHandler(workflowId),
        reviewGate: async ({ reviewSummary }) => {
          this.options.store.message(
            "warning",
            `Review findings for ${shortId(workflowId)}: ${singleLine(reviewSummary, 800)}`,
          );
          return this.approvalHandler(workflowId).request(
            {
              id: `review-gate-${workflowId}`,
              name: "workflow.repair",
              arguments: {},
            },
            {
              outcome: "ASK",
              rule: "review-repair-gate",
              reason: "Accepted reviewer findings are required before repair",
            },
          );
        },
        modelFactory: (agent, tools) => this.createModel(agent, tools),
        onEvent: (event) =>
          this.options.store.appendEvent({
            ...event,
            sessionId: workflowId,
            attributes: {
              ...event.attributes,
              "phase.session.id": event.sessionId,
            },
          }),
      });
      const result = await workflow.run({
        workflowId,
        scenario,
        coderCaseId: definition.configuration.coderCaseId,
        reviewerCaseId: definition.configuration.reviewerCaseId,
        repairAgentId: definition.configuration.repairAgentId,
        fresh,
        signal: cancellation.signal,
        onIterationLimit: (input) =>
          this.iterationLimitHandler(workflowId, input),
      });
      const completedAt = new Date().toISOString();
      for (const run of result.runs) {
        this.options.store.appendRun(workflowId, {
          id: run.sessionId,
          kind: "workflow-step",
          label: run.phase,
          agentId: run.agentId,
          summary: run.summary,
          workspacePath: run.workspacePath,
          status: "completed",
          startedAt: completedAt,
          completedAt,
        });
      }
      const finalSummary =
        result.status === "review-rejected"
          ? "Review completed; repair was not accepted."
          : result.runs.at(-1)?.summary ?? "Review-repair workflow completed.";
      this.options.store.update(workflowId, {
        status: "completed",
        summary: finalSummary,
        ...(result.runs[0]?.workspacePath === undefined
          ? {}
          : { workspacePath: result.runs[0].workspacePath }),
      });
      this.options.store.message(
        "success",
        `Workflow ${shortId(workflowId)} ${result.status}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (cancellation.signal.aborted) {
        this.options.store.update(workflowId, { status: "cancelled" });
      } else {
        this.options.store.update(workflowId, { status: "failed", error: message });
        this.options.store.message(
          "error",
          `Workflow ${shortId(workflowId)} failed: ${message}`,
        );
      }
    } finally {
      this.abortControllers.delete(workflowId);
      this.pendingApprovals.delete(workflowId);
      this.rememberedApprovals.delete(workflowId);
    }
  }

  private async executeTestSequence(
    launches: readonly {
      sessionId: string;
      agent: AgentDescriptor;
      testCase: ScenarioTestCase;
    }[],
    fresh: boolean,
  ): Promise<void> {
    for (const launch of launches) {
      await this.execute(
        launch.sessionId,
        launch.agent,
        this.options.scenario,
        launch.testCase,
        fresh && launch.testCase.workspace.source === "clone",
      );
    }
  }

  private async execute(
    sessionId: string,
    agent: AgentDescriptor,
    scenario: AgentScenario,
    testCase: ScenarioTestCase,
    fresh: boolean,
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    const cancellation = new AbortController();
    this.abortControllers.set(sessionId, cancellation);
    this.options.store.update(sessionId, { status: "running" });
    try {
      const workspacePath = await this.options.workspaceManager.prepare(
        scenario,
        testCase,
        fresh,
      );
      this.options.store.update(sessionId, { workspacePath });
      const tools = agent.tools.map((name) => this.options.catalog.getTool(name));
      const summary = await runAgentSession({
        task: testCase.task,
        workspacePath,
        modelProvider: this.createModel(agent, tools),
        sandboxProvider: this.sandboxProvider,
        approvalHandler: this.approvalHandler(sessionId),
        policyEngine: new CatalogPolicyEngine(agent, this.options.catalog.tools),
        agent,
        sandboxConfig: sandboxConfigForAgent(
          agent,
          this.sandboxProvider.placement,
        ),
        sessionId,
        onEvent: (event) => this.options.store.appendEvent(event),
        signal: cancellation.signal,
        onIterationLimit: (input) =>
          this.iterationLimitHandler(sessionId, input),
      });
      const completedAt = new Date().toISOString();
      this.options.store.appendRun(sessionId, {
        id: sessionId,
        kind: "agent",
        label: agent.name,
        agentId: agent.id,
        task: testCase.task,
        summary,
        workspacePath,
        status: "completed",
        startedAt,
        completedAt,
      });
      this.options.store.update(sessionId, { status: "completed", summary });
      this.options.store.message(
        "success",
        `Session ${shortId(sessionId)} completed`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (cancellation.signal.aborted || error instanceof AgentStoppedError) {
        this.options.store.update(sessionId, { status: "cancelled" });
        if (!cancellation.signal.aborted) {
          this.options.store.message(
            "warning",
            `Session ${shortId(sessionId)} stopped at the iteration limit`,
          );
        }
      } else {
        this.options.store.update(sessionId, { status: "failed", error: message });
        this.options.store.message(
          "error",
          `Session ${shortId(sessionId)} failed: ${message}`,
        );
      }
    } finally {
      this.abortControllers.delete(sessionId);
      this.pendingApprovals.delete(sessionId);
      this.rememberedApprovals.delete(sessionId);
    }
  }

  private startSessionRun(
    sessionId: string,
    agent: AgentDescriptor,
    task: string,
    kind: "message" | "agent",
    label: string,
  ): void {
    const session = this.options.store.get(sessionId);
    if (!session?.workspacePath) {
      throw new Error(`Session ${shortId(sessionId)} has no persisted workspace`);
    }
    const runId = randomUUID();
    this.track(
      this.executeSessionRun(
        sessionId,
        runId,
        agent,
        session.workspacePath,
        task,
        kind,
        label,
      ),
    );
  }

  private async executeSessionRun(
    sessionId: string,
    runId: string,
    agent: AgentDescriptor,
    workspacePath: string,
    task: string,
    kind: "message" | "agent",
    label: string,
  ): Promise<void> {
    const startedAt = new Date().toISOString();
    const cancellation = new AbortController();
    this.abortControllers.set(sessionId, cancellation);
    this.options.store.update(sessionId, { status: "running" });
    try {
      const tools = agent.tools.map((name) => this.options.catalog.getTool(name));
      const summary = await runAgentSession({
        task,
        workspacePath,
        modelProvider: this.createModel(agent, tools),
        sandboxProvider: this.sandboxProvider,
        approvalHandler: this.approvalHandler(sessionId),
        policyEngine: new CatalogPolicyEngine(agent, this.options.catalog.tools),
        agent,
        sandboxConfig: sandboxConfigForAgent(
          agent,
          this.sandboxProvider.placement,
        ),
        sessionId,
        taskId: runId,
        onEvent: (event) => this.options.store.appendEvent(event),
        signal: cancellation.signal,
        onIterationLimit: (input) =>
          this.iterationLimitHandler(sessionId, input),
      });
      const completedAt = new Date().toISOString();
      this.options.store.appendRun(sessionId, {
        id: runId,
        kind,
        label,
        agentId: agent.id,
        task,
        summary,
        workspacePath,
        status: "completed",
        startedAt,
        completedAt,
      });
      this.options.store.update(sessionId, { status: "completed", summary });
      this.options.store.message(
        "success",
        `${label} completed in session ${shortId(sessionId)}`,
      );
    } catch (error) {
      const completedAt = new Date().toISOString();
      const summary = error instanceof Error ? error.message : String(error);
      this.options.store.appendRun(sessionId, {
        id: runId,
        kind,
        label,
        agentId: agent.id,
        task,
        summary,
        workspacePath,
        status: "failed",
        startedAt,
        completedAt,
      });
      this.options.store.update(sessionId, {
        status: cancellation.signal.aborted ? "cancelled" : "failed",
        error: summary,
      });
      this.options.store.message(
        "error",
        `${label} failed in session ${shortId(sessionId)}: ${summary}`,
      );
    } finally {
      this.abortControllers.delete(sessionId);
      this.pendingApprovals.delete(sessionId);
      this.rememberedApprovals.delete(sessionId);
    }
  }

  private requireReusableSession(
    prefix: string,
  ): TuiSessionRecord & { workspacePath: string } {
    const sessionId = this.options.store.resolveId(prefix);
    const session = this.options.store.get(sessionId);
    if (!session?.workspacePath) {
      throw new Error(`Session ${prefix} has no persisted workspace`);
    }
    if (this.abortControllers.has(sessionId)) {
      throw new Error(`Session ${prefix} is already running`);
    }
    if (this.publishingSessions.has(sessionId)) {
      throw new Error(`Session ${prefix} is being published`);
    }
    return { ...session, workspacePath: session.workspacePath };
  }

  private approvalHandler(sessionId: string): ApprovalHandler {
    return {
      request: (request: ToolRequest, _decision: PolicyDecision) => {
        const remembered = this.rememberedApprovals.get(sessionId);
        if (remembered) {
          const approved = remembered === "allow-all";
          this.options.store.appendEvent(
            runtimeEvent(
              "approval.resolved",
              sessionId,
              `${request.name} ${approved ? "approved" : "denied"} by ${remembered}`,
              {
                toolName: request.name,
                approved,
                approvalMode: remembered,
                remembered: true,
              },
            ),
          );
          return Promise.resolve(approved);
        }
        if (this.pendingApprovals.has(sessionId)) {
          throw new Error(`Session ${sessionId} already has a pending approval`);
        }
        this.options.store.appendEvent(
          runtimeEvent(
            "approval.requested",
            sessionId,
            `Approval required for ${request.name}`,
            { toolName: request.name },
          ),
        );
        this.options.store.update(sessionId, { status: "awaiting-approval" });
        this.options.store.message(
          "warning",
          `Approval needed: /approve ${shortId(sessionId)}, /deny ${shortId(sessionId)}, /allow-all ${shortId(sessionId)}, or /deny-all ${shortId(sessionId)}`,
        );
        return new Promise<boolean>((resolve) => {
          this.pendingApprovals.set(sessionId, {
            resolve,
            kind: "tool",
            label: request.name,
            request,
          });
        });
      },
    };
  }

  private iterationLimitHandler(
    sessionId: string,
    input: { iterations: number; additionalIterations: number },
  ): Promise<boolean> {
    if (this.pendingApprovals.has(sessionId)) {
      throw new Error(`Session ${sessionId} already has a pending approval`);
    }
    this.options.store.appendEvent(
      runtimeEvent(
        "approval.requested",
        sessionId,
        `Agent reached ${input.iterations} iterations`,
        {
          decisionKind: "iteration-limit",
          iterations: input.iterations,
          additionalIterations: input.additionalIterations,
        },
      ),
    );
    this.options.store.update(sessionId, { status: "awaiting-approval" });
    this.options.store.message(
      "warning",
      `Iteration limit reached: /continue ${shortId(sessionId)} for ${input.additionalIterations} more turns, or /stop ${shortId(sessionId)}`,
    );
    return new Promise<boolean>((resolve) => {
      this.pendingApprovals.set(sessionId, {
        resolve,
        kind: "iteration-limit",
        label: "agent.continue",
      });
    });
  }

  private createModel(
    agent: AgentDescriptor,
    tools: readonly ToolDefinition[],
  ): ModelProvider {
    if (this.options.modelFactory) {
      return this.options.modelFactory(agent, tools);
    }
    if (agent.model.provider === "deterministic-guardrail-canary") {
      return new GuardrailCanaryModelProvider();
    }
    const model = resolveAgentModelConfiguration(agent.model);
    if (model.provider === "microsoft-foundry-guardrail-probe") {
      return new FoundryGuardrailProbeModelProvider({
        endpoint: model.endpoint,
        model: model.deployment,
        instructions: agent.instructions,
        ...(this.options.reasoningSummary === undefined
          ? {}
          : { reasoningSummary: this.options.reasoningSummary }),
      });
    }
    return new FoundryModelProvider({
      endpoint: model.endpoint,
      model: model.deployment,
      instructions: agent.instructions,
      tools,
      ...(model.requireToolOnFirstTurn === undefined
        ? {}
        : { requireToolOnFirstTurn: model.requireToolOnFirstTurn }),
      ...(this.options.reasoningSummary === undefined
        ? {}
        : { reasoningSummary: this.options.reasoningSummary }),
    });
  }

  private workflowScenario(
    workflow: WorkflowDescriptor,
    repositoryUrl: string,
  ): AgentScenario {
    const repositoryHash = createHash("sha256")
      .update(repositoryUrl)
      .digest("hex")
      .slice(0, 12);
    return {
      ...this.options.scenario,
      id: `workflow-${workflow.id}-${repositoryHash}`,
      name: workflow.name,
      description: workflow.description,
      repository: { url: repositoryUrl },
    };
  }

  private createSession(
    sessionId: string,
    agent: AgentDescriptor,
    repositoryUrl: string,
    placement: "local" | "remote",
  ): void {
    this.options.store.create({
      id: sessionId,
      agentId: agent.id,
      agentIdentity: agent.identity.subject,
      agentName: agent.name,
      repositoryUrl,
      placement,
      status: "queued",
    });
    this.options.store.message(
      "info",
      `Queued ${agent.name} as session ${shortId(sessionId)}`,
    );
  }

  private requireConfiguredPlacement(placement: "local" | "remote"): void {
    if (placement !== this.sandboxProvider.placement) {
      throw new Error(
        `The configured sandbox provider supports ${this.sandboxProvider.placement} placement, not ${placement}`,
      );
    }
  }

  private track(run: Promise<void>): void {
    this.activeRuns.add(run);
    void run.finally(() => this.activeRuns.delete(run));
  }
}

export function shortId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function validateRepositoryUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Repository must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("Only HTTPS repository URLs are supported by the TUI");
  }
}

function singleLine(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength
    ? compact
    : `${compact.slice(0, maxLength - 3)}...`;
}