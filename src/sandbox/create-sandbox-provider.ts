import { AzureContainerAppsSessionPoolProvider } from "./azure-container-apps-session-pool-provider.js";
import { LocalDockerSandboxProvider } from "./local-docker-sandbox-provider.js";
import type { SandboxProvider } from "./sandbox-provider.js";

export type SandboxPlacement = SandboxProvider["placement"];

export function createSandboxProvider(
  environment: NodeJS.ProcessEnv = process.env,
): SandboxProvider {
  const provider = environment.NOCODE_SANDBOX_PROVIDER ?? "local-docker";
  if (provider === "local-docker") {
    return new LocalDockerSandboxProvider();
  }
  if (provider === "azure-container-apps-session-pool") {
    const endpoint = environment.AZURE_CONTAINER_APPS_SESSION_POOL_ENDPOINT;
    if (!endpoint) {
      throw new Error(
        "AZURE_CONTAINER_APPS_SESSION_POOL_ENDPOINT is required for the Azure session pool provider",
      );
    }
    return new AzureContainerAppsSessionPoolProvider({
      endpoint,
      networkMode: parseNetworkMode(
        environment.AZURE_CONTAINER_APPS_SESSION_POOL_NETWORK_MODE ?? "none",
      ),
      poolProfile:
        environment.AZURE_CONTAINER_APPS_SESSION_POOL_PROFILE ??
        "node-hyperv-1cpu-2gi-egress",
      cpuLimit: parsePositiveNumber(
        environment.AZURE_CONTAINER_APPS_SESSION_POOL_CPU_LIMIT ?? "1",
        "AZURE_CONTAINER_APPS_SESSION_POOL_CPU_LIMIT",
      ),
      memoryMb: parsePositiveNumber(
        environment.AZURE_CONTAINER_APPS_SESSION_POOL_MEMORY_MB ?? "2048",
        "AZURE_CONTAINER_APPS_SESSION_POOL_MEMORY_MB",
      ),
    });
  }
  throw new Error(`Unknown sandbox provider: ${provider}`);
}

export function createSandboxProviderForPlacement(
  placement: SandboxPlacement,
  environment: NodeJS.ProcessEnv = process.env,
): SandboxProvider {
  if (placement === "local") {
    return new LocalDockerSandboxProvider();
  }
  return createSandboxProvider({
    ...environment,
    NOCODE_SANDBOX_PROVIDER: "azure-container-apps-session-pool",
  });
}

export function createSandboxProviderForProfile(
  poolProfile: string,
  environment: NodeJS.ProcessEnv = process.env,
): SandboxProvider {
  if (
    (environment.NOCODE_SANDBOX_PROVIDER ?? "local-docker") !==
    "azure-container-apps-session-pool"
  ) {
    return createSandboxProvider(environment);
  }
  const poolMap = environment.AZURE_CONTAINER_APPS_SESSION_POOLS;
  if (!poolMap) {
    return createSandboxProvider(environment);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(poolMap);
  } catch {
    throw new Error("AZURE_CONTAINER_APPS_SESSION_POOLS must be valid JSON");
  }
  if (!isRecord(parsed)) {
    throw new Error("AZURE_CONTAINER_APPS_SESSION_POOLS must be a JSON object");
  }
  const selected = parsed[poolProfile];
  if (!isRecord(selected)) {
    throw new Error(`No Azure session pool is configured for ${poolProfile}`);
  }
  return new AzureContainerAppsSessionPoolProvider({
    endpoint: requireString(selected.endpoint, `${poolProfile}.endpoint`),
    networkMode: parseNetworkMode(
      requireString(selected.networkMode, `${poolProfile}.networkMode`),
    ),
    poolProfile,
    cpuLimit: parsePositiveNumber(
      String(selected.cpuLimit),
      `${poolProfile}.cpuLimit`,
    ),
    memoryMb: parsePositiveNumber(
      String(selected.memoryMb),
      `${poolProfile}.memoryMb`,
    ),
  });
}

function parsePositiveNumber(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return parsed;
}

function parseNetworkMode(value: string): "none" | "bridge" {
  if (value !== "none" && value !== "bridge") {
    throw new Error(
      "AZURE_CONTAINER_APPS_SESSION_POOL_NETWORK_MODE must be none or bridge",
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}