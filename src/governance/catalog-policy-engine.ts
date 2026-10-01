import { SpanStatusCode, trace, type Tracer } from "@opentelemetry/api";
import type {
  AgentDescriptor,
  ToolDefinition,
} from "../catalog/catalog-types.js";
import type { ToolRequest } from "../protocol/agent-protocol.js";
import type { PolicyDecision, PolicyEngine } from "./policy-engine.js";

export class CatalogPolicyEngine implements PolicyEngine {
  private readonly toolsByName: ReadonlyMap<string, ToolDefinition>;

  constructor(
    private readonly agent: AgentDescriptor,
    tools: readonly ToolDefinition[],
    private readonly tracer: Tracer = trace.getTracer("nocode.governance"),
  ) {
    this.toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  }

  async evaluate(request: ToolRequest): Promise<PolicyDecision> {
    return this.tracer.startActiveSpan("policy.evaluate", async (span) => {
      const decision = this.decide(request.name);
      span.setAttributes({
        "agent.id": this.agent.id,
        "agent.identity": this.agent.identity.subject,
        "tool.name": request.name,
        "policy.decision": decision.outcome,
        "policy.rule": decision.rule,
        "approval.required": decision.outcome === "ASK",
      });
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      return decision;
    });
  }

  private decide(toolName: string): PolicyDecision {
    const tool = this.toolsByName.get(toolName);
    if (!tool || !this.agent.tools.includes(toolName)) {
      return {
        outcome: "DENY",
        rule: "agent-tool-allowlist",
        reason: `Agent ${this.agent.id} is not allowed to use ${toolName}`,
      };
    }
    if (!this.agent.capabilities.includes(tool.capability)) {
      return {
        outcome: "DENY",
        rule: "capability-required",
        reason: `Tool ${toolName} requires capability ${tool.capability}`,
      };
    }
    if (
      tool.requiresNetwork &&
      !this.agent.capabilities.includes("network.internet")
    ) {
      return {
        outcome: "DENY",
        rule: "network-capability-required",
        reason: `Tool ${toolName} requires internet access`,
      };
    }
    return {
      outcome: this.agent.toolPolicy[toolName] ?? tool.defaultPolicy,
      rule: `agent-policy:${this.agent.id}`,
      reason: `Agent ${this.agent.id} policy for ${toolName}`,
    };
  }
}