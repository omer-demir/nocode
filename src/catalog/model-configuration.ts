import type {
  AgentModelConfiguration,
  MicrosoftFoundryGuardrailProbeConfiguration,
  MicrosoftFoundryModelConfiguration,
} from "./catalog-types.js";

type FoundryModelConfiguration =
  | MicrosoftFoundryModelConfiguration
  | MicrosoftFoundryGuardrailProbeConfiguration;

export function resolveAgentModelConfiguration(
  configuration: MicrosoftFoundryModelConfiguration,
  environment?: NodeJS.ProcessEnv,
): MicrosoftFoundryModelConfiguration;
export function resolveAgentModelConfiguration(
  configuration: FoundryModelConfiguration,
  environment?: NodeJS.ProcessEnv,
): FoundryModelConfiguration;
export function resolveAgentModelConfiguration(
  configuration: AgentModelConfiguration,
  environment?: NodeJS.ProcessEnv,
): AgentModelConfiguration;
export function resolveAgentModelConfiguration(
  configuration: AgentModelConfiguration,
  environment: NodeJS.ProcessEnv = process.env,
): AgentModelConfiguration {
  if (configuration.provider === "deterministic-guardrail-canary") {
    return configuration;
  }
  return {
    provider: configuration.provider,
    endpoint: environment.FOUNDRY_RESPONSES_ENDPOINT ?? configuration.endpoint,
    deployment: environment.FOUNDRY_MODEL ?? configuration.deployment,
    ...(configuration.provider !== "microsoft-foundry" ||
    configuration.requireToolOnFirstTurn === undefined
      ? {}
      : { requireToolOnFirstTurn: configuration.requireToolOnFirstTurn }),
  };
}