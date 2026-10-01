import type {
  AgentDescriptor,
  AgentScenario,
  ToolDefinition,
} from "../catalog/catalog-types.js";
import { FileCatalog } from "../catalog/file-catalog.js";
import type { ModelProvider } from "../protocol/agent-protocol.js";
import type { SandboxConfig, SandboxProvider } from "../sandbox/sandbox-provider.js";
import type { ApprovalHandler } from "../governance/policy-engine.js";
import { CatalogPolicyEngine } from "../governance/catalog-policy-engine.js";
import { runAgentSession } from "../agent/session.js";
import { RepositoryWorkspaceManager } from "./workspace-manager.js";
import type { RuntimeEventSink } from "../runtime/runtime-events.js";

export interface ScenarioRunResult {
  testCaseId: string;
  agentId: string;
  workspacePath: string;
  summary: string;
}

export interface ScenarioRunnerOptions {
  catalog: FileCatalog;
  sandboxProvider: SandboxProvider;
  workspaceManager: RepositoryWorkspaceManager;
  approvalHandler: ApprovalHandler;
  modelFactory: (
    agent: AgentDescriptor,
    tools: readonly ToolDefinition[],
  ) => ModelProvider;
  onEvent?: RuntimeEventSink;
}

export class ScenarioRunner {
  constructor(private readonly options: ScenarioRunnerOptions) {}

  async run(
    scenario: AgentScenario,
    selectedCases: readonly string[],
    fresh: boolean,
    signal?: AbortSignal,
  ): Promise<ScenarioRunResult[]> {
    const selected =
      selectedCases.length === 0
        ? scenario.testCases
        : scenario.testCases.filter((testCase) => selectedCases.includes(testCase.id));
    if (selectedCases.length > 0 && selected.length !== selectedCases.length) {
      const known = new Set(selected.map((testCase) => testCase.id));
      const missing = selectedCases.filter((id) => !known.has(id));
      throw new Error(`Unknown test case: ${missing.join(", ")}`);
    }

    const results: ScenarioRunResult[] = [];
    for (const testCase of selected) {
      signal?.throwIfAborted();
      const agent = this.options.catalog.get(testCase.agentId);
      const tools = agent.tools.map((name) => this.options.catalog.getTool(name));
      const workspacePath = await this.options.workspaceManager.prepare(
        scenario,
        testCase,
        fresh && testCase.workspace.source === "clone",
      );
      const summary = await runAgentSession({
        task: testCase.task,
        workspacePath,
        modelProvider: this.options.modelFactory(agent, tools),
        sandboxProvider: this.options.sandboxProvider,
        approvalHandler: this.options.approvalHandler,
        policyEngine: new CatalogPolicyEngine(agent, this.options.catalog.tools),
        agent,
        sandboxConfig: sandboxConfigForAgent(
          agent,
          this.options.sandboxProvider.placement,
        ),
        ...(this.options.onEvent === undefined
          ? {}
          : { onEvent: this.options.onEvent }),
        ...(signal === undefined ? {} : { signal }),
      });
      results.push({
        testCaseId: testCase.id,
        agentId: agent.id,
        workspacePath,
        summary,
      });
    }
    return results;
  }
}

export function sandboxConfigForAgent(
  agent: AgentDescriptor,
  placement: "local" | "remote" = "local",
): Omit<SandboxConfig, "workspacePath"> {
  const profile = agent.sandbox.profiles[placement];
  const environment =
    profile.networkMode === "bridge" ? sandboxProxyEnvironment() : {};
  return {
    isolation: profile.isolation,
    ...(placement === "local"
      ? {
          image: agent.sandbox.profiles.local.image,
          pidsLimit: agent.sandbox.profiles.local.pidsLimit,
        }
      : { poolProfile: agent.sandbox.profiles.remote.poolProfile }),
    cpuLimit: profile.cpuLimit,
    memoryMb: profile.memoryMb,
    networkMode: profile.networkMode,
    workspaceAccess: profile.workspaceAccess,
    ...(Object.keys(environment).length === 0 ? {} : { environment }),
  };
}

function sandboxProxyEnvironment(): Readonly<Record<string, string>> {
  const mappings = [
    ["SANDBOX_HTTP_PROXY", "HTTP_PROXY"],
    ["SANDBOX_HTTPS_PROXY", "HTTPS_PROXY"],
    ["SANDBOX_NO_PROXY", "NO_PROXY"],
  ] as const;
  return Object.fromEntries(
    mappings.flatMap(([source, target]) => {
      const value = process.env[source];
      return value ? [[target, value]] : [];
    }),
  );
}