import { randomUUID } from "node:crypto";
import { runAgentSession } from "../agent/session.js";
import type {
  AgentDescriptor,
  AgentScenario,
  ScenarioTestCase,
  SequentialWorkflowDescriptor,
  ToolDefinition,
} from "../catalog/catalog-types.js";
import { FileCatalog } from "../catalog/file-catalog.js";
import { CatalogPolicyEngine } from "../governance/catalog-policy-engine.js";
import type { ApprovalHandler } from "../governance/policy-engine.js";
import type { ModelProvider } from "../protocol/agent-protocol.js";
import type { RuntimeEventSink } from "../runtime/runtime-events.js";
import type { SandboxProvider } from "../sandbox/sandbox-provider.js";
import { sandboxConfigForAgent } from "../scenarios/scenario-runner.js";

interface WorkspaceManager {
  prepare(
    scenario: AgentScenario,
    testCase: ScenarioTestCase,
    fresh?: boolean,
  ): Promise<string>;
}

export interface SequentialWorkflowOptions {
  catalog: FileCatalog;
  workspaceManager: WorkspaceManager;
  sandboxProviderFactory: (agent: AgentDescriptor) => SandboxProvider;
  approvalHandler: ApprovalHandler;
  modelFactory: (
    agent: AgentDescriptor,
    tools: readonly ToolDefinition[],
  ) => ModelProvider;
  onEvent?: RuntimeEventSink;
}

export interface SequentialWorkflowRunResult {
  stepId: string;
  sessionId: string;
  agentId: string;
  workspacePath: string;
  summary: string;
}

export interface SequentialWorkflowResult {
  workflowId: string;
  status: "completed";
  runs: readonly SequentialWorkflowRunResult[];
}

export interface SequentialWorkflowInput {
  workflowId?: string;
  scenario: AgentScenario;
  definition: SequentialWorkflowDescriptor;
  fresh?: boolean;
  signal?: AbortSignal;
  onIterationLimit?: (input: {
    iterations: number;
    additionalIterations: number;
  }) => Promise<boolean>;
}

export class SequentialWorkflow {
  constructor(private readonly options: SequentialWorkflowOptions) {}

  async run(input: SequentialWorkflowInput): Promise<SequentialWorkflowResult> {
    const workflowId = input.workflowId ?? randomUUID();
    const runs: SequentialWorkflowRunResult[] = [];

    for (const step of input.definition.configuration.steps) {
      input.signal?.throwIfAborted();
      const testCaseId = `${input.definition.id}-${step.id}`;
      const testCase: ScenarioTestCase = {
        id: testCaseId,
        name: step.id,
        description: `${input.definition.name}: ${step.id}`,
        agentId: step.agentId,
        task: step.task,
        workspace:
          step.workspace.source === "clone"
            ? { source: "clone" }
            : {
                source: "test-case-output",
                testCaseId: `${input.definition.id}-${step.workspace.stepId}`,
              },
      };
      const agent = this.options.catalog.get(step.agentId);
      const provider = this.options.sandboxProviderFactory(agent);
      const workspacePath = await this.options.workspaceManager.prepare(
        input.scenario,
        testCase,
        (input.fresh ?? false) && step.workspace.source === "clone",
      );
      const tools = agent.tools.map((name) => this.options.catalog.getTool(name));
      const sessionId = randomUUID();
      const summary = await runAgentSession({
        task: step.task,
        workspacePath,
        modelProvider: this.options.modelFactory(agent, tools),
        sandboxProvider: provider,
        approvalHandler: this.options.approvalHandler,
        policyEngine: new CatalogPolicyEngine(agent, this.options.catalog.tools),
        agent,
        sandboxConfig: sandboxConfigForAgent(agent, provider.placement),
        sessionId,
        taskId: `${workflowId}:${step.id}`,
        ...(this.options.onEvent === undefined
          ? {}
          : { onEvent: this.options.onEvent }),
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.onIterationLimit === undefined
          ? {}
          : { onIterationLimit: input.onIterationLimit }),
      });
      runs.push({
        stepId: step.id,
        sessionId,
        agentId: agent.id,
        workspacePath,
        summary,
      });
    }

    return { workflowId, status: "completed", runs };
  }
}
