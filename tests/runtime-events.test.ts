import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentLoop } from "../src/agent/agent-loop.js";
import type {
  AgentMessage,
  ModelProvider,
  ModelResponse,
  ToolRequest,
  ToolResult,
} from "../src/protocol/agent-protocol.js";
import type { RuntimeEvent } from "../src/runtime/runtime-events.js";
import type { ToolExecutor } from "../src/tools/tool-gateway.js";

class EventModel implements ModelProvider {
  private turn = 0;

  async complete(_messages: readonly AgentMessage[]): Promise<ModelResponse> {
    this.turn += 1;
    return this.turn === 1
      ? {
          usage: {
            provider: "microsoft-foundry",
            model: "test-model",
            inputTokens: 10,
            outputTokens: 2,
            totalTokens: 12,
            cachedInputTokens: 4,
            reasoningTokens: 1,
          },
          toolRequest: {
            id: "read-1",
            name: "filesystem.read",
            arguments: { path: "package.json" },
          },
        }
      : {
          content: "done",
          reasoningSummary: "Validated the tool result before completing.",
        };
  }
}

class EventTool implements ToolExecutor {
  async invoke(request: ToolRequest): Promise<ToolResult> {
    return {
      toolCallId: request.id,
      success: true,
      output: "redacted content",
      telemetry: {
        policyOutcome: "ALLOW",
        policyRule: "workspace-read",
        approvalRequired: false,
        commandCount: 1,
      },
    };
  }
}

class RateLimitedModel implements ModelProvider {
  async complete(): Promise<ModelResponse> {
    throw new Error("Model request failed: 429");
  }
}

class ContentFilteredModel implements ModelProvider {
  async complete(): Promise<ModelResponse> {
    throw Object.assign(new Error("Filtered by the content policy"), {
      statusCode: 400,
      code: "content_filter",
      categories: ["jailbreak"],
      source: "prompt",
    });
  }
}

class GuardrailProbeModel implements ModelProvider {
  async complete(): Promise<ModelResponse> {
    return {
      content:
        "Azure Foundry blocked this request twice because of a guardrail. How would you like to proceed?",
      usage: {
        provider: "microsoft-foundry",
        model: "test-model",
        inputTokens: 20,
        outputTokens: 15,
        totalTokens: 35,
      },
      guardrailHits: [1, 2].map((attempt) => ({
        source: "azure-foundry" as const,
        attempt,
        statusCode: 400,
        code: "content_filter",
        innerCode: "ContentFiltered",
        categories: ["jailbreak"],
        contentSource: "prompt",
      })),
    };
  }
}

class EscapeAttemptModel implements ModelProvider {
  calls = 0;

  async complete(): Promise<ModelResponse> {
    this.calls += 1;
    return {
      toolRequest: {
        id: "escape-attempt",
        name: "security.escape_attempt",
        arguments: {},
      },
    };
  }
}

class EscapeAttemptTool implements ToolExecutor {
  async invoke(request: ToolRequest): Promise<ToolResult> {
    return {
      toolCallId: request.id,
      success: false,
      output: "Denied by policy",
      telemetry: {
        policyOutcome: "DENY",
        policyRule: "agent-policy:sandbox-escape-simulator",
        commandCount: 0,
        haltExecution: true,
        securityDetections: [
          { signal: "root-filesystem-access", boundary: "host" },
          { signal: "credential-discovery", boundary: "host" },
          { signal: "container-runtime-access", boundary: "host" },
        ],
      },
    };
  }
}

describe("runtime event stream", () => {
  it("reports model and tool progress without tool output", async () => {
    const events: RuntimeEvent[] = [];
    const agent = new AgentLoop({
      modelProvider: new EventModel(),
      toolExecutor: new EventTool(),
      placement: "remote",
      sessionId: "session-1",
      onEvent: (event) => events.push(event),
    });
    assert.equal(await agent.run("inspect"), "done");
    assert.deepEqual(
      events.map((event) => event.type),
      [
        "model.started",
        "model.completed",
        "tool.requested",
        "tool.completed",
        "model.started",
        "model.completed",
      ],
    );
    assert.equal(JSON.stringify(events).includes("redacted content"), false);
    assert.equal(events[2]?.attributes?.argumentSummary, "package.json");
    assert.equal(events[3]?.attributes?.outputBytes, 16);
    assert.equal(events[3]?.attributes?.["policy.outcome"], "ALLOW");
    assert.equal(events[3]?.attributes?.["commands.executed"], 1);
    assert.equal(typeof events[3]?.attributes?.durationMs, "number");
    assert.equal(events[5]?.attributes?.modelNote, "done");
    assert.equal(
      events[5]?.attributes?.reasoningSummary,
      "Validated the tool result before completing.",
    );
    assert.equal(events[1]?.attributes?.["execution.placement"], "remote");
    assert.equal(events[1]?.attributes?.["model.name"], "test-model");
    assert.equal(events[1]?.attributes?.["model.usage.total_tokens"], 12);
  });

  it("classifies model rate limits without recording the provider error", async () => {
    const events: RuntimeEvent[] = [];
    const agent = new AgentLoop({
      modelProvider: new RateLimitedModel(),
      toolExecutor: new EventTool(),
      sessionId: "session-rate-limit",
      onEvent: (event) => events.push(event),
    });

    await assert.rejects(agent.run("private prompt"), /429/);
    const failure = events.find((event) => event.type === "model.failed");
    assert.equal(failure?.attributes?.["error.category"], "rate_limit");
    assert.equal(failure?.attributes?.["http.status_code"], 429);
    assert.equal(JSON.stringify(failure).includes("private prompt"), false);
    assert.equal(JSON.stringify(failure).includes("Model request failed"), false);
  });

  it("classifies native Foundry content-filter failures", async () => {
    const events: RuntimeEvent[] = [];
    const agent = new AgentLoop({
      modelProvider: new ContentFilteredModel(),
      toolExecutor: new EventTool(),
      sessionId: "session-content-filter",
      onEvent: (event) => events.push(event),
    });

    await assert.rejects(agent.run("private prompt"), /content policy/);
    const failure = events.find((event) => event.type === "model.failed");
    assert.equal(failure?.attributes?.["error.category"], "content_filter");
    assert.equal(failure?.attributes?.["http.status_code"], 400);
    assert.equal(failure?.attributes?.["error.code"], "content_filter");
    assert.equal(failure?.attributes?.["guardrail.source"], "azure-foundry");
    assert.equal(failure?.attributes?.["guardrail.category"], "jailbreak");
    assert.equal(JSON.stringify(failure).includes("private prompt"), false);
  });

  it("reports each native Foundry guardrail rejection before completion", async () => {
    const events: RuntimeEvent[] = [];
    const agent = new AgentLoop({
      modelProvider: new GuardrailProbeModel(),
      toolExecutor: new EventTool(),
      sessionId: "session-guardrail-probe",
      agent: {
        id: "foundry-guardrail-simulator",
        identity: "agent://nocode/foundry-guardrail-simulator",
        harness: { id: "foundry-guardrail-probe", version: 1 },
      },
      onEvent: (event) => events.push(event),
    });

    assert.match(await agent.run("run the probe"), /How would you like to proceed/);
    const hits = events.filter(
      (event) => event.type === "model.guardrail_triggered",
    );
    assert.equal(hits.length, 2);
    assert.deepEqual(
      hits.map((event) => event.attributes?.["guardrail.attempt"]),
      [1, 2],
    );
    assert.equal(hits[0]?.attributes?.["guardrail.source"], "azure-foundry");
    assert.equal(hits[0]?.attributes?.["guardrail.category"], "jailbreak");
    assert.equal(hits[0]?.attributes?.["error.category"], "content_filter");
    assert.equal(hits[0]?.attributes?.["model.name"], "test-model");
    assert.equal(events.at(-1)?.type, "model.completed");
  });

  it("halts after reporting every bounded escape-attempt security item", async () => {
    const events: RuntimeEvent[] = [];
    const model = new EscapeAttemptModel();
    const agent = new AgentLoop({
      modelProvider: model,
      toolExecutor: new EscapeAttemptTool(),
      sessionId: "session-escape-attempt",
      agent: {
        id: "sandbox-escape-simulator",
        identity: "agent://nocode/sandbox-escape-simulator",
        harness: { id: "sandbox-escape-attempt", version: 1 },
      },
      onEvent: (event) => events.push(event),
    });

    await assert.rejects(
      agent.run("run the escape simulation"),
      /Execution halted after prohibited security\.escape_attempt request/,
    );
    assert.equal(model.calls, 1);
    const detections = events.filter(
      (event) => event.type === "security.detected",
    );
    assert.deepEqual(
      detections.map((event) => event.attributes?.signal),
      [
        "root-filesystem-access",
        "credential-discovery",
        "container-runtime-access",
      ],
    );
    assert.ok(
      detections.every(
        (event) => event.attributes?.["commands.executed"] === 0,
      ),
    );
  });
});