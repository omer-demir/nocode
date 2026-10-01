import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseTuiCommand } from "../src/tui/commands.js";
import { TuiSessionStore } from "../src/tui/session-store.js";
import {
  runtimeEvent,
  runtimeEventTypes,
} from "../src/runtime/runtime-events.js";

describe("TUI commands", () => {
  it("parses registry, alias, test, attach, and approval commands", () => {
    assert.deepEqual(parseTuiCommand("/agent list"), { kind: "agent.list" });
    assert.deepEqual(
      parseTuiCommand("/vue-migrator https://github.com/omer-demir/LastHour"),
      {
        kind: "agent.launch",
        agentRef: "vue-migrator",
        repositoryUrl: "https://github.com/omer-demir/LastHour",
      },
    );
    assert.deepEqual(parseTuiCommand("/test run testcase-3"), {
      kind: "test.run",
      testCaseId: "testcase-3",
    });
    assert.deepEqual(parseTuiCommand("/workflow list"), {
      kind: "workflow.list",
    });
    assert.deepEqual(
      parseTuiCommand(
        "/workflow run review-repair https://github.com/example/repo.git fresh",
      ),
      {
      kind: "workflow.run",
      workflowId: "review-repair",
      repositoryUrl: "https://github.com/example/repo.git",
      fresh: true,
      },
    );
    assert.deepEqual(
      parseTuiCommand(
        "/workflow review-repair https://github.com/example/repo.git fresh",
      ),
      {
      kind: "workflow.run",
      workflowId: "review-repair",
      repositoryUrl: "https://github.com/example/repo.git",
      fresh: true,
      },
    );
    assert.deepEqual(parseTuiCommand("/attach abc123"), {
      kind: "session.attach",
      sessionId: "abc123",
    });
    assert.deepEqual(parseTuiCommand("/session attach abc123"), {
      kind: "session.attach",
      sessionId: "abc123",
    });
    assert.deepEqual(
      parseTuiCommand('/session message abc123 "Add integration tests"'),
      {
        kind: "session.message",
        sessionId: "abc123",
        message: "Add integration tests",
      },
    );
    assert.deepEqual(
      parseTuiCommand(
        '/session run-agent abc123 offline-reviewer "Review current changes"',
      ),
      {
        kind: "session.run-agent",
        sessionId: "abc123",
        agentRef: "offline-reviewer",
        task: "Review current changes",
      },
    );
    assert.deepEqual(parseTuiCommand("/session history abc123"), {
      kind: "session.history",
      sessionId: "abc123",
    });
    assert.deepEqual(
      parseTuiCommand(
        "/session publish abc123 --branch agent/vue-migration",
      ),
      {
        kind: "session.publish",
        sessionId: "abc123",
        branch: "agent/vue-migration",
      },
    );
    assert.deepEqual(parseTuiCommand("/approve abc123"), {
      kind: "approval.resolve",
      sessionId: "abc123",
      approved: true,
    });
    assert.deepEqual(parseTuiCommand("/allow-all abc123"), {
      kind: "approval.resolve",
      sessionId: "abc123",
      approved: true,
      remember: true,
    });
    assert.deepEqual(parseTuiCommand("/deny-all abc123"), {
      kind: "approval.resolve",
      sessionId: "abc123",
      approved: false,
      remember: true,
    });
    assert.deepEqual(parseTuiCommand("/continue abc123"), {
      kind: "iteration.resolve",
      sessionId: "abc123",
      continue: true,
    });
    assert.deepEqual(parseTuiCommand("/stop abc123"), {
      kind: "iteration.resolve",
      sessionId: "abc123",
      continue: false,
    });
  });
});

describe("TUI session store", () => {
  it("retains attachable event history and resolves session prefixes", async () => {
    const store = await TuiSessionStore.open();
    store.create({
      id: "abc12345",
      agentId: "vue-migration-coder",
      agentName: "Vue Migration Coder",
      repositoryUrl: "https://github.com/omer-demir/LastHour",
      placement: "local",
      status: "queued",
    });
    store.appendEvent(
      runtimeEvent("session.started", "abc12345", "Agent session started"),
    );
    store.attach("abc12345");
    assert.equal(store.resolveId("abc"), "abc12345");
    assert.equal(store.snapshot().attachedSessionId, "abc12345");
    assert.equal(store.snapshot().sessions[0]?.events.length, 1);
  });

  it("restores completed sessions from an atomic local store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nocode-tui-store-"));
    const path = join(directory, "sessions.json");
    try {
      const store = await TuiSessionStore.open(path);
      store.create({
        id: "persisted-session",
        agentId: "vue-migration-coder",
        agentName: "Vue Migration Coder",
        repositoryUrl: "https://github.com/omer-demir/LastHour",
        placement: "remote",
        status: "queued",
      });
      store.update("persisted-session", {
        status: "completed",
        summary: "Migration completed",
        workspacePath: "/tmp/workspace",
      });
      store.appendRun("persisted-session", {
        id: "run-1",
        kind: "workflow-step",
        label: "implement",
        agentId: "vue-migration-coder",
        summary: "Migration completed",
        workspacePath: "/tmp/workspace",
        status: "completed",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:01:00.000Z",
      });
      store.attach("persisted-session");
      await store.flush();

      const document = JSON.parse(await readFile(path, "utf8")) as {
        version: number;
      };
      assert.equal(document.version, 1);
      const restored = await TuiSessionStore.open(path);
      assert.equal(restored.snapshot().sessions[0]?.status, "completed");
      assert.equal(restored.snapshot().sessions[0]?.summary, "Migration completed");
      assert.equal(restored.snapshot().sessions[0]?.runs[0]?.label, "implement");
      assert.equal(restored.snapshot().attachedSessionId, "persisted-session");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("restores every registered runtime event type", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nocode-tui-store-"));
    const path = join(directory, "sessions.json");
    try {
      const store = await TuiSessionStore.open(path);
      store.create({
        id: "runtime-events-session",
        agentId: "sandbox-escape-simulator",
        agentName: "Sandbox Escape Simulator",
        repositoryUrl: "https://github.com/omer-demir/LastHour",
        placement: "remote",
        status: "failed",
      });
      for (const type of runtimeEventTypes) {
        store.appendEvent(
          runtimeEvent(type, "runtime-events-session", `Recorded ${type}`),
        );
      }
      await store.flush();

      const restored = await TuiSessionStore.open(path);
      assert.deepEqual(
        restored.snapshot().sessions[0]?.events.map((event) => event.type),
        runtimeEventTypes,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("marks an active restored session as interrupted", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nocode-tui-store-"));
    const path = join(directory, "sessions.json");
    try {
      const store = await TuiSessionStore.open(path);
      store.create({
        id: "interrupted-session",
        agentId: "vue-migration-coder",
        agentName: "Vue Migration Coder",
        repositoryUrl: "https://github.com/omer-demir/LastHour",
        placement: "remote",
        status: "running",
      });
      await store.flush();

      const restored = await TuiSessionStore.open(path);
      assert.equal(restored.snapshot().sessions[0]?.status, "failed");
      assert.match(restored.snapshot().sessions[0]?.error ?? "", /ended/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});