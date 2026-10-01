import { logs, SeverityNumber } from "@opentelemetry/api-logs";
import { metrics } from "@opentelemetry/api";
import type { RuntimeEvent } from "../runtime/runtime-events.js";

function createRuntimeInstruments() {
  const meter = metrics.getMeter("nocode.runtime");
  return {
    activeSessions: meter.createUpDownCounter("nocode.sessions.active", {
      description: "Active governed agent sessions",
      unit: "{session}",
    }),
    logger: logs.getLogger("nocode.runtime"),
    commandsExecuted: meter.createCounter("nocode.commands.executed", {
      description: "Fixed sandbox commands executed by governed tools",
    }),
    guardrailHits: meter.createCounter("nocode.governance.guardrail_hits", {
      description: "Tool requests blocked by policy or denied approval",
    }),
    modelGuardrailHits: meter.createCounter("nocode.model.guardrail_hits", {
      description: "Model requests blocked by provider-native guardrails",
    }),
    modelCachedInputTokens: meter.createCounter(
      "nocode.model.cached_input_tokens",
      {
        description: "Cached input tokens used by remote model turns",
        unit: "{token}",
      },
    ),
    modelDuration: meter.createHistogram("nocode.model.duration", {
      description: "Remote model turn duration",
      unit: "ms",
    }),
    modelEstimatedCost: meter.createCounter("nocode.model.estimated_cost_usd", {
      description: "Estimated model cost when token pricing is configured",
    }),
    modelFixedInputBytes: meter.createCounter("nocode.model.fixed_input_bytes", {
      description: "System instructions and tool schema bytes sent to models",
    }),
    modelInputTokens: meter.createCounter("nocode.model.input_tokens", {
      description: "Input tokens used by remote model turns",
      unit: "{token}",
    }),
    modelOutputTokens: meter.createCounter("nocode.model.output_tokens", {
      description: "Output tokens used by remote model turns",
      unit: "{token}",
    }),
    modelReasoningTokens: meter.createCounter(
      "nocode.model.reasoning_tokens",
      {
        description: "Reasoning tokens used by remote model turns",
        unit: "{token}",
      },
    ),
    modelRequestBytes: meter.createCounter("nocode.model.request_bytes", {
      description: "Serialized model request bytes",
    }),
    modelTotalTokens: meter.createCounter("nocode.model.total_tokens", {
      description: "Total tokens used by remote model turns",
      unit: "{token}",
    }),
    modelTurns: meter.createCounter("nocode.model.turns", {
      description: "Completed model turns",
      unit: "{turn}",
    }),
    modelUserInputCharacters: meter.createCounter(
      "nocode.model.user_input_characters",
      { description: "User-authored characters included in model requests" },
    ),
    policyDecisions: meter.createCounter("nocode.governance.policy_decisions", {
      description: "Governance policy decisions by outcome and rule",
    }),
    promptCount: meter.createCounter("nocode.prompts", {
      description: "User tasks submitted to governed agent sessions",
    }),
    promptSize: meter.createHistogram("nocode.prompt.size_characters", {
      description: "User task size in Unicode characters",
    }),
    rateLimitHits: meter.createCounter("nocode.rate_limit_hits", {
      description: "Rate-limit responses observed from platform dependencies",
    }),
    repositoryFilesChanged: meter.createCounter(
      "nocode.repository.files_changed",
      { description: "Distinct path fingerprints written per session" },
    ),
    repositoryWrites: meter.createCounter("nocode.repository.write_operations", {
      description: "Workspace write operations requested by agents",
    }),
    runtimeEvents: meter.createCounter("nocode.runtime.events", {
      description: "Runtime lifecycle events",
      unit: "{event}",
    }),
    sessionDuration: meter.createHistogram("nocode.sessions.duration", {
      description: "Governed agent session duration",
      unit: "ms",
    }),
    securityDetections: meter.createCounter("nocode.security.detections", {
      description: "Potential rogue-agent signals blocked by policy",
    }),
    toolInvocations: meter.createCounter("nocode.tool.invocations", {
      description: "Completed tool invocations",
      unit: "{invocation}",
    }),
    toolOutputBytes: meter.createCounter("nocode.tool.output_bytes", {
      description: "Sanitized aggregate size of tool results by tool",
    }),
  };
}

let runtimeInstruments:
  | ReturnType<typeof createRuntimeInstruments>
  | undefined;
const sessionStartTimes = new Map<string, number>();
const sessionWriteTargets = new Map<string, Set<string>>();

export function recordRuntimeTelemetry(event: RuntimeEvent): void {
  runtimeInstruments ??= createRuntimeInstruments();
  const {
    activeSessions,
    commandsExecuted,
    guardrailHits,
    logger,
    modelCachedInputTokens,
    modelDuration,
    modelEstimatedCost,
    modelFixedInputBytes,
    modelInputTokens,
    modelGuardrailHits,
    modelOutputTokens,
    modelReasoningTokens,
    modelRequestBytes,
    modelTotalTokens,
    modelTurns,
    modelUserInputCharacters,
    policyDecisions,
    promptCount,
    promptSize,
    rateLimitHits,
    repositoryFilesChanged,
    repositoryWrites,
    runtimeEvents,
    sessionDuration,
    securityDetections,
    toolInvocations,
    toolOutputBytes,
  } = runtimeInstruments;
  runtimeEvents.add(1, { "event.type": event.type });
  const securityDetection = event.type === "security.detected";
  logger.emit({
    severityNumber:
      event.type === "session.failed"
        ? SeverityNumber.ERROR
        : securityDetection
          ? SeverityNumber.WARN
        : SeverityNumber.INFO,
    severityText:
      event.type === "session.failed"
        ? "ERROR"
        : securityDetection
          ? "WARN"
          : "INFO",
    body: event.message,
    attributes: {
      "event.type": event.type,
      "session.id": event.sessionId,
      ...runtimeLogIdentity(event),
    },
    timestamp: new Date(event.timestamp),
  });

  if (event.type === "session.started") {
    sessionStartTimes.set(event.sessionId, Date.now());
    sessionWriteTargets.set(event.sessionId, new Set());
    activeSessions.add(1);
    promptCount.add(1, identityDimensions(event));
    const promptCharacters = numberAttribute(event, "prompt.characters");
    if (promptCharacters !== undefined) {
      promptSize.record(promptCharacters, identityDimensions(event));
    }
  } else if (
    event.type === "session.completed" ||
    event.type === "session.cancelled" ||
    event.type === "session.failed"
  ) {
    const startedAt = sessionStartTimes.get(event.sessionId);
    if (startedAt !== undefined) {
      sessionDuration.record(Date.now() - startedAt, {
        outcome:
          event.type === "session.completed"
            ? "completed"
            : event.type === "session.cancelled"
              ? "cancelled"
              : "failed",
      });
      activeSessions.add(-1);
      sessionStartTimes.delete(event.sessionId);
    }
    const writeTargets = sessionWriteTargets.get(event.sessionId);
    if (writeTargets !== undefined) {
      repositoryFilesChanged.add(writeTargets.size, identityDimensions(event));
      sessionWriteTargets.delete(event.sessionId);
    }
  } else if (event.type === "model.completed") {
    const dimensions = modelDimensions(event);
    modelTurns.add(1, dimensions);
    if (numberAttribute(event, "model.usage.total_tokens") !== undefined) {
      recordCounter(
        modelInputTokens,
        event,
        "model.usage.input_tokens",
        dimensions,
      );
      recordCounter(
        modelOutputTokens,
        event,
        "model.usage.output_tokens",
        dimensions,
      );
      recordCounter(
        modelTotalTokens,
        event,
        "model.usage.total_tokens",
        dimensions,
      );
      recordCounter(
        modelCachedInputTokens,
        event,
        "model.usage.cached_input_tokens",
        dimensions,
      );
      recordCounter(
        modelReasoningTokens,
        event,
        "model.usage.reasoning_tokens",
        dimensions,
      );
      const durationMs = numberAttribute(event, "durationMs");
      if (durationMs !== undefined) {
        modelDuration.record(durationMs, dimensions);
      }
      recordCounter(
        modelFixedInputBytes,
        event,
        "model.context.fixed_input_bytes",
        dimensions,
      );
      recordCounter(
        modelRequestBytes,
        event,
        "model.context.request_bytes",
        dimensions,
      );
      recordCounter(
        modelUserInputCharacters,
        event,
        "model.context.user_input_characters",
        dimensions,
      );
      recordCounter(
        modelEstimatedCost,
        event,
        "model.usage.estimated_cost_usd",
        dimensions,
      );
    }
  } else if (event.type === "model.failed") {
    if (stringAttribute(event, "error.category") === "rate_limit") {
      rateLimitHits.add(1, {
        ...identityDimensions(event),
        source: "model-provider",
      });
    } else if (stringAttribute(event, "error.category") === "content_filter") {
      modelGuardrailHits.add(1, {
        ...identityDimensions(event),
        source: stringAttribute(event, "guardrail.source") ?? "azure-foundry",
        category: stringAttribute(event, "guardrail.category") ?? "unknown",
        "content.source":
          stringAttribute(event, "guardrail.content_source") ?? "unknown",
        "model.name": "unknown",
        "model.provider": "microsoft-foundry",
      });
    }
  } else if (event.type === "model.guardrail_triggered") {
    modelGuardrailHits.add(1, {
      ...identityDimensions(event),
      source: stringAttribute(event, "guardrail.source") ?? "unknown",
      category: stringAttribute(event, "guardrail.category") ?? "unknown",
      "content.source":
        stringAttribute(event, "guardrail.content_source") ?? "unknown",
      "model.name": stringAttribute(event, "model.name") ?? "unknown",
      "model.provider":
        stringAttribute(event, "model.provider") ?? "unknown",
    });
  } else if (event.type === "security.detected") {
    securityDetections.add(1, {
      ...identityDimensions(event),
      signal: stringAttribute(event, "signal") ?? "unknown",
      boundary: stringAttribute(event, "boundary") ?? "unknown",
      rule: "agent-policy",
    });
  } else if (event.type === "tool.requested") {
    if (stringAttribute(event, "toolName") === "filesystem.write") {
      repositoryWrites.add(1, identityDimensions(event));
      const pathHash = stringAttribute(event, "targetPathHash");
      if (pathHash !== undefined) {
        sessionWriteTargets.get(event.sessionId)?.add(pathHash);
      }
    }
  } else if (event.type === "tool.completed") {
    const toolName = stringAttribute(event, "toolName") ?? "unknown";
    const success = event.attributes?.success === true;
    toolInvocations.add(1, { success, "tool.name": toolName });
    const outputBytes = numberAttribute(event, "outputBytes");
    if (outputBytes !== undefined) {
      toolOutputBytes.add(outputBytes, { "tool.name": toolName, success });
    }
    const commandCount = numberAttribute(event, "commands.executed");
    if (commandCount !== undefined) {
      commandsExecuted.add(commandCount, { "tool.name": toolName });
    }
    const policyOutcome = stringAttribute(event, "policy.outcome");
    const policyRule = stringAttribute(event, "policy.rule") ?? "unknown";
    if (policyOutcome !== undefined) {
      policyDecisions.add(1, {
        ...identityDimensions(event),
        outcome: policyOutcome,
        rule: boundedRule(policyRule),
        "tool.name": toolName,
      });
    }
    const approvalDenied =
      event.attributes?.["approval.required"] === true &&
      event.attributes?.["approval.granted"] === false;
    if (policyOutcome === "DENY" || approvalDenied) {
      guardrailHits.add(1, {
        ...identityDimensions(event),
        reason: policyOutcome === "DENY" ? "policy-deny" : "approval-deny",
        rule: boundedRule(policyRule),
      });
    }
    if (policyOutcome === "DENY" && toolName !== "security.escape_attempt") {
      securityDetections.add(1, {
        ...identityDimensions(event),
        signal: securitySignal(policyRule),
        rule: boundedRule(policyRule),
      });
    }
    if (stringAttribute(event, "error.category") === "rate_limit") {
      rateLimitHits.add(1, {
        ...identityDimensions(event),
        source:
          stringAttribute(event, "rate_limit.source") ?? "sandbox-provider",
      });
    }
  }
}

function identityDimensions(event: RuntimeEvent): Record<string, string> {
  return {
    "agent.id": stringAttribute(event, "agent.id") ?? "unknown",
    "agent.identity": stringAttribute(event, "agent.identity") ?? "unknown",
  };
}

function modelDimensions(event: RuntimeEvent): Record<string, string> {
  return {
    ...identityDimensions(event),
    "harness.id": stringAttribute(event, "harness.id") ?? "unknown",
    "harness.version": String(
      numberAttribute(event, "harness.version") ?? "unknown",
    ),
    "model.name": stringAttribute(event, "model.name") ?? "unknown",
    "model.provider": stringAttribute(event, "model.provider") ?? "unknown",
  };
}

function boundedRule(rule: string): string {
  return rule.startsWith("agent-policy:") ? "agent-policy" : rule;
}

function securitySignal(rule: string): string {
  if (rule === "agent-tool-allowlist" || rule === "default-deny") {
    return "unauthorized-tool";
  }
  if (rule === "network-capability-required") return "network-violation";
  if (rule === "capability-required") return "missing-capability";
  return "policy-violation";
}

function runtimeLogIdentity(
  event: RuntimeEvent,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const name of [
    "agent.id",
    "agent.identity",
    "agent.version",
    "agent.role",
    "harness.id",
    "harness.version",
  ]) {
    const value = event.attributes?.[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function recordCounter(
  counter: { add(value: number, attributes?: Record<string, string>): void },
  event: RuntimeEvent,
  name: string,
  dimensions: Record<string, string>,
): void {
  const value = numberAttribute(event, name);
  if (value !== undefined) {
    counter.add(value, dimensions);
  }
}

function numberAttribute(event: RuntimeEvent, name: string): number | undefined {
  const value = event.attributes?.[name];
  return typeof value === "number" ? value : undefined;
}

function stringAttribute(event: RuntimeEvent, name: string): string | undefined {
  const value = event.attributes?.[name];
  return typeof value === "string" ? value : undefined;
}