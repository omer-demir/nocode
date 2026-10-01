import { SpanStatusCode, trace, type Tracer } from "@opentelemetry/api";
import type { ToolRequest } from "../protocol/agent-protocol.js";

export type PolicyOutcome = "ALLOW" | "ASK" | "DENY";

export interface PolicyDecision {
  outcome: PolicyOutcome;
  rule: string;
  reason: string;
}

export interface PolicyEngine {
  evaluate(request: ToolRequest): Promise<PolicyDecision>;
}

const TOOL_POLICIES: Readonly<Record<string, PolicyDecision>> = {
  "filesystem.read": {
    outcome: "ALLOW",
    rule: "workspace-read",
    reason: "Reading files inside the workspace is allowed",
  },
  "filesystem.search": {
    outcome: "ALLOW",
    rule: "workspace-search",
    reason: "Searching inside the workspace is allowed",
  },
  "filesystem.write": {
    outcome: "ASK",
    rule: "first-party-write-approval",
    reason: "Workspace mutation requires user approval",
  },
  "test.run": {
    outcome: "ALLOW",
    rule: "workspace-test",
    reason: "The fixed repository test command is allowed",
  },
};

export class StaticPolicyEngine implements PolicyEngine {
  constructor(
    private readonly tracer: Tracer = trace.getTracer("nocode.governance"),
  ) {}

  async evaluate(request: ToolRequest): Promise<PolicyDecision> {
    return this.tracer.startActiveSpan("policy.evaluate", async (span) => {
      const decision = TOOL_POLICIES[request.name] ?? {
        outcome: "DENY" as const,
        rule: "default-deny",
        reason: `Tool ${request.name} is not registered`,
      };
      span.setAttributes({
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
}

export interface ApprovalHandler {
  request(request: ToolRequest, decision: PolicyDecision): Promise<boolean>;
}

export class FixedApprovalHandler implements ApprovalHandler {
  constructor(private readonly approved: boolean) {}

  async request(): Promise<boolean> {
    return this.approved;
  }
}