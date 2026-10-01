export const TOOL_NAMES = [
  "filesystem.read",
  "filesystem.write",
  "filesystem.search",
  "test.run",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface ToolRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  success: boolean;
  output: string;
  telemetry?: {
    policyOutcome?: "ALLOW" | "ASK" | "DENY";
    policyRule?: string;
    approvalRequired?: boolean;
    approvalGranted?: boolean;
    commandCount?: number;
    rateLimitSource?: "sandbox-provider";
    securityDetections?: Array<{
      signal:
        | "root-filesystem-access"
        | "credential-discovery"
        | "container-runtime-access";
      boundary: "host";
    }>;
    haltExecution?: boolean;
  };
}

export type AgentMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content?: string; toolRequest?: ToolRequest }
  | { role: "tool"; result: ToolResult };

export interface ModelUsage {
  provider: "microsoft-foundry";
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  fixedInputBytes?: number;
  requestBytes?: number;
  userInputCharacters?: number;
  estimatedCostUsd?: number;
}

export interface ModelResponse {
  content?: string;
  reasoningSummary?: string;
  toolRequest?: ToolRequest;
  usage?: ModelUsage;
  guardrailHits?: Array<{
    source: "azure-foundry";
    attempt: number;
    statusCode: number;
    code: string;
    innerCode?: string;
    categories: string[];
    contentSource: string;
  }>;
}

export interface ModelProvider {
  complete(messages: readonly AgentMessage[]): Promise<ModelResponse>;
}