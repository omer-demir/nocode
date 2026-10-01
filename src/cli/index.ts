#!/usr/bin/env node
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { DemoModelProvider } from "../agent/demo-model-provider.js";
import { GuardrailCanaryModelProvider } from "../agent/guardrail-canary-model-provider.js";
import { FoundryGuardrailProbeModelProvider } from "../agent/foundry-guardrail-probe-model-provider.js";
import {
  DEFAULT_FOUNDRY_MODEL,
  DEFAULT_FOUNDRY_RESPONSES_ENDPOINT,
  FoundryModelProvider,
} from "../agent/foundry-model-provider.js";
import { runAgentSession } from "../agent/session.js";
import type {
  ApprovalHandler,
  PolicyDecision,
} from "../governance/policy-engine.js";
import type { ModelProvider, ToolRequest } from "../protocol/agent-protocol.js";
import {
  createSandboxProvider,
  createSandboxProviderForProfile,
} from "../sandbox/create-sandbox-provider.js";
import { startTelemetry } from "../telemetry/telemetry.js";
import { FileCatalog, loadScenario } from "../catalog/file-catalog.js";
import { resolveAgentModelConfiguration } from "../catalog/model-configuration.js";
import type {
  AgentDescriptor,
  AgentScenario,
  ToolDefinition,
} from "../catalog/catalog-types.js";
import { RepositoryWorkspaceManager } from "../scenarios/workspace-manager.js";
import { ScenarioRunner } from "../scenarios/scenario-runner.js";
import type { RuntimeEvent } from "../runtime/runtime-events.js";
import {
  ReviewRepairWorkflow,
  type ReviewGateInput,
} from "../workflows/review-repair-workflow.js";
import { SequentialWorkflow } from "../workflows/sequential-workflow.js";

class CliApprovalHandler implements ApprovalHandler {
  private remembered?: boolean;

  constructor(private readonly autoApprove: boolean) {}

  async request(request: ToolRequest, decision: PolicyDecision): Promise<boolean> {
    if (this.remembered !== undefined) {
      return this.remembered;
    }
    if (this.autoApprove) {
      return true;
    }
    if (!stdin.isTTY) {
      return false;
    }
    const prompt = createInterface({ input: stdin, output: stdout });
    try {
      const answer = await prompt.question(
        `${decision.reason}\nApprove ${request.name}? [y]es/[n]o/[a]llow-all/[d]eny-all `,
      );
      const choice = answer.trim().toLowerCase();
      if (choice === "a" || choice === "allow-all") {
        this.remembered = true;
        return true;
      }
      if (choice === "d" || choice === "deny-all") {
        this.remembered = false;
        return false;
      }
      return choice === "y" || choice === "yes";
    } finally {
      prompt.close();
    }
  }
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "help";
  if (command === "doctor") {
    let traceId = "";
    await trace.getTracer("nocode.agent").startActiveSpan(
      "agent.session",
      async (span) => {
        traceId = span.spanContext().traceId;
        span.setAttributes({
          "agent.id": "doctor",
          "agent.version": "0.1.0",
          "task.id": "otel-baseline",
        });
        span.setStatus({ code: SpanStatusCode.OK });
        span.end();
      },
    );
    console.log(`agentctl doctor: emitted agent.session trace ${traceId}`);
    return;
  }
  if (command === "agents") {
    const catalog = await FileCatalog.load(
      resolve(option("--catalog") ?? "samples/catalog"),
    );
    console.log(
      JSON.stringify(
        catalog.list().map(({ id, name, description, version, mode, role, model }) => ({
          id,
          name,
          description,
          version,
          mode,
          role,
          model: resolveAgentModelConfiguration(model),
        })),
        null,
        2,
      ),
    );
    return;
  }
  if (command === "workflows") {
    const catalog = await FileCatalog.load(
      resolve(option("--catalog") ?? "samples/catalog"),
    );
    console.log(JSON.stringify(catalog.listWorkflows(), null, 2));
    return;
  }
  if (command === "sample") {
    await runSample();
    return;
  }
  if (command === "workflow") {
    await runWorkflow();
    return;
  }
  if (command !== "run") {
    console.log(
      "Usage: agentctl doctor | agentctl agents | agentctl workflows | agentctl run <task> | agentctl sample run <scenario.json> | agentctl workflow <workflow-id> <repository-url>",
    );
    return;
  }

  const task = process.argv[3];
  if (!task || task.startsWith("--")) {
    throw new Error("agentctl run requires a task");
  }
  const providerName = option("--provider") ?? "demo";
  const modelProvider =
    providerName === "foundry"
      ? new FoundryModelProvider({
          endpoint:
            process.env.FOUNDRY_RESPONSES_ENDPOINT ??
            DEFAULT_FOUNDRY_RESPONSES_ENDPOINT,
          model: process.env.FOUNDRY_MODEL ?? DEFAULT_FOUNDRY_MODEL,
        })
      : new DemoModelProvider();
  if (providerName !== "demo" && providerName !== "foundry") {
    throw new Error(`Unknown provider: ${providerName}`);
  }

  const cancellation = new AbortController();
  const cancel = (): void => cancellation.abort(new Error("Session cancelled"));
  process.once("SIGINT", cancel);
  const result = await runAgentSession({
    task,
    workspacePath: resolve(option("--repo") ?? "."),
    modelProvider,
    sandboxProvider: createSandboxProvider(),
    approvalHandler: new CliApprovalHandler(process.argv.includes("--yes")),
    onEvent: logRuntimeEvent,
    signal: cancellation.signal,
  });
  process.removeListener("SIGINT", cancel);
  console.log(result);
}

async function runWorkflow(): Promise<void> {
  const workflowId = process.argv[3];
  if (!workflowId || workflowId.startsWith("--")) {
    throw new Error(
      "Usage: agentctl workflow <workflow-id> <repository-url> [--fresh] [--yes]",
    );
  }
  const repositoryUrl = process.argv[4];
  if (!repositoryUrl || repositoryUrl.startsWith("--")) {
    throw new Error(`Workflow ${workflowId} requires a repository URL`);
  }
  validateRepositoryUrl(repositoryUrl);
  const catalog = await FileCatalog.load(
    resolve(option("--catalog") ?? "samples/catalog"),
  );
  const definition = catalog.getWorkflow(workflowId);
  const scenarioTemplate: AgentScenario =
    definition.kind === "review-repair"
      ? await loadScenario(
          resolve(
            option("--scenario") ??
              "samples/last-hour-vue-migration/scenario.json",
          ),
        )
      : {
          id: definition.id,
          name: definition.name,
          description: definition.description,
          repository: { url: repositoryUrl },
          testCases: [],
        };
  const repositoryHash = createHash("sha256")
    .update(repositoryUrl)
    .digest("hex")
    .slice(0, 12);
  const scenario = {
    ...scenarioTemplate,
    id: `workflow-${definition.id}-${repositoryHash}`,
    name: definition.name,
    description: definition.description,
    repository: { url: repositoryUrl },
  };
  const autoApprove = process.argv.includes("--yes");
  const cancellation = new AbortController();
  const cancel = (): void => cancellation.abort(new Error("Workflow cancelled"));
  process.once("SIGINT", cancel);
  try {
    if (definition.kind === "sequential") {
      const workflow = new SequentialWorkflow({
        catalog,
        workspaceManager: new RepositoryWorkspaceManager(
          resolve(option("--workspace-root") ?? ".agent-workspaces"),
        ),
        sandboxProviderFactory: (agent) =>
          createSandboxProviderForProfile(agent.sandbox.profiles.remote.poolProfile),
        approvalHandler: new CliApprovalHandler(autoApprove),
        modelFactory: (agent, tools) => createCatalogModel(agent, tools),
        onEvent: logRuntimeEvent,
      });
      const result = await workflow.run({
        scenario,
        definition,
        fresh: process.argv.includes("--fresh"),
        signal: cancellation.signal,
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const workflow = new ReviewRepairWorkflow({
      catalog,
      workspaceManager: new RepositoryWorkspaceManager(
        resolve(option("--workspace-root") ?? ".agent-workspaces"),
      ),
      sandboxProviderFactory: (agent) =>
        createSandboxProviderForProfile(agent.sandbox.profiles.remote.poolProfile),
      approvalHandler: new CliApprovalHandler(autoApprove),
      reviewGate: (input) => confirmReview(input, autoApprove),
      modelFactory: (agent, tools) => createCatalogModel(agent, tools),
      onEvent: logRuntimeEvent,
    });
    const result = await workflow.run({
      scenario,
      coderCaseId:
        option("--coder-case") ?? definition.configuration.coderCaseId,
      reviewerCaseId:
        option("--reviewer-case") ?? definition.configuration.reviewerCaseId,
      repairAgentId:
        option("--repair-agent") ?? definition.configuration.repairAgentId,
      fresh: process.argv.includes("--fresh"),
      signal: cancellation.signal,
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    process.removeListener("SIGINT", cancel);
  }
}

function validateRepositoryUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Repository must be a valid HTTPS URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("Only HTTPS repository URLs are supported");
  }
}

async function confirmReview(
  input: ReviewGateInput,
  autoApprove: boolean,
): Promise<boolean> {
  process.stderr.write(
    `\nReview completed for workflow ${input.workflowId}:\n${input.reviewSummary}\n\n`,
  );
  if (autoApprove) {
    return true;
  }
  if (!stdin.isTTY) {
    return false;
  }
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    const answer = await prompt.question(
      "Accept these findings and start an isolated repair run? [y/N] ",
    );
    return answer.trim().toLowerCase() === "y";
  } finally {
    prompt.close();
  }
}

async function runSample(): Promise<void> {
  if (process.argv[3] !== "run") {
    throw new Error("Usage: agentctl sample run <scenario.json> [--case <id|all>]");
  }
  const scenarioPath = process.argv[4];
  if (!scenarioPath || scenarioPath.startsWith("--")) {
    throw new Error("Sample run requires a scenario JSON path");
  }
  const catalog = await FileCatalog.load(
    resolve(option("--catalog") ?? "samples/catalog"),
  );
  const scenario = await loadScenario(resolve(scenarioPath));
  for (const testCase of scenario.testCases) {
    catalog.get(testCase.agentId);
  }

  const cancellation = new AbortController();
  const cancel = (): void => cancellation.abort(new Error("Session cancelled"));
  process.once("SIGINT", cancel);
  try {
    process.stderr.write(
      `[${new Date().toISOString()}] scenario ${scenario.id} started\n`,
    );
    const runner = new ScenarioRunner({
      catalog,
      sandboxProvider: createSandboxProvider(),
      workspaceManager: new RepositoryWorkspaceManager(
        resolve(option("--workspace-root") ?? ".agent-workspaces"),
      ),
      approvalHandler: new CliApprovalHandler(process.argv.includes("--yes")),
      modelFactory: (agent, tools) => createCatalogModel(agent, tools),
      onEvent: logRuntimeEvent,
    });
    const selected = option("--case");
    const results = await runner.run(
      scenario,
      !selected || selected === "all" ? [] : selected.split(","),
      process.argv.includes("--fresh"),
      cancellation.signal,
    );
    console.log(JSON.stringify(results, null, 2));
  } finally {
    process.removeListener("SIGINT", cancel);
  }
}

function logRuntimeEvent(event: RuntimeEvent): void {
  process.stderr.write(
    `[${event.timestamp}] ${event.type} ${event.sessionId.slice(0, 8)} ${event.message}\n`,
  );
}

function createCatalogModel(
  agent: AgentDescriptor,
  tools: readonly ToolDefinition[],
): ModelProvider {
  if (agent.model.provider === "deterministic-guardrail-canary") {
    return new GuardrailCanaryModelProvider();
  }
  const model = resolveAgentModelConfiguration(agent.model);
  if (model.provider === "microsoft-foundry-guardrail-probe") {
    return new FoundryGuardrailProbeModelProvider({
      endpoint: model.endpoint,
      model: model.deployment,
      instructions: agent.instructions,
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
  });
}

const sdk = startTelemetry("agentctl");
try {
  await main();
} finally {
  await sdk.shutdown();
}