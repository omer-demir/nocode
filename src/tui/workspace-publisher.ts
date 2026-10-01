import type { ProcessRunner } from "../sandbox/process-runner.js";
import { SpawnProcessRunner } from "../sandbox/process-runner.js";

const GIT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 1_048_576;

export interface PublishWorkspaceResult {
  branch: string;
  commit: string;
}

export interface WorkspacePublisher {
  publish(input: {
    workspacePath: string;
    branch: string;
    sessionId: string;
  }): Promise<PublishWorkspaceResult>;
}

export class GitWorkspacePublisher implements WorkspacePublisher {
  constructor(private readonly runner: ProcessRunner = new SpawnProcessRunner()) {}

  async publish(input: {
    workspacePath: string;
    branch: string;
    sessionId: string;
  }): Promise<PublishWorkspaceResult> {
    await this.git(undefined, ["check-ref-format", "--branch", input.branch]);
    const status = await this.git(input.workspacePath, ["status", "--porcelain"]);
    if (!status.stdout.trim()) {
      throw new Error("The session workspace has no changes to publish");
    }

    await this.git(input.workspacePath, ["switch", "-c", input.branch]);
    await this.git(input.workspacePath, ["add", "--all"]);
    await this.git(input.workspacePath, [
      "-c",
      "user.name=NoCode Agent",
      "-c",
      "user.email=nocode-agent@users.noreply.github.com",
      "commit",
      "-m",
      `Publish agent session ${input.sessionId.slice(0, 8)}`,
    ]);
    const commit = (
      await this.git(input.workspacePath, ["rev-parse", "HEAD"])
    ).stdout.trim();
    await this.git(input.workspacePath, [
      "push",
      "--set-upstream",
      "origin",
      `HEAD:refs/heads/${input.branch}`,
    ]);
    return { branch: input.branch, commit };
  }

  private async git(
    workspacePath: string | undefined,
    args: readonly string[],
  ): Promise<{ stdout: string }> {
    const gitArgs =
      workspacePath === undefined ? args : ["-C", workspacePath, ...args];
    const result = await this.runner.run("git", gitArgs, {
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        result.stderr.trim() || result.stdout.trim() || "Git command failed",
      );
    }
    return { stdout: result.stdout };
  }
}