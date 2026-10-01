export interface SandboxConfig {
  workspacePath: string;
  isolation?: "container" | "hyper-v";
  poolProfile?: string;
  image?: string;
  cpuLimit?: number;
  memoryMb?: number;
  pidsLimit?: number;
  networkMode?: "none" | "bridge";
  workspaceAccess?: "read-only" | "read-write";
  environment?: Readonly<Record<string, string>>;
}

export interface SandboxReference {
  id: string;
  provider: "local-docker" | "azure-container-apps-session-pool";
}

export interface ExecuteCommand {
  sandboxId: string;
  command: readonly [string, ...string[]];
  stdin?: string;
  timeoutMs?: number;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
}

export interface SandboxProvider {
  readonly placement: "local" | "remote";
  create(config: SandboxConfig): Promise<SandboxReference>;
  execute(input: ExecuteCommand): Promise<CommandResult>;
  terminate(sandboxId: string): Promise<void>;
}