import { createHash } from "node:crypto";
import { SpanStatusCode, trace, type Tracer } from "@opentelemetry/api";
import type {
  AgentMessage,
  ModelProvider,
} from "../protocol/agent-protocol.js";
import type { ToolExecutor } from "../tools/tool-gateway.js";
import {
  runtimeEvent,
  type RuntimeEventSink,
} from "../runtime/runtime-events.js";

export interface AgentLoopOptions {
  modelProvider: ModelProvider;
  toolExecutor: ToolExecutor;
  agent?: {
    id: string;
    identity: string;
    harness: {
      id: string;
      version: number;
    };
  };
  placement?: "local" | "remote";
  maxIterations?: number;
  onIterationLimit?: (input: {
    iterations: number;
    additionalIterations: number;
  }) => Promise<boolean>;
  tracer?: Tracer;
  sessionId?: string;
  onEvent?: RuntimeEventSink;
}

export class AgentStoppedError extends Error {
  constructor(iterations: number) {
    super(`Agent stopped by user after ${iterations} iterations`);
    this.name = "AgentStoppedError";
  }
}

export class SecurityBoundaryViolationError extends Error {
  constructor(toolName: string) {
    super(`Execution halted after prohibited ${toolName} request`);
    this.name = "SecurityBoundaryViolationError";
  }
}

export class AgentLoop {
  private readonly tracer: Tracer;

  constructor(private readonly options: AgentLoopOptions) {
    this.tracer = options.tracer ?? trace.getTracer("nocode.agent");
  }

  async run(task: string, signal?: AbortSignal): Promise<string> {
    const messages: AgentMessage[] = [{ role: "user", content: task }];
    const maxIterations = this.options.maxIterations ?? 20;
    let iteration = 0;
    let iterationLimit = maxIterations;

    while (iteration < iterationLimit) {
      signal?.throwIfAborted();
      const modelStartedAt = Date.now();
      this.emit(
        "model.started",
        `Model turn ${iteration + 1} started`,
        { iteration: iteration + 1 },
      );
      let response;
      try {
        response = await this.tracer.startActiveSpan(
          "model.invoke",
          async (span) => {
          span.setAttribute("agent.iteration", iteration + 1);
          try {
            const value = await this.options.modelProvider.complete(messages);
            if (value.usage) {
              span.setAttributes({
                "gen_ai.provider.name": value.usage.provider,
                "gen_ai.request.model": value.usage.model,
                "gen_ai.usage.input_tokens": value.usage.inputTokens,
                "gen_ai.usage.output_tokens": value.usage.outputTokens,
              });
            }
            span.setStatus({ code: SpanStatusCode.OK });
            return value;
          } catch (error) {
            const exception = error instanceof Error ? error : new Error(String(error));
            span.recordException(exception);
            span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
            throw error;
          } finally {
            span.end();
          }
          },
        );
      } catch (error) {
        const classification = classifyModelError(error);
        this.emit("model.failed", `Model turn ${iteration + 1} failed`, {
          iteration: iteration + 1,
          durationMs: Date.now() - modelStartedAt,
          "error.category": classification.category,
          ...(classification.statusCode === undefined
            ? {}
            : { "http.status_code": classification.statusCode }),
          ...(classification.code === undefined
            ? {}
            : { "error.code": classification.code }),
          ...(classification.category !== "content_filter"
            ? {}
            : {
                "guardrail.source": "azure-foundry",
                "guardrail.category":
                  classification.guardrailCategories?.join(",") ?? "unknown",
                "guardrail.content_source":
                  classification.contentSource ?? "unknown",
              }),
        });
        throw error;
      }
      for (const hit of response.guardrailHits ?? []) {
        this.emit(
          "model.guardrail_triggered",
          `Azure Foundry guardrail blocked model attempt ${hit.attempt}`,
          {
            iteration: iteration + 1,
            "guardrail.source": hit.source,
            "guardrail.attempt": hit.attempt,
            "guardrail.category": hit.categories.join(",") || "unknown",
            "guardrail.content_source": hit.contentSource,
            "error.category": "content_filter",
            "error.code": hit.code,
            ...(hit.innerCode === undefined
              ? {}
              : { "error.inner_code": hit.innerCode }),
            "http.status_code": hit.statusCode,
            ...(response.usage === undefined
              ? {}
              : {
                  "model.provider": response.usage.provider,
                  "model.name": response.usage.model,
                }),
          },
        );
      }
      this.emit(
        "model.completed",
        `Model turn ${iteration + 1} completed`,
        {
          iteration: iteration + 1,
          durationMs: Date.now() - modelStartedAt,
          "execution.placement": this.options.placement ?? "local",
          ...(response.usage === undefined
            ? {}
            : {
                "model.provider": response.usage.provider,
                "model.name": response.usage.model,
                "model.usage.input_tokens": response.usage.inputTokens,
                "model.usage.output_tokens": response.usage.outputTokens,
                "model.usage.total_tokens": response.usage.totalTokens,
                ...(response.usage.cachedInputTokens === undefined
                  ? {}
                  : {
                      "model.usage.cached_input_tokens":
                        response.usage.cachedInputTokens,
                    }),
                ...(response.usage.reasoningTokens === undefined
                  ? {}
                  : {
                      "model.usage.reasoning_tokens":
                        response.usage.reasoningTokens,
                    }),
                ...(response.usage.fixedInputBytes === undefined
                  ? {}
                  : { "model.context.fixed_input_bytes": response.usage.fixedInputBytes }),
                ...(response.usage.requestBytes === undefined
                  ? {}
                  : { "model.context.request_bytes": response.usage.requestBytes }),
                ...(response.usage.userInputCharacters === undefined
                  ? {}
                  : {
                      "model.context.user_input_characters":
                        response.usage.userInputCharacters,
                    }),
                ...(response.usage.estimatedCostUsd === undefined
                  ? {}
                  : { "model.usage.estimated_cost_usd": response.usage.estimatedCostUsd }),
              }),
          ...(response.content === undefined
            ? {}
            : { modelNote: singleLine(response.content, 240) }),
          ...(response.reasoningSummary === undefined
            ? {}
            : {
                reasoningSummary: singleLine(
                  response.reasoningSummary,
                  1_000,
                ),
              }),
        },
      );

      if (!response.toolRequest) {
        return response.content ?? "Agent completed without a summary";
      }

      messages.push({
        role: "assistant",
        ...(response.content === undefined ? {} : { content: response.content }),
        toolRequest: response.toolRequest,
      });
      this.emit("tool.requested", `Tool requested: ${response.toolRequest.name}`, {
        toolName: response.toolRequest.name,
        toolCallId: response.toolRequest.id,
        ...(response.toolRequest.name === "filesystem.write"
          ? {
              targetPathHash: hashPath(
                stringValue(response.toolRequest.arguments.path) ?? "unknown",
              ),
            }
          : {}),
        argumentSummary: summarizeToolArguments(
          response.toolRequest.name,
          response.toolRequest.arguments,
        ),
      });
      const toolStartedAt = Date.now();
      const result = await this.options.toolExecutor.invoke(response.toolRequest);
      this.emit(
        "tool.completed",
        `Tool ${response.toolRequest.name} ${result.success ? "completed" : "failed"}`,
        {
          toolName: response.toolRequest.name,
          toolCallId: response.toolRequest.id,
          success: result.success,
          durationMs: Date.now() - toolStartedAt,
          outputBytes: Buffer.byteLength(result.output),
          ...(result.telemetry?.policyOutcome === undefined
            ? {}
            : { "policy.outcome": result.telemetry.policyOutcome }),
          ...(result.telemetry?.policyRule === undefined
            ? {}
            : { "policy.rule": result.telemetry.policyRule }),
          ...(result.telemetry?.approvalRequired === undefined
            ? {}
            : { "approval.required": result.telemetry.approvalRequired }),
          ...(result.telemetry?.approvalGranted === undefined
            ? {}
            : { "approval.granted": result.telemetry.approvalGranted }),
          ...(result.telemetry?.commandCount === undefined
            ? {}
            : { "commands.executed": result.telemetry.commandCount }),
          ...(result.telemetry?.rateLimitSource === undefined
            ? {}
            : {
                "error.category": "rate_limit",
                "rate_limit.source": result.telemetry.rateLimitSource,
              }),
        },
      );
      for (const detection of result.telemetry?.securityDetections ?? []) {
        this.emit(
          "security.detected",
          `Security boundary violation blocked: ${detection.signal}`,
          {
            toolName: response.toolRequest.name,
            signal: detection.signal,
            boundary: detection.boundary,
            "commands.executed": result.telemetry?.commandCount ?? 0,
          },
        );
      }
      if (result.telemetry?.haltExecution === true) {
        throw new SecurityBoundaryViolationError(response.toolRequest.name);
      }
      messages.push({
        role: "tool",
        result: {
          toolCallId: result.toolCallId,
          success: result.success,
          output: result.output,
        },
      });
      iteration += 1;

      if (iteration === iterationLimit) {
        if (!this.options.onIterationLimit) {
          throw new Error(`Agent exceeded ${maxIterations} iterations`);
        }
        const shouldContinue = await this.options.onIterationLimit({
          iterations: iteration,
          additionalIterations: maxIterations,
        });
        if (!shouldContinue) {
          throw new AgentStoppedError(iteration);
        }
        iterationLimit += maxIterations;
      }
    }

    throw new Error("Agent loop ended unexpectedly");
  }

  private emit(
    type: Parameters<typeof runtimeEvent>[0],
    message: string,
    attributes?: Readonly<Record<string, string | number | boolean>>,
  ): void {
    if (this.options.onEvent && this.options.sessionId) {
      this.options.onEvent(
        runtimeEvent(type, this.options.sessionId, message, {
          ...(this.options.agent === undefined
            ? {}
            : {
                "agent.id": this.options.agent.id,
                "agent.identity": this.options.agent.identity,
                "harness.id": this.options.agent.harness.id,
                "harness.version": this.options.agent.harness.version,
              }),
          ...attributes,
        }),
      );
    }
  }
}

function hashPath(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

function classifyModelError(error: unknown): {
  category: "rate_limit" | "content_filter" | "provider_error";
  statusCode?: number;
  code?: string;
  guardrailCategories?: string[];
  contentSource?: string;
} {
  const message = error instanceof Error ? error.message : String(error);
  const details =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : undefined;
  const status = /(?:HTTP\s*)?(\d{3})/i.exec(message)?.[1];
  const structuredStatus = details?.statusCode;
  const statusCode =
    typeof structuredStatus === "number"
      ? structuredStatus
      : status === undefined
        ? undefined
        : Number(status);
  const code =
    typeof details?.code === "string" ? details.code : undefined;
  const guardrailCategories = Array.isArray(details?.categories)
    ? details.categories.filter(
        (category): category is string => typeof category === "string",
      )
    : undefined;
  const contentSource =
    typeof details?.source === "string" ? details.source : undefined;
  const rateLimited =
    statusCode === 429 || /rate.?limit|too many requests/i.test(message);
  const contentFiltered = code === "content_filter";
  return {
    category: rateLimited
      ? "rate_limit"
      : contentFiltered
        ? "content_filter"
        : "provider_error",
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(code === undefined ? {} : { code }),
    ...(guardrailCategories === undefined ? {} : { guardrailCategories }),
    ...(contentSource === undefined ? {} : { contentSource }),
  };
}

function summarizeToolArguments(
  toolName: string,
  argumentsValue: Readonly<Record<string, unknown>>,
): string {
  if (toolName === "filesystem.read") {
    return stringValue(argumentsValue.path) ?? "path provided";
  }
  if (toolName === "filesystem.write") {
    const path = stringValue(argumentsValue.path) ?? "path provided";
    const content = stringValue(argumentsValue.content);
    return content === undefined
      ? path
      : `${path} (${Buffer.byteLength(content)} bytes)`;
  }
  if (toolName === "filesystem.search") {
    const path = stringValue(argumentsValue.path) ?? ".";
    const query = stringValue(argumentsValue.query);
    return query === undefined
      ? `in ${path}`
      : `"${singleLine(query, 80)}" in ${path}`;
  }
  if (toolName === "package.install" && Array.isArray(argumentsValue.packages)) {
    const packages = argumentsValue.packages.filter(
      (value): value is string => typeof value === "string",
    );
    return packages.length > 0 ? packages.join(", ") : "packages provided";
  }
  const names = Object.keys(argumentsValue)
    .filter((name) => name !== "content")
    .sort();
  return names.length > 0 ? `arguments: ${names.join(", ")}` : "no arguments";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function singleLine(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength
    ? compact
    : `${compact.slice(0, maxLength - 3)}...`;
}