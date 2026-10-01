import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { DemoModelProvider } from "../src/agent/demo-model-provider.js";
import { runAgentSession } from "../src/agent/session.js";
import {
  FixedApprovalHandler,
  StaticPolicyEngine,
} from "../src/governance/policy-engine.js";
import { LocalDockerSandboxProvider } from "../src/sandbox/local-docker-sandbox-provider.js";
import { startTelemetry } from "../src/telemetry/telemetry.js";

describe("governed agent vertical slice", () => {
  it("defaults unknown tools to deny and writes to approval", async () => {
    const policy = new StaticPolicyEngine();
    const unknown = await policy.evaluate({
      id: "unknown",
      name: "shell.execute",
      arguments: {},
    });
    const write = await policy.evaluate({
      id: "write",
      name: "filesystem.write",
      arguments: {},
    });
    assert.equal(unknown.outcome, "DENY");
    assert.equal(write.outcome, "ASK");
  });

  it(
    "runs CLI-to-Docker read, search, write, and test flow",
    { skip: process.env.RUN_DOCKER_TESTS !== "1", timeout: 120_000 },
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), "nocode-agent-"));
      const telemetry = startTelemetry("vertical-slice-test");
      await chmod(workspace, 0o777);
      await writeFile(
        join(workspace, "package.json"),
        JSON.stringify({
          name: "vertical-slice-fixture",
          scripts: { test: "node test.js" },
        }),
      );
      await writeFile(
        join(workspace, "test.js"),
        "require('node:fs').accessSync('.nocode-demo.txt'); console.log('tests passed');\n",
      );

      try {
        const summary = await runAgentSession({
          task: "Prove the vertical slice",
          workspacePath: workspace,
          modelProvider: new DemoModelProvider(),
          sandboxProvider: new LocalDockerSandboxProvider(),
          approvalHandler: new FixedApprovalHandler(true),
        });
        assert.match(summary, /read, search, write, and test/);
        assert.match(
          await readFile(join(workspace, ".nocode-demo.txt"), "utf8"),
          /Prove the vertical slice/,
        );
      } finally {
        await telemetry.shutdown();
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});