import { randomUUID } from "node:crypto";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { ModelProvider } from "../protocol/agent-protocol.js";
import type {
  SandboxConfig,
  SandboxProvider,
} from "../sandbox/sandbox-provider.js";
import {
  StaticPolicyEngine,
  type ApprovalHandler,
  type PolicyEngine,
} from "../governance/policy-engine.js";
import { ToolGateway } from "../tools/tool-gateway.js";
import { AgentLoop, AgentStoppedError } from "./agent-loop.js";
import {
  runtimeEvent,
  type RuntimeEventSink,
} from "../runtime/runtime-events.js";

export interface RunAgentSessionOptions {
  task: string;
  workspacePath: string;
  modelProvider: ModelProvider;
  sandboxProvider: SandboxProvider;
  approvalHandler: ApprovalHandler;
  policyEngine?: PolicyEngine;
  agent?: {
    id: string;
    runtime: "node" | "python";
    identity: { subject: string };
    version: string;
    role: string;
    harness: {
      id: string;
      version: number;
    };
  };
  sandboxConfig?: Omit<SandboxConfig, "workspacePath">;
  sessionId?: string;
  taskId?: string;
  onEvent?: RuntimeEventSink;
  signal?: AbortSignal;
  onIterationLimit?: (input: {
    iterations: number;
    additionalIterations: number;
  }) => Promise<boolean>;
}

export async function runAgentSession(
  options: RunAgentSessionOptions,
): Promise<string> {
  const tracer = trace.getTracer("nocode.agent");
  return tracer.startActiveSpan("agent.session", async (span) => {
    const sessionId = options.sessionId ?? randomUUID();
    const taskId = options.taskId ?? randomUUID();
    span.setAttributes({
      "agent.id": options.agent?.id ?? "coding-agent",
      "agent.identity":
        options.agent?.identity.subject ?? "agent://nocode/coding-agent",
      "agent.version": options.agent?.version ?? "0.1.0",
      "agent.role": options.agent?.role ?? "coding-agent",
      ...(options.agent === undefined
        ? {}
        : {
            "harness.id": options.agent.harness.id,
            "harness.version": options.agent.harness.version,
          }),
      "session.id": sessionId,
      "task.id": taskId,
    });
    let sandboxId: string | undefined;

    try {
      options.onEvent?.(
        runtimeEvent("session.started", sessionId, "Agent session started", {
          agentId: options.agent?.id ?? "coding-agent",
          "agent.id": options.agent?.id ?? "coding-agent",
          "agent.identity":
            options.agent?.identity.subject ?? "agent://nocode/coding-agent",
          "agent.version": options.agent?.version ?? "0.1.0",
          "agent.role": options.agent?.role ?? "coding-agent",
          "prompt.characters": Array.from(options.task).length,
          ...(options.agent === undefined
            ? {}
            : {
                "harness.id": options.agent.harness.id,
                "harness.version": options.agent.harness.version,
              }),
        }),
      );
      const sandbox = await options.sandboxProvider.create({
        workspacePath: options.workspacePath,
        ...options.sandboxConfig,
      });
      sandboxId = sandbox.id;
      options.onEvent?.(
        runtimeEvent("sandbox.created", sessionId, "Sandbox created", {
          sandboxId: sandbox.id,
          provider: sandbox.provider,
        }),
      );
      span.setAttributes({
        "sandbox.id": sandbox.id,
        "sandbox.provider": sandbox.provider,
      });
      const gateway = new ToolGateway({
        sandboxProvider: options.sandboxProvider,
        sandboxId: sandbox.id,
        policyEngine: options.policyEngine ?? new StaticPolicyEngine(),
        approvalHandler: options.approvalHandler,
        runtime: options.agent?.runtime ?? "node",
      });
      const agent = new AgentLoop({
        modelProvider: options.modelProvider,
        toolExecutor: gateway,
        placement: options.sandboxProvider.placement,
        ...(options.agent === undefined
          ? {}
          : {
              agent: {
                id: options.agent.id,
                identity: options.agent.identity.subject,
                harness: options.agent.harness,
              },
            }),
        sessionId,
        ...(options.onIterationLimit === undefined
          ? {}
          : { onIterationLimit: options.onIterationLimit }),
        ...(options.onEvent === undefined ? {} : { onEvent: options.onEvent }),
      });
      const result = await agent.run(options.task, options.signal);
      options.onEvent?.(
        runtimeEvent("session.completed", sessionId, "Agent session completed", {
          "agent.id": options.agent?.id ?? "coding-agent",
          "agent.identity":
            options.agent?.identity.subject ?? "agent://nocode/coding-agent",
        }),
      );
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      const exception = error instanceof Error ? error : new Error(String(error));
      const stopped = exception instanceof AgentStoppedError;
      if (stopped) {
        span.setStatus({ code: SpanStatusCode.UNSET });
      } else {
        span.recordException(exception);
        span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
      }
      options.onEvent?.(
        runtimeEvent(stopped ? "session.cancelled" : "session.failed", sessionId, stopped ? "Agent session stopped" : "Agent session failed", {
          error: exception.message,
          "agent.id": options.agent?.id ?? "coding-agent",
          "agent.identity":
            options.agent?.identity.subject ?? "agent://nocode/coding-agent",
        }),
      );
      throw error;
    } finally {
      if (sandboxId) {
        await options.sandboxProvider.terminate(sandboxId);
        options.onEvent?.(
          runtimeEvent("sandbox.terminated", sessionId, "Sandbox terminated"),
        );
      }
      span.end();
    }
  });
}