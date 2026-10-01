import { randomUUID } from "node:crypto";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import { runtimeEvent } from "../runtime/runtime-events.js";
import { startTelemetry } from "./telemetry.js";

const sdk = startTelemetry("agentctl");
const tracer = trace.getTracer("nocode.agent");
let traceId = "";
const sessionId = randomUUID();

runtimeEvent("session.started", sessionId, "Agent session started", {
  agentId: "smoke-agent",
});
runtimeEvent("model.completed", sessionId, "Model turn 1 completed", {
  iteration: 1,
});
runtimeEvent("tool.completed", sessionId, "Tool shell completed", {
  success: true,
});

await tracer.startActiveSpan("agent.session", async (span) => {
  traceId = span.spanContext().traceId;
  span.setAttributes({
    "agent.id": "smoke-agent",
    "agent.version": "0.1.0",
    "session.id": sessionId,
    "task.id": "otel-baseline",
  });
  span.setStatus({ code: SpanStatusCode.OK });
  span.end();
});

runtimeEvent("session.completed", sessionId, "Agent session completed");
await sdk.shutdown();
console.log(`Emitted runtime telemetry and agent.session trace ${traceId}`);