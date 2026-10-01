import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import type { ExecutionApi } from "./execution-service.js";

export async function handleMcpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  body: unknown,
  executions: ExecutionApi,
): Promise<void> {
  const server = createMcpServer(executions);
  const transport = new StreamableHTTPServerTransport();
  try {
    await server.connect(transport as Transport);
    await transport.handleRequest(request, response, body);
  } finally {
    await Promise.allSettled([transport.close(), server.close()]);
  }
}

function createMcpServer(executions: ExecutionApi): McpServer {
  const server = new McpServer({ name: "nocode-executions", version: "0.1.0" });

  server.registerTool(
    "nocode_list_agents",
    {
      description: "List governed coding agents available through NoCode.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => toolResult(executions.listAgents()),
  );

  server.registerTool(
    "nocode_list_executions",
    {
      description: "List NoCode executions and their current status.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => toolResult(executions.listSessions()),
  );

  server.registerTool(
    "nocode_list_workflows",
    {
      description:
        "List registered NoCode workflows, their identities, versions, inputs, and execution configuration.",
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => toolResult(executions.listWorkflows()),
  );

  server.registerTool(
    "nocode_start_execution",
    {
      description:
        "Start a governed agent execution in the explicitly selected local or remote sandbox. Ask the user to choose placement when it is not specified.",
      inputSchema: {
        agentId: z.string().min(1).describe("Agent ID from nocode_list_agents"),
        repositoryUrl: z.string().url().describe("HTTPS Git repository URL"),
        task: z.string().min(1).describe("Task for the governed agent"),
        placement: z
          .enum(["local", "remote"])
          .describe("Execution location selected by the user"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input) => toolResult(executions.launch(input)),
  );

  server.registerTool(
    "nocode_get_execution",
    {
      description:
        "Get one execution, including sanitized progress events and any pending approval request.",
      inputSchema: {
        executionId: z.string().min(1).describe("Full execution ID or unique prefix"),
      },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async ({ executionId }) => toolResult(executions.getSession(executionId)),
  );

  server.registerTool(
    "nocode_start_workflow",
    {
      description:
        "Start a registered NoCode workflow in the explicitly selected local or remote sandbox.",
      inputSchema: {
        workflowId: z
          .string()
          .min(1)
          .describe("Workflow ID from nocode_list_workflows"),
        repositoryUrl: z
          .string()
          .url()
          .describe("HTTPS Git repository URL for this workflow run"),
        fresh: z
          .boolean()
          .optional()
          .describe("Prepare fresh workflow workspaces before coding"),
        placement: z
          .enum(["local", "remote"])
          .describe("Execution location selected by the user"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ workflowId, repositoryUrl, fresh, placement }) =>
      toolResult(
        executions.launchWorkflow({
          workflowId,
          repositoryUrl,
          fresh: fresh ?? false,
          placement,
        }),
      ),
  );

  server.registerTool(
    "nocode_start_review_repair",
    {
      description:
        "Compatibility alias that starts the registered review-repair workflow.",
      inputSchema: {
        repositoryUrl: z
          .string()
          .url()
          .describe("HTTPS Git repository URL for this workflow run"),
        fresh: z.boolean().optional().describe("Prepare fresh workflow workspaces"),
        placement: z
          .enum(["local", "remote"])
          .describe("Execution location selected by the user"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ repositoryUrl, fresh, placement }) =>
      toolResult(
        executions.launchWorkflow({
          workflowId: "review-repair",
          repositoryUrl,
          fresh: fresh ?? false,
          placement,
        }),
      ),
  );

  server.registerTool(
    "nocode_resolve_approval",
    {
      description:
        "Approve or deny a pending tool request, optionally remembering the decision for the rest of the execution.",
      inputSchema: {
        executionId: z.string().min(1).describe("Full execution ID or unique prefix"),
        approved: z.boolean().describe("True to approve, false to deny"),
        remember: z
          .boolean()
          .optional()
          .describe("Apply this decision to later approval requests in this execution"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ executionId, approved, remember }) =>
      toolResult(executions.resolveApproval(executionId, approved, remember)),
  );

  server.registerTool(
    "nocode_cancel_execution",
    {
      description: "Cancel a running NoCode execution.",
      inputSchema: {
        executionId: z.string().min(1).describe("Full execution ID or unique prefix"),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ executionId }) => toolResult(executions.cancel(executionId)),
  );

  return server;
}

function toolResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}