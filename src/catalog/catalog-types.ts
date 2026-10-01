import type { PolicyOutcome } from "../governance/policy-engine.js";

export interface ToolDefinition {
  name: string;
  description: string;
  capability: string;
  mutatesWorkspace: boolean;
  requiresNetwork: boolean;
  defaultPolicy: PolicyOutcome;
  parameters: Record<string, unknown>;
}

export interface CapabilityDefinition {
  id: string;
  description: string;
}

export interface MicrosoftFoundryModelConfiguration {
  provider: "microsoft-foundry";
  endpoint: string;
  deployment: string;
  requireToolOnFirstTurn?: boolean;
}

export interface DeterministicGuardrailCanaryConfiguration {
  provider: "deterministic-guardrail-canary";
}

export interface MicrosoftFoundryGuardrailProbeConfiguration {
  provider: "microsoft-foundry-guardrail-probe";
  endpoint: string;
  deployment: string;
}

export type AgentModelConfiguration =
  | MicrosoftFoundryModelConfiguration
  | MicrosoftFoundryGuardrailProbeConfiguration
  | DeterministicGuardrailCanaryConfiguration;
export type AgentRuntime = "node" | "python";

export interface HarnessReference {
  id: string;
  version: number;
}

export interface HarnessDefinition extends HarnessReference {
  name: string;
  description: string;
  instructions: string;
  capabilities: string[];
  tools: string[];
  toolPolicy: Record<string, PolicyOutcome>;
}

export interface LocalSandboxProfile {
  isolation: "container";
  image: string;
  cpuLimit: number;
  memoryMb: number;
  pidsLimit: number;
  networkMode: "none" | "bridge";
  workspaceAccess: "read-only" | "read-write";
}

export interface RemoteSandboxProfile {
  isolation: "hyper-v";
  poolProfile: string;
  cpuLimit: number;
  memoryMb: number;
  networkMode: "none" | "bridge";
  workspaceAccess: "read-only" | "read-write";
}

export interface AgentDescriptor {
  id: string;
  runtime: AgentRuntime;
  harness: HarnessReference;
  identity: {
    subject: string;
  };
  name: string;
  description: string;
  version: string;
  mode: "primary" | "subagent";
  role: string;
  instructions: string;
  capabilities: string[];
  tools: string[];
  toolPolicy: Record<string, PolicyOutcome>;
  model: AgentModelConfiguration;
  sandbox: {
    profiles: {
      local: LocalSandboxProfile;
      remote: RemoteSandboxProfile;
    };
  };
}

export type WorkflowInputDefinition =
  | {
      type: "boolean";
      description: string;
      required: boolean;
      default: boolean;
    }
  | {
      type: "string";
      description: string;
      required: boolean;
      default?: string;
    };

interface WorkflowDescriptorBase {
  id: string;
  identity: {
    subject: string;
  };
  name: string;
  description: string;
  version: string;
  inputs: Record<string, WorkflowInputDefinition>;
}

export interface ReviewRepairWorkflowDescriptor extends WorkflowDescriptorBase {
  kind: "review-repair";
  configuration: {
    coderCaseId: string;
    reviewerCaseId: string;
    repairAgentId: string;
  };
}

export interface SequentialWorkflowStep {
  id: string;
  agentId: string;
  task: string;
  workspace:
    | { source: "clone" }
    | { source: "step-output"; stepId: string };
}

export interface SequentialWorkflowDescriptor extends WorkflowDescriptorBase {
  kind: "sequential";
  configuration: {
    steps: SequentialWorkflowStep[];
  };
}

export type WorkflowDescriptor =
  | ReviewRepairWorkflowDescriptor
  | SequentialWorkflowDescriptor;

export interface RepositoryDefinition {
  url: string;
  ref?: string;
}

export type ScenarioWorkspace =
  | { source: "clone" }
  | { source: "test-case-output"; testCaseId: string };

export interface ScenarioTestCase {
  id: string;
  name: string;
  description: string;
  agentId: string;
  task: string;
  workspace: ScenarioWorkspace;
}

export interface AgentScenario {
  id: string;
  name: string;
  description: string;
  repository: RepositoryDefinition;
  testCases: ScenarioTestCase[];
}

export interface AgentRegistry {
  list(): readonly AgentDescriptor[];
  get(id: string): AgentDescriptor;
}

export interface WorkflowRegistry {
  listWorkflows(): readonly WorkflowDescriptor[];
  getWorkflow(id: string): WorkflowDescriptor;
}