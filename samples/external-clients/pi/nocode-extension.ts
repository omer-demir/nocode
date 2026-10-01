import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const gatewayUrl = (
  process.env.NOCODE_GATEWAY_URL ?? "http://127.0.0.1:8787"
).replace(/\/$/, "");
const placementSchema = Type.Union(
  [Type.Literal("local"), Type.Literal("remote")],
  { description: "Execution location selected by the user" },
);

export default function nocodeExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "nocode_list_agents",
    label: "NoCode Agents",
    description: "List governed coding agents available from NoCode.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      return result(await request("/api/agents", "GET", undefined, signal));
    },
  });

  pi.registerTool({
    name: "nocode_list_executions",
    label: "NoCode Executions",
    description: "List NoCode executions and their current status.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      return result(await request("/api/executions", "GET", undefined, signal));
    },
  });

  pi.registerTool({
    name: "nocode_list_workflows",
    label: "NoCode Workflows",
    description:
      "List registered workflows with identity, version, inputs, and execution configuration.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      return result(await request("/api/workflows", "GET", undefined, signal));
    },
  });

  pi.registerTool({
    name: "nocode_start_execution",
    label: "Start NoCode Execution",
    description:
      "Start a governed coding-agent execution in a server-controlled workspace and configured sandbox environment.",
    parameters: Type.Object({
      agentId: Type.String({ description: "Agent ID from nocode_list_agents" }),
      repositoryUrl: Type.String({ description: "HTTPS Git repository URL" }),
      task: Type.String({ description: "Task for the governed agent" }),
      placement: placementSchema,
    }),
    async execute(_toolCallId, params, signal, onUpdate) {
      onUpdate?.({
        content: [{ type: "text", text: "Submitting execution to NoCode..." }],
        details: { status: "submitting" },
      });
      return result(
        await request("/api/executions", "POST", params, signal),
      );
    },
  });

  pi.registerTool({
    name: "nocode_get_execution",
    label: "NoCode Execution Status",
    description:
      "Get sanitized progress, status, output, and pending approvals for one execution.",
    parameters: Type.Object({
      executionId: Type.String({ description: "Full execution ID or unique prefix" }),
    }),
    async execute(_toolCallId, { executionId }, signal) {
      return result(
        await request(
          `/api/executions/${encodeURIComponent(executionId)}`,
          "GET",
          undefined,
          signal,
        ),
      );
    },
  });

  pi.registerTool({
    name: "nocode_start_workflow",
    label: "Start NoCode Workflow",
    description:
      "Start a registered workflow by ID in the configured sandbox environment.",
    parameters: Type.Object({
      workflowId: Type.String({
        description: "Workflow ID from nocode_list_workflows",
      }),
      repositoryUrl: Type.String({
        description: "HTTPS Git repository URL for this workflow run",
      }),
      fresh: Type.Optional(
        Type.Boolean({ description: "Prepare fresh workflow workspaces" }),
      ),
      placement: placementSchema,
    }),
    async execute(
      _toolCallId,
      { workflowId, repositoryUrl, fresh, placement },
      signal,
      onUpdate,
    ) {
      onUpdate?.({
        content: [{ type: "text", text: `Starting ${workflowId} workflow...` }],
        details: { status: "submitting" },
      });
      return result(
        await request(
          `/api/workflows/${encodeURIComponent(workflowId)}`,
          "POST",
          { repositoryUrl, fresh: fresh ?? false, placement },
          signal,
        ),
      );
    },
  });

  pi.registerTool({
    name: "nocode_start_review_repair",
    label: "Start NoCode Review Repair",
    description: "Compatibility alias for the registered review-repair workflow.",
    parameters: Type.Object({
      repositoryUrl: Type.String({
        description: "HTTPS Git repository URL for this workflow run",
      }),
      fresh: Type.Optional(Type.Boolean({ description: "Prepare fresh workspaces" })),
      placement: placementSchema,
    }),
    async execute(_toolCallId, { repositoryUrl, fresh, placement }, signal) {
      return result(
        await request(
          "/api/workflows/review-repair",
          "POST",
          { repositoryUrl, fresh: fresh ?? false, placement },
          signal,
        ),
      );
    },
  });

  pi.registerTool({
    name: "nocode_resolve_approval",
    label: "Resolve NoCode Approval",
    description: "Approve or deny the pending governed tool request.",
    parameters: Type.Object({
      executionId: Type.String({ description: "Full execution ID or unique prefix" }),
      approved: Type.Boolean({ description: "True to approve, false to deny" }),
      remember: Type.Optional(
        Type.Boolean({ description: "Apply the decision to later approvals" }),
      ),
    }),
    async execute(_toolCallId, { executionId, approved, remember }, signal) {
      return result(
        await request(
          `/api/executions/${encodeURIComponent(executionId)}/approval`,
          "POST",
          { approved, remember: remember ?? false },
          signal,
        ),
      );
    },
  });

  pi.registerTool({
    name: "nocode_cancel_execution",
    label: "Cancel NoCode Execution",
    description: "Cancel a running NoCode execution.",
    parameters: Type.Object({
      executionId: Type.String({ description: "Full execution ID or unique prefix" }),
    }),
    async execute(_toolCallId, { executionId }, signal) {
      return result(
        await request(
          `/api/executions/${encodeURIComponent(executionId)}/cancel`,
          "POST",
          {},
          signal,
        ),
      );
    },
  });
}

async function request(
  path: string,
  method: "GET" | "POST",
  body: unknown,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json" };
  const token = process.env.NOCODE_GATEWAY_TOKEN;
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${gatewayUrl}${path}`, {
    method,
    headers,
    ...(signal === undefined ? {} : { signal }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = (await response.json()) as unknown;
  if (!response.ok) {
    throw new Error(errorMessage(payload, response.status));
  }
  return payload;
}

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    details: { value },
  };
}

function errorMessage(value: unknown, status: number): string {
  if (
    typeof value === "object" &&
    value !== null &&
    "error" in value &&
    typeof value.error === "string"
  ) {
    return value.error;
  }
  return `NoCode gateway request failed with HTTP ${status}`;
}