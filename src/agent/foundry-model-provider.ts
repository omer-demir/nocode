import {
  DefaultAzureCredential,
  getBearerTokenProvider,
} from "@azure/identity";
import type {
  AgentMessage,
  ModelProvider,
  ModelResponse,
} from "../protocol/agent-protocol.js";
import type { ToolDefinition } from "../catalog/catalog-types.js";

export interface FoundryModelOptions {
  endpoint: string;
  model: string;
  instructions?: string;
  tools?: readonly ToolDefinition[];
  requireToolOnFirstTurn?: boolean;
  reasoningSummary?: "auto" | "concise" | "detailed";
  tokenProvider?: () => Promise<string>;
}

interface FoundryResponse {
  model?: string;
  output_text?: string;
  output?: Array<{
    type?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
    summary?: Array<{
      type?: string;
      text?: string;
    }>;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  error?: {
    message?: string;
    code?: string;
    innererror?: { code?: string };
    content_filters?: Array<{
      blocked?: boolean;
      source_type?: string;
      content_filter_results?: Record<
        string,
        { filtered?: boolean; detected?: boolean }
      >;
    }>;
  };
  usage?: {
    input_tokens?: number;
    input_tokens_details?: { cached_tokens?: number };
    output_tokens?: number;
    output_tokens_details?: { reasoning_tokens?: number };
    total_tokens?: number;
  };
}

const FOUNDRY_SCOPE = "https://ai.azure.com/.default";
export const DEFAULT_FOUNDRY_RESPONSES_ENDPOINT =
  "https://omerdemir-9440-resource.services.ai.azure.com/openai/v1/responses";
export const DEFAULT_FOUNDRY_MODEL = "gpt-5.4-mini";

const DEFAULT_SYSTEM_PROMPT = `You are a coding agent operating through governed tools.
Use only filesystem.read, filesystem.write, filesystem.search, and test.run.
Inspect before editing, keep changes focused, run tests, then summarize the result.`;

const DEFAULT_TOOLS: readonly ToolDefinition[] = [
  {
    name: "filesystem.read",
    description: "Read a UTF-8 file from the repository",
    capability: "repository.read",
    mutatesWorkspace: false,
    requiresNetwork: false,
    defaultPolicy: "ALLOW",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
  {
    name: "filesystem.write",
    description: "Write complete UTF-8 content to a repository file",
    capability: "workspace.write",
    mutatesWorkspace: true,
    requiresNetwork: false,
    defaultPolicy: "ASK",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "filesystem.search",
    description: "Search repository files for a literal string",
    capability: "repository.read",
    mutatesWorkspace: false,
    requiresNetwork: false,
    defaultPolicy: "ALLOW",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        path: { type: "string", default: "." },
      },
      required: ["query"],
    },
  },
  {
    name: "test.run",
    description: "Run the repository's npm test script",
    capability: "tests.run",
    mutatesWorkspace: false,
    requiresNetwork: false,
    defaultPolicy: "ALLOW",
    parameters: { type: "object", properties: {} },
  },
] as const;

export class FoundryApiError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code?: string,
    readonly innerCode?: string,
  ) {
    super(message);
    this.name = "FoundryApiError";
  }
}

export class FoundryContentFilterError extends FoundryApiError {
  constructor(
    message: string,
    statusCode: number,
    code: string,
    innerCode: string | undefined,
    readonly categories: readonly string[],
    readonly source: string,
  ) {
    super(message, statusCode, code, innerCode);
    this.name = "FoundryContentFilterError";
  }
}

export class FoundryModelProvider implements ModelProvider {
  private readonly tools: readonly ToolDefinition[];
  private readonly apiToolNames: Readonly<Record<string, string>>;
  private readonly logicalToolNames: Readonly<Record<string, string>>;
  private readonly tokenProvider: () => Promise<string>;

  constructor(private readonly options: FoundryModelOptions) {
    this.tools = options.tools ?? DEFAULT_TOOLS;
    this.tokenProvider =
      options.tokenProvider ??
      getBearerTokenProvider(new DefaultAzureCredential(), FOUNDRY_SCOPE);
    this.apiToolNames = Object.fromEntries(
      this.tools.map((tool) => [tool.name, apiToolName(tool.name)]),
    );
    this.logicalToolNames = Object.fromEntries(
      Object.entries(this.apiToolNames).map(([logicalName, apiName]) => [
        apiName,
        logicalName,
      ]),
    );
  }

  async complete(messages: readonly AgentMessage[]): Promise<ModelResponse> {
    const token = await this.tokenProvider();
    const instructions = this.options.instructions ?? DEFAULT_SYSTEM_PROMPT;
    const tools = this.tools.map((tool) => ({
      type: "function",
      name: this.apiToolNames[tool.name],
      description: tool.description,
      parameters: tool.parameters,
    }));
    const hasToolResult = messages.some((message) => message.role === "tool");
    const toolChoice = this.options.requireToolOnFirstTurn
      ? hasToolResult
        ? "none"
        : "required"
      : "auto";
    const requestBody = {
      model: this.options.model,
      instructions,
      input: messages.flatMap((message) => this.toApiInput(message)),
      tools,
      tool_choice: toolChoice,
      ...(this.options.reasoningSummary === undefined
        ? {}
        : { reasoning: { summary: this.options.reasoningSummary } }),
    };
    const response = await fetch(this.options.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
    });
    const body = await readFoundryResponse(response);
    if (!response.ok) {
      throw foundryApiError(response.status, body);
    }

    const usage = foundryUsage(body, this.options.model);
    const measuredUsage =
      usage === undefined
        ? undefined
        : {
            ...usage,
            fixedInputBytes:
              Buffer.byteLength(instructions) +
              Buffer.byteLength(JSON.stringify(tools)),
            requestBytes: Buffer.byteLength(JSON.stringify(requestBody)),
            userInputCharacters: messages.reduce(
              (total, message) =>
                message.role === "user"
                  ? total + Array.from(message.content).length
                  : total,
              0,
            ),
            ...estimatedCost(usage.inputTokens, usage.outputTokens),
          };
    const toolCall = body.output?.find((item) => item.type === "function_call");
    if (!toolCall) {
      if (this.options.requireToolOnFirstTurn && !hasToolResult) {
        throw new Error("Model did not produce the required first-turn tool call");
      }
      const reasoningSummary = responseReasoningSummary(body);
      return {
        content: responseText(body) ?? "Agent completed.",
        ...(reasoningSummary === undefined ? {} : { reasoningSummary }),
        ...(measuredUsage === undefined ? {} : { usage: measuredUsage }),
      };
    }
    if (!toolCall.call_id || !toolCall.name || !toolCall.arguments) {
      throw new Error("Model function call was incomplete");
    }
    const parsed = JSON.parse(toolCall.arguments) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Model tool arguments must be an object");
    }
    const content = responseText(body);
    const reasoningSummary = responseReasoningSummary(body);
    return {
      ...(content ? { content } : {}),
      ...(reasoningSummary === undefined ? {} : { reasoningSummary }),
      ...(measuredUsage === undefined ? {} : { usage: measuredUsage }),
      toolRequest: {
        id: toolCall.call_id,
        name: this.logicalToolNames[toolCall.name] ?? toolCall.name,
        arguments: parsed as Record<string, unknown>,
      },
    };
  }

  private toApiInput(message: AgentMessage): Record<string, unknown>[] {
    if (message.role === "user") {
      return [message];
    }
    if (message.role === "tool") {
      return [
        {
          type: "function_call_output",
          call_id: message.result.toolCallId,
          output: JSON.stringify(message.result),
        },
      ];
    }
    if (message.toolRequest) {
      return [
        ...(message.content
          ? [{ role: "assistant", content: message.content }]
          : []),
        {
          type: "function_call",
          call_id: message.toolRequest.id,
          name:
            this.apiToolNames[message.toolRequest.name] ??
            message.toolRequest.name,
          arguments: JSON.stringify(message.toolRequest.arguments),
        },
      ];
    }
    return [{ role: "assistant", content: message.content ?? "" }];
  }
}

async function readFoundryResponse(response: Response): Promise<FoundryResponse> {
  try {
    return (await response.json()) as FoundryResponse;
  } catch {
    return {};
  }
}

function foundryApiError(
  statusCode: number,
  body: FoundryResponse,
): FoundryApiError {
  const error = body.error;
  const message = error?.message ?? `Model request failed: HTTP ${statusCode}`;
  const code = error?.code;
  const innerCode = error?.innererror?.code;
  if (
    code === "content_filter" ||
    innerCode === "ContentFiltered" ||
    innerCode === "ResponsibleAIPolicyViolation"
  ) {
    const blocked = error?.content_filters?.filter(
      (result) => result.blocked === true,
    );
    const categories = Array.from(
      new Set(
        blocked?.flatMap((result) =>
          Object.entries(result.content_filter_results ?? {})
            .filter(
              ([, value]) =>
                value.filtered === true || value.detected === true,
            )
            .map(([name]) => name),
        ) ?? [],
      ),
    ).sort();
    const source = blocked?.[0]?.source_type ?? "unknown";
    return new FoundryContentFilterError(
      message,
      statusCode,
      code ?? "content_filter",
      innerCode,
      categories,
      source,
    );
  }
  return new FoundryApiError(message, statusCode, code, innerCode);
}

function estimatedCost(
  inputTokens: number,
  outputTokens: number,
): { estimatedCostUsd: number } | Record<string, never> {
  const inputRate = optionalNonNegativeNumber(
    process.env.NOCODE_MODEL_INPUT_COST_PER_MILLION_TOKENS,
  );
  const outputRate = optionalNonNegativeNumber(
    process.env.NOCODE_MODEL_OUTPUT_COST_PER_MILLION_TOKENS,
  );
  if (inputRate === undefined || outputRate === undefined) return {};
  return {
    estimatedCostUsd:
      (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000,
  };
}

function optionalNonNegativeNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function foundryUsage(
  body: FoundryResponse,
  configuredModel: string,
): ModelResponse["usage"] {
  const inputTokens = body.usage?.input_tokens;
  const outputTokens = body.usage?.output_tokens;
  const totalTokens = body.usage?.total_tokens;
  if (
    inputTokens === undefined ||
    outputTokens === undefined ||
    totalTokens === undefined
  ) {
    return undefined;
  }
  const cachedInputTokens = body.usage?.input_tokens_details?.cached_tokens;
  const reasoningTokens = body.usage?.output_tokens_details?.reasoning_tokens;
  return {
    provider: "microsoft-foundry",
    model: body.model ?? configuredModel,
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

function responseText(body: FoundryResponse): string | undefined {
  if (body.output_text) {
    return body.output_text;
  }
  const text = body.output
    ?.flatMap((item) => item.content ?? [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text ?? "")
    .join("")
    .trim();
  return text || undefined;
}

function responseReasoningSummary(body: FoundryResponse): string | undefined {
  const summary = body.output
    ?.filter((item) => item.type === "reasoning")
    .flatMap((item) => item.summary ?? [])
    .map((item) => item.text ?? "")
    .join("\n")
    .trim();
  return summary || undefined;
}

function apiToolName(logicalName: string): string {
  return logicalName.replace(/[^a-zA-Z0-9_-]/g, "_");
}