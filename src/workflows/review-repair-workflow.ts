import { randomUUID } from "node:crypto";
import { runAgentSession } from "../agent/session.js";
import type {
  AgentDescriptor,
  AgentScenario,
  ScenarioTestCase,
  ToolDefinition,
} from "../catalog/catalog-types.js";
import { FileCatalog } from "../catalog/file-catalog.js";
import { CatalogPolicyEngine } from "../governance/catalog-policy-engine.js";
import type { ApprovalHandler } from "../governance/policy-engine.js";
import type { ModelProvider } from "../protocol/agent-protocol.js";
import type { RuntimeEventSink } from "../runtime/runtime-events.js";
import type { SandboxProvider } from "../sandbox/sandbox-provider.js";
import { sandboxConfigForAgent } from "../scenarios/scenario-runner.js";

const MAX_REVIEW_HANDOFF_CHARS = 32_768;

interface WorkspaceManager {
  prepare(
    scenario: AgentScenario,
    testCase: ScenarioTestCase,
    fresh?: boolean,
  ): Promise<string>;
}

export interface ReviewGateInput {
  workflowId: string;
  reviewSessionId: string;
  reviewSummary: string;
}

export interface ReviewRepairWorkflowOptions {
  catalog: FileCatalog;
  workspaceManager: WorkspaceManager;
  sandboxProviderFactory: (agent: AgentDescriptor) => SandboxProvider;
  approvalHandler: ApprovalHandler;
  reviewGate: (input: ReviewGateInput) => Promise<boolean>;
  modelFactory: (
    agent: AgentDescriptor,
    tools: readonly ToolDefinition[],
  ) => ModelProvider;
  onEvent?: RuntimeEventSink;
}

export interface ReviewRepairRunResult {
  phase: "code" | "review" | "repair";
  sessionId: string;
  agentId: string;
  workspacePath: string;
  summary: string;
}

export interface ReviewRepairWorkflowResult {
  workflowId: string;
  status: "completed" | "review-rejected";
  runs: readonly ReviewRepairRunResult[];
}

export interface ReviewRepairWorkflowInput {
  workflowId?: string;
  scenario: AgentScenario;
  coderCaseId: string;
  reviewerCaseId: string;
  repairAgentId: string;
  fresh?: boolean;
  signal?: AbortSignal;
  onIterationLimit?: (input: {
    iterations: number;
    additionalIterations: number;
  }) => Promise<boolean>;
}

export class ReviewRepairWorkflow {
  constructor(private readonly options: ReviewRepairWorkflowOptions) {}

  async run(input: ReviewRepairWorkflowInput): Promise<ReviewRepairWorkflowResult> {
    const workflowId = input.workflowId ?? randomUUID();
    const coderCase = this.testCase(input.scenario, input.coderCaseId);
    const reviewerCase = this.testCase(input.scenario, input.reviewerCaseId);
    this.validateHandoff(coderCase, reviewerCase);

    const runs: ReviewRepairRunResult[] = [];
    const code = await this.runPhase(
      workflowId,
      "code",
      input.scenario,
      coderCase,
      this.options.catalog.get(coderCase.agentId),
      input.fresh ?? false,
      input.signal,
      input.onIterationLimit,
    );
    runs.push(code);

    const review = await this.runPhase(
      workflowId,
      "review",
      input.scenario,
      reviewerCase,
      this.options.catalog.get(reviewerCase.agentId),
      false,
      input.signal,
      input.onIterationLimit,
    );
    runs.push(review);

    if (review.summary.length > MAX_REVIEW_HANDOFF_CHARS) {
      throw new Error(
        `Review handoff exceeds ${MAX_REVIEW_HANDOFF_CHARS} characters`,
      );
    }
    const accepted = await this.options.reviewGate({
      workflowId,
      reviewSessionId: review.sessionId,
      reviewSummary: review.summary,
    });
    if (!accepted) {
      return { workflowId, status: "review-rejected", runs };
    }

    const repairAgent = this.options.catalog.get(input.repairAgentId);
    const repairCase: ScenarioTestCase = {
      id: `${coderCase.id}-repair`,
      name: "Repair accepted review findings",
      description: "Apply accepted findings to the coding output",
      agentId: repairAgent.id,
      task: [
        "Repair the implementation using the accepted reviewer findings below.",
        "Inspect the workspace before editing, address each applicable finding, and run bounded build and test validation.",
        "Do not blindly follow a finding that conflicts with the repository; explain any rejected finding in the final summary.",
        "",
        "Accepted reviewer findings:",
        review.summary,
      ].join("\n"),
      workspace: { source: "test-case-output", testCaseId: coderCase.id },
    };
    const repair = await this.runPhase(
      workflowId,
      "repair",
      input.scenario,
      repairCase,
      repairAgent,
      false,
      input.signal,
      input.onIterationLimit,
    );
    runs.push(repair);
    return { workflowId, status: "completed", runs };
  }

  private async runPhase(
    workflowId: string,
    phase: ReviewRepairRunResult["phase"],
    scenario: AgentScenario,
    testCase: ScenarioTestCase,
    agent: AgentDescriptor,
    fresh: boolean,
    signal?: AbortSignal,
    onIterationLimit?: ReviewRepairWorkflowInput["onIterationLimit"],
  ): Promise<ReviewRepairRunResult> {
    signal?.throwIfAborted();
    const sessionId = randomUUID();
    const workspacePath = await this.options.workspaceManager.prepare(
      scenario,
      testCase,
      fresh,
    );
    const provider = this.options.sandboxProviderFactory(agent);
    const tools = agent.tools.map((name) => this.options.catalog.getTool(name));
    const summary = await runAgentSession({
      task: testCase.task,
      workspacePath,
      modelProvider: this.options.modelFactory(agent, tools),
      sandboxProvider: provider,
      approvalHandler: this.options.approvalHandler,
      policyEngine: new CatalogPolicyEngine(agent, this.options.catalog.tools),
      agent,
      sandboxConfig: sandboxConfigForAgent(agent, provider.placement),
      sessionId,
      taskId: `${workflowId}:${phase}`,
      ...(this.options.onEvent === undefined
        ? {}
        : { onEvent: this.options.onEvent }),
      ...(signal === undefined ? {} : { signal }),
      ...(onIterationLimit === undefined ? {} : { onIterationLimit }),
    });
    return { phase, sessionId, agentId: agent.id, workspacePath, summary };
  }

  private testCase(scenario: AgentScenario, id: string): ScenarioTestCase {
    const testCase = scenario.testCases.find((candidate) => candidate.id === id);
    if (!testCase) {
      throw new Error(`Workflow test case ${id} was not found`);
    }
    return testCase;
  }

  private validateHandoff(
    coderCase: ScenarioTestCase,
    reviewerCase: ScenarioTestCase,
  ): void {
    if (
      reviewerCase.workspace.source !== "test-case-output" ||
      reviewerCase.workspace.testCaseId !== coderCase.id
    ) {
      throw new Error(
        `Reviewer ${reviewerCase.id} must consume output from ${coderCase.id}`,
      );
    }
  }
}
