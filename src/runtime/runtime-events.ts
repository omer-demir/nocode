import { recordRuntimeTelemetry } from "../telemetry/runtime-telemetry.js";

export const runtimeEventTypes = [
  "session.started",
  "session.completed",
  "session.cancelled",
  "session.failed",
  "sandbox.created",
  "sandbox.terminated",
  "model.started",
  "model.completed",
  "model.failed",
  "model.guardrail_triggered",
  "security.detected",
  "tool.requested",
  "tool.completed",
  "approval.requested",
  "approval.resolved",
] as const;

export type RuntimeEventType = (typeof runtimeEventTypes)[number];

export interface RuntimeEvent {
  type: RuntimeEventType;
  timestamp: string;
  sessionId: string;
  message: string;
  attributes?: Readonly<Record<string, string | number | boolean>>;
}

export type RuntimeEventSink = (event: RuntimeEvent) => void;

export function runtimeEvent(
  type: RuntimeEventType,
  sessionId: string,
  message: string,
  attributes?: Readonly<Record<string, string | number | boolean>>,
): RuntimeEvent {
  const event: RuntimeEvent = {
    type,
    timestamp: new Date().toISOString(),
    sessionId,
    message,
    ...(attributes === undefined ? {} : { attributes }),
  };
  recordRuntimeTelemetry(event);
  return event;
}