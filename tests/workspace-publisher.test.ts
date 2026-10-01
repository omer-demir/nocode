import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ProcessRunner,
  ProcessRunOptions,
  ProcessRunResult,
} from "../src/sandbox/process-runner.js";
import { GitWorkspacePublisher } from "../src/tui/workspace-publisher.js";

class RecordingGitRunner implements ProcessRunner {
  readonly calls: readonly string[][] = [];

  constructor(private readonly changed = true) {}

  async run(
    executable: string,
    args: readonly string[],
    _options: ProcessRunOptions,
  ): Promise<ProcessRunResult> {
    (this.calls as string[][]).push([executable, ...args]);
    const command = args.at(-1);
    const stdout = args.includes("status")
      ? this.changed
        ? " M src/index.ts\n"
        : ""
      : command === "HEAD"
        ? "0123456789abcdef0123456789abcdef01234567\n"
        : "";
    return {
      exitCode: 0,
      stdout,
      stderr: "",
      durationMs: 1,
      truncated: false,
    };
  }
}

describe("Git workspace publisher", () => {
  it("commits and pushes the persisted delta to the requested branch", async () => {
    const runner = new RecordingGitRunner();
    const publisher = new GitWorkspacePublisher(runner);

    const result = await publisher.publish({
      workspacePath: "/workspace",
      branch: "agent/vue-migration",
      sessionId: "12345678-abcd",
    });

    assert.deepEqual(result, {
      branch: "agent/vue-migration",
      commit: "0123456789abcdef0123456789abcdef01234567",
    });
    assert.deepEqual(runner.calls.at(-1), [
      "git",
      "-C",
      "/workspace",
      "push",
      "--set-upstream",
      "origin",
      "HEAD:refs/heads/agent/vue-migration",
    ]);
    assert.ok(
      runner.calls.some((call) =>
        call.includes("Publish agent session 12345678"),
      ),
    );
  });

  it("does not create a branch when the workspace has no delta", async () => {
    const runner = new RecordingGitRunner(false);
    const publisher = new GitWorkspacePublisher(runner);

    await assert.rejects(
      publisher.publish({
        workspacePath: "/workspace",
        branch: "agent/no-change",
        sessionId: "12345678-abcd",
      }),
      /no changes to publish/,
    );
    assert.equal(runner.calls.some((call) => call.includes("switch")), false);
  });
});