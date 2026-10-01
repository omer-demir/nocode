import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AgentDescriptor,
  AgentRegistry,
  AgentScenario,
  CapabilityDefinition,
  HarnessDefinition,
  ScenarioTestCase,
  ToolDefinition,
  WorkflowDescriptor,
  WorkflowRegistry,
} from "./catalog-types.js";

type AgentManifest = Omit<
  AgentDescriptor,
  "capabilities" | "tools" | "toolPolicy"
>;

interface AgentDocument {
  agents: AgentManifest[];
}

interface HarnessDocument {
  harnesses: HarnessDefinition[];
}

interface ToolDocument {
  tools: ToolDefinition[];
}

interface CapabilityDocument {
  capabilities: CapabilityDefinition[];
}

interface WorkflowDocument {
  workflows: WorkflowDescriptor[];
}

export class FileCatalog implements AgentRegistry, WorkflowRegistry {
  private readonly agentsById: ReadonlyMap<string, AgentDescriptor>;
  private readonly harnessesByVersion: ReadonlyMap<string, HarnessDefinition>;
  private readonly toolsByName: ReadonlyMap<string, ToolDefinition>;
  private readonly capabilitiesById: ReadonlyMap<string, CapabilityDefinition>;
  private readonly workflowsById: ReadonlyMap<string, WorkflowDescriptor>;

  private constructor(
    readonly agents: readonly AgentDescriptor[],
    readonly tools: readonly ToolDefinition[],
    readonly capabilities: readonly CapabilityDefinition[],
    readonly harnesses: readonly HarnessDefinition[],
    readonly workflows: readonly WorkflowDescriptor[],
  ) {
    this.agentsById = uniqueMap(agents, (agent) => agent.id, "agent");
    this.toolsByName = uniqueMap(tools, (tool) => tool.name, "tool");
    this.capabilitiesById = uniqueMap(
      capabilities,
      (capability) => capability.id,
      "capability",
    );
    this.harnessesByVersion = uniqueMap(
      harnesses,
      harnessKey,
      "harness version",
    );
    this.workflowsById = uniqueMap(workflows, (workflow) => workflow.id, "workflow");
    this.validateHarnesses();
    this.validateReferences();
    this.validateWorkflows();
  }

  static async load(directory: string): Promise<FileCatalog> {
    const [agentDocument, harnessDocument, toolDocument, capabilityDocument, workflowDocument] =
      await Promise.all([
      readJson<AgentDocument>(join(directory, "agents.json")),
      readJson<HarnessDocument>(join(directory, "harnesses.json")),
      readJson<ToolDocument>(join(directory, "tools.json")),
      readJson<CapabilityDocument>(join(directory, "capabilities.json")),
      readJson<WorkflowDocument>(join(directory, "workflows.json")),
    ]);
    const harnesses = requireArray(harnessDocument.harnesses, "harnesses");
    const harnessesByVersion = uniqueMap(
      harnesses,
      harnessKey,
      "harness version",
    );
    return new FileCatalog(
      requireArray(agentDocument.agents, "agents").map((agent) =>
        resolveAgentHarness(agent, harnessesByVersion),
      ),
      requireArray(toolDocument.tools, "tools"),
      requireArray(capabilityDocument.capabilities, "capabilities"),
      harnesses,
      requireArray(workflowDocument.workflows, "workflows"),
    );
  }

  list(): readonly AgentDescriptor[] {
    return this.agents;
  }

  get(id: string): AgentDescriptor {
    const agent = this.agentsById.get(id);
    if (!agent) {
      throw new Error(`Agent ${id} is not registered`);
    }
    return agent;
  }

  getTool(name: string): ToolDefinition {
    const tool = this.toolsByName.get(name);
    if (!tool) {
      throw new Error(`Tool ${name} is not registered`);
    }
    return tool;
  }

  getCapability(id: string): CapabilityDefinition {
    const capability = this.capabilitiesById.get(id);
    if (!capability) {
      throw new Error(`Capability ${id} is not registered`);
    }
    return capability;
  }

  getHarness(id: string, version: number): HarnessDefinition {
    const harness = this.harnessesByVersion.get(harnessKey({ id, version }));
    if (!harness) {
      throw new Error(`Harness ${id}@${version} is not registered`);
    }
    return harness;
  }

  listWorkflows(): readonly WorkflowDescriptor[] {
    return this.workflows;
  }

  getWorkflow(id: string): WorkflowDescriptor {
    const workflow = this.workflowsById.get(id);
    if (!workflow) {
      throw new Error(`Workflow ${id} is not registered`);
    }
    return workflow;
  }

  private validateHarnesses(): void {
    for (const harness of this.harnesses) {
      requireString(harness.id, "harness.id");
      requirePositiveInteger(harness.version, `${harness.id}.version`);
      requireString(harness.name, `${harness.id}.name`);
      requireString(harness.description, `${harness.id}.description`);
      requireString(harness.instructions, `${harness.id}.instructions`);
      for (const capability of harness.capabilities) {
        this.getCapability(capability);
      }
      for (const toolName of harness.tools) {
        const tool = this.getTool(toolName);
        if (!harness.capabilities.includes(tool.capability)) {
          throw new Error(
            `Harness ${harness.id}@${harness.version} tool ${toolName} requires capability ${tool.capability}`,
          );
        }
      }
      for (const toolName of Object.keys(harness.toolPolicy)) {
        if (!harness.tools.includes(toolName)) {
          throw new Error(
            `Harness ${harness.id}@${harness.version} policy references unavailable tool ${toolName}`,
          );
        }
      }
    }
  }

  private validateReferences(): void {
    const identitySubjects = new Set<string>();
    for (const agent of this.agents) {
      requireString(agent.id, "agent.id");
      this.getHarness(agent.harness.id, agent.harness.version);
      if (agent.runtime !== "node" && agent.runtime !== "python") {
        throw new Error(`${agent.id}.runtime must be node or python`);
      }
      requireString(agent.identity?.subject, `${agent.id}.identity.subject`);
      if (identitySubjects.has(agent.identity.subject)) {
        throw new Error(`Duplicate agent identity: ${agent.identity.subject}`);
      }
      identitySubjects.add(agent.identity.subject);
      requireString(agent.description, `${agent.id}.description`);
      requireString(agent.instructions, `${agent.id}.instructions`);
      validateModelConfiguration(agent);
      validateSandboxProfiles(agent);
      for (const capability of agent.capabilities) {
        this.getCapability(capability);
      }
      for (const toolName of agent.tools) {
        const tool = this.getTool(toolName);
        if (!agent.capabilities.includes(tool.capability)) {
          throw new Error(
            `Agent ${agent.id} tool ${toolName} requires capability ${tool.capability}`,
          );
        }
      }
    }
  }

  private validateWorkflows(): void {
    const identities = new Set(this.agents.map((agent) => agent.identity.subject));
    for (const workflow of this.workflows) {
      requireString(workflow.id, "workflow.id");
      requireString(workflow.name, `${workflow.id}.name`);
      requireString(workflow.description, `${workflow.id}.description`);
      requireString(workflow.version, `${workflow.id}.version`);
      requireString(workflow.identity?.subject, `${workflow.id}.identity.subject`);
      if (identities.has(workflow.identity.subject)) {
        throw new Error(`Duplicate catalog identity: ${workflow.identity.subject}`);
      }
      identities.add(workflow.identity.subject);
      if (workflow.kind === "review-repair") {
        this.get(workflow.configuration.repairAgentId);
      } else if (workflow.kind === "sequential") {
        this.validateSequentialWorkflow(workflow);
      } else {
        const unsupported: never = workflow;
        throw new Error(`Unsupported workflow kind: ${String(unsupported)}`);
      }
      for (const [name, input] of Object.entries(workflow.inputs)) {
        requireString(name, `${workflow.id}.inputs key`);
        requireString(input.description, `${workflow.id}.inputs.${name}.description`);
        if (typeof input.required !== "boolean") {
          throw new Error(
            `${workflow.id}.inputs.${name} must declare a boolean required value`,
          );
        }
        if (input.type === "boolean" && typeof input.default !== "boolean") {
          throw new Error(
            `${workflow.id}.inputs.${name} must declare a boolean default value`,
          );
        }
        if (
          input.type === "string" &&
          input.default !== undefined &&
          typeof input.default !== "string"
        ) {
          throw new Error(
            `${workflow.id}.inputs.${name} default must be a string`,
          );
        }
        if (input.type !== "boolean" && input.type !== "string") {
          throw new Error(
            `${workflow.id}.inputs.${name}.type must be boolean or string`,
          );
        }
      }
    }
  }

  private validateSequentialWorkflow(
    workflow: Extract<WorkflowDescriptor, { kind: "sequential" }>,
  ): void {
    if (workflow.configuration.steps.length === 0) {
      throw new Error(`${workflow.id}.configuration.steps must not be empty`);
    }
    const priorSteps = new Set<string>();
    for (const [index, step] of workflow.configuration.steps.entries()) {
      requireString(step.id, `${workflow.id}.steps[${index}].id`);
      if (priorSteps.has(step.id)) {
        throw new Error(`Duplicate workflow step: ${step.id}`);
      }
      this.get(step.agentId);
      requireString(step.task, `${workflow.id}.${step.id}.task`);
      if (index === 0 && step.workspace.source !== "clone") {
        throw new Error(`${workflow.id} first step must clone the repository`);
      }
      if (
        step.workspace.source === "step-output" &&
        !priorSteps.has(step.workspace.stepId)
      ) {
        throw new Error(
          `${workflow.id}.${step.id} references unavailable prior step ${step.workspace.stepId}`,
        );
      }
      priorSteps.add(step.id);
    }
  }
}

function resolveAgentHarness(
  agent: AgentManifest,
  harnesses: ReadonlyMap<string, HarnessDefinition>,
): AgentDescriptor {
  requireString(agent.harness?.id, `${agent.id}.harness.id`);
  requirePositiveInteger(agent.harness?.version, `${agent.id}.harness.version`);
  requireString(agent.instructions, `${agent.id}.instructions`);
  const harness = harnesses.get(harnessKey(agent.harness));
  if (!harness) {
    throw new Error(
      `Agent ${agent.id} references missing harness ${agent.harness.id}@${agent.harness.version}`,
    );
  }
  return {
    ...agent,
    instructions: `${harness.instructions.trim()}\n\n${agent.instructions.trim()}`,
    capabilities: [...harness.capabilities],
    tools: [...harness.tools],
    toolPolicy: { ...harness.toolPolicy },
  };
}

function harnessKey(reference: { id: string; version: number }): string {
  return `${reference.id}@${reference.version}`;
}

function validateSandboxProfiles(agent: AgentDescriptor): void {
  const local = agent.sandbox?.profiles?.local;
  const remote = agent.sandbox?.profiles?.remote;
  if (local?.isolation !== "container") {
    throw new Error(`${agent.id}.sandbox.profiles.local must use container isolation`);
  }
  if (remote?.isolation !== "hyper-v") {
    throw new Error(`${agent.id}.sandbox.profiles.remote must use hyper-v isolation`);
  }
  requireString(local.image, `${agent.id}.sandbox.profiles.local.image`);
  requireString(remote.poolProfile, `${agent.id}.sandbox.profiles.remote.poolProfile`);
  requirePositiveNumber(local.cpuLimit, `${agent.id}.sandbox.profiles.local.cpuLimit`);
  requirePositiveNumber(local.memoryMb, `${agent.id}.sandbox.profiles.local.memoryMb`);
  requirePositiveNumber(local.pidsLimit, `${agent.id}.sandbox.profiles.local.pidsLimit`);
  requirePositiveNumber(remote.cpuLimit, `${agent.id}.sandbox.profiles.remote.cpuLimit`);
  requirePositiveNumber(remote.memoryMb, `${agent.id}.sandbox.profiles.remote.memoryMb`);
  const expectsInternet = agent.capabilities.includes("network.internet");
  const expectsWrite = agent.capabilities.includes("workspace.write");
  for (const [name, profile] of Object.entries({ local, remote })) {
    if (expectsInternet && profile.networkMode !== "bridge") {
      throw new Error(
        `${agent.id}.sandbox.profiles.${name}.networkMode conflicts with agent capabilities`,
      );
    }
    if ((profile.workspaceAccess === "read-write") !== expectsWrite) {
      throw new Error(
        `${agent.id}.sandbox.profiles.${name}.workspaceAccess conflicts with agent capabilities`,
      );
    }
  }
}

function validateModelConfiguration(agent: AgentDescriptor): void {
  if (agent.model?.provider === "deterministic-guardrail-canary") {
    if (agent.role !== "security-test-agent") {
      throw new Error(
        `${agent.id}.model.provider deterministic-guardrail-canary requires the security-test-agent role`,
      );
    }
    return;
  }
  if (
    agent.model?.provider !== "microsoft-foundry" &&
    agent.model?.provider !== "microsoft-foundry-guardrail-probe"
  ) {
    throw new Error(`${agent.id}.model.provider is not supported`);
  }
  if (
    agent.model.provider === "microsoft-foundry-guardrail-probe" &&
    agent.role !== "security-test-agent"
  ) {
    throw new Error(
      `${agent.id}.model.provider microsoft-foundry-guardrail-probe requires the security-test-agent role`,
    );
  }
  requireString(agent.model.endpoint, `${agent.id}.model.endpoint`);
  requireString(agent.model.deployment, `${agent.id}.model.deployment`);
  if (
    agent.model.provider === "microsoft-foundry" &&
    agent.model.requireToolOnFirstTurn !== undefined &&
    typeof agent.model.requireToolOnFirstTurn !== "boolean"
  ) {
    throw new Error(`${agent.id}.model.requireToolOnFirstTurn must be a boolean`);
  }
  let endpoint: URL;
  try {
    endpoint = new URL(agent.model.endpoint);
  } catch {
    throw new Error(`${agent.id}.model.endpoint must be a valid URL`);
  }
  if (endpoint.protocol !== "https:") {
    throw new Error(`${agent.id}.model.endpoint must use HTTPS`);
  }
}

export async function loadScenario(path: string): Promise<AgentScenario> {
  const scenario = await readJson<AgentScenario>(path);
  requireString(scenario.id, "scenario.id");
  requireString(scenario.description, "scenario.description");
  requireArray(scenario.testCases, "scenario.testCases");
  const cases = uniqueMap(
    scenario.testCases,
    (testCase) => testCase.id,
    "test case",
  );
  for (const testCase of scenario.testCases) {
    validateTestCase(testCase, cases);
  }
  return scenario;
}

async function readJson<T>(path: string): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to load JSON catalog ${path}: ${message}`);
  }
}

function uniqueMap<T>(
  values: readonly T[],
  key: (value: T) => string,
  label: string,
): ReadonlyMap<string, T> {
  const result = new Map<string, T>();
  for (const value of values) {
    const id = key(value);
    requireString(id, `${label} id`);
    if (result.has(id)) {
      throw new Error(`Duplicate ${label} id: ${id}`);
    }
    result.set(id, value);
  }
  return result;
}

function requireArray<T>(value: T[] | undefined, name: string): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array`);
  }
  return value;
}

function requireString(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function requirePositiveNumber(
  value: unknown,
  name: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
}

function requirePositiveInteger(
  value: unknown,
  name: string,
): asserts value is number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function validateTestCase(
  testCase: ScenarioTestCase,
  cases: ReadonlyMap<string, ScenarioTestCase>,
): void {
  requireString(testCase.agentId, `${testCase.id}.agentId`);
  requireString(testCase.task, `${testCase.id}.task`);
  if (
    testCase.workspace.source === "test-case-output" &&
    !cases.has(testCase.workspace.testCaseId)
  ) {
    throw new Error(
      `Test case ${testCase.id} references missing output ${testCase.workspace.testCaseId}`,
    );
  }
}