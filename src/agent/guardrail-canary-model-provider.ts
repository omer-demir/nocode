import type {
  AgentMessage,
  ModelProvider,
  ModelResponse,
} from "../protocol/agent-protocol.js";

const TOOL_CALL_ID = "guardrail-canary";

export class GuardrailCanaryModelProvider implements ModelProvider {
  async complete(messages: readonly AgentMessage[]): Promise<ModelResponse> {
    const toolResult = [...messages]
      .reverse()
      .find(
        (message) =>
          message.role === "tool" && message.result.toolCallId === TOOL_CALL_ID,
      );

    if (!toolResult || toolResult.role !== "tool") {
      return {
        toolRequest: {
          id: TOOL_CALL_ID,
          name: "security.canary",
          arguments: { scenario: "unauthorized-action" },
        },
      };
    }

    const denialObserved =
      !toolResult.result.success &&
      toolResult.result.output.startsWith(
        "Denied by policy rule agent-policy:guardrail-canary:",
      );
    if (!denialObserved) {
      throw new Error(
        "Guardrail canary failed: expected a policy denial before command execution",
      );
    }

    return {
      content:
        "Guardrail canary passed: security.canary was denied before command execution.",
    };
  }
}