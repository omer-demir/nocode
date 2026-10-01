import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  AgentSummary,
  ExecutionApi,
  ExecutionSession,
  LaunchExecutionInput,
  LaunchWorkflowInput,
} from "../src/gateway/execution-service.js";
import type { WorkflowDescriptor } from "../src/catalog/catalog-types.js";
import {
  createGatewayServer,
  validateGatewayBinding,
} from "../src/gateway/http-server.js";

const token = "gateway-test-token";

describe("execution gateway", () => {
  it("requires authentication and serves the REST execution API", async () => {
    const executions = new StubExecutionApi();
    const { baseUrl, close } = await startGateway(executions);
    try {
      assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
      assert.equal((await fetch(`${baseUrl}/api/agents`)).status, 401);

      const agentsResponse = await fetch(`${baseUrl}/api/agents`, {
        headers: authorizationHeaders(),
      });
      assert.equal(agentsResponse.status, 200);
      assert.deepEqual(await agentsResponse.json(), {
        agents: executions.listAgents(),
      });

      const workflowsResponse = await fetch(`${baseUrl}/api/workflows`, {
        headers: authorizationHeaders(),
      });
      assert.equal(workflowsResponse.status, 200);
      assert.deepEqual(await workflowsResponse.json(), {
        workflows: executions.listWorkflows(),
      });

      const launchResponse = await fetch(`${baseUrl}/api/executions`, {
        method: "POST",
        headers: {
          ...authorizationHeaders(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          agentId: "sample-agent",
          repositoryUrl: "https://github.com/example/repository",
          task: "Review the migration",
          placement: "remote",
        }),
      });
      assert.equal(launchResponse.status, 202);
      const launched = await responseJson(launchResponse);
      assert.equal(launched.status, "queued");
      assert.equal(launched.placement, "remote");
      assert.equal(executions.lastLaunchInput?.placement, "remote");

      const workflowResponse = await fetch(
        `${baseUrl}/api/workflows/review-repair`,
        {
          method: "POST",
          headers: {
            ...authorizationHeaders(),
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            repositoryUrl: "https://github.com/example/workflow-target.git",
            fresh: true,
            placement: "remote",
          }),
        },
      );
      assert.equal(workflowResponse.status, 202);
      assert.equal((await responseJson(workflowResponse)).agentId, "workflow");
      assert.equal(
        executions.lastWorkflowInput?.repositoryUrl,
        "https://github.com/example/workflow-target.git",
      );
      assert.equal(executions.lastWorkflowInput?.placement, "remote");
    } finally {
      await close();
    }
  });

  it("streams current runtime events and terminal state over SSE", async () => {
    const executions = new StubExecutionApi();
    executions.complete();
    const { baseUrl, close } = await startGateway(executions);
    try {
      const response = await fetch(
        `${baseUrl}/api/executions/execution-1/events`,
        { headers: authorizationHeaders() },
      );
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.match(body, /event: runtime/);
      assert.match(body, /"type":"session.completed"/);
      assert.match(body, /event: execution/);
      assert.match(body, /"status":"completed"/);
    } finally {
      await close();
    }
  });

  it("serves governed tools through Streamable HTTP MCP", async () => {
    const executions = new StubExecutionApi();
    const { baseUrl, close } = await startGateway(executions);
    const client = new Client({ name: "gateway-test", version: "1.0.0" });
    try {
      const transport = new StreamableHTTPClientTransport(
        new URL(`${baseUrl}/mcp`),
        { requestInit: { headers: authorizationHeaders() } },
      );
      await client.connect(transport as Transport);
      const tools = await client.listTools();
      assert.ok(tools.tools.some((tool) => tool.name === "nocode_start_execution"));
      assert.ok(
        tools.tools.some((tool) => tool.name === "nocode_list_workflows"),
      );
      assert.ok(
        tools.tools.some((tool) => tool.name === "nocode_start_workflow"),
      );

      const call = await client.callTool({
        name: "nocode_list_agents",
        arguments: {},
      });
      assert.equal(call.isError, undefined);
      assert.match(JSON.stringify(call.content), /sample-agent/);
      assert.match(JSON.stringify(call.content), /availablePlacements/);

      const execution = await client.callTool({
        name: "nocode_start_execution",
        arguments: {
          agentId: "sample-agent",
          repositoryUrl: "https://github.com/example/repository.git",
          task: "Review the migration",
          placement: "remote",
        },
      });
      assert.equal(execution.isError, undefined);
      assert.equal(executions.lastLaunchInput?.placement, "remote");

      const workflows = await client.callTool({
        name: "nocode_list_workflows",
        arguments: {},
      });
      assert.equal(workflows.isError, undefined);
      assert.match(JSON.stringify(workflows.content), /review-repair/);

      const workflow = await client.callTool({
        name: "nocode_start_workflow",
        arguments: {
          workflowId: "review-repair",
          repositoryUrl: "https://github.com/example/workflow-target.git",
          fresh: true,
          placement: "remote",
        },
      });
      assert.equal(workflow.isError, undefined);
      assert.match(JSON.stringify(workflow.content), /workflow/);
      assert.equal(
        executions.lastWorkflowInput?.repositoryUrl,
        "https://github.com/example/workflow-target.git",
      );
    } finally {
      await client.close();
      await close();
    }
  });

  it("rejects unauthenticated non-loopback binding", () => {
    assert.throws(
      () => validateGatewayBinding("0.0.0.0", undefined),
      /NOCODE_GATEWAY_TOKEN is required/,
    );
    assert.doesNotThrow(() => validateGatewayBinding("127.0.0.1", undefined));
    assert.doesNotThrow(() => validateGatewayBinding("0.0.0.0", token));
  });
});

class StubExecutionApi implements ExecutionApi {
  private status: ExecutionSession["status"] = "queued";
  lastLaunchInput?: LaunchExecutionInput;
  lastWorkflowInput?: LaunchWorkflowInput;

  listAgents(): readonly AgentSummary[] {
    return [
      {
        id: "sample-agent",
        name: "Sample Agent",
        description: "A test agent",
        runtime: "node",
        harness: { id: "test-harness", version: 1 },
        availablePlacements: ["local", "remote"],
        sandboxProfiles: {
          local: {
            isolation: "container",
            image: "node:22-alpine",
            cpuLimit: 1,
            memoryMb: 512,
            pidsLimit: 128,
            networkMode: "none",
            workspaceAccess: "read-write",
          },
          remote: {
            isolation: "hyper-v",
            poolProfile: "test-pool",
            cpuLimit: 1,
            memoryMb: 2048,
            networkMode: "bridge",
            workspaceAccess: "read-write",
          },
        },
      },
    ];
  }

  listWorkflows(): readonly WorkflowDescriptor[] {
    return [
      {
        id: "review-repair",
        kind: "review-repair",
        identity: { subject: "workflow://nocode/review-repair" },
        name: "Review Repair",
        description: "Test workflow",
        version: "1.0.0",
        inputs: {
          repositoryUrl: {
            type: "string",
            description: "HTTPS Git repository URL",
            required: true,
          },
          fresh: {
            type: "boolean",
            description: "Prepare fresh workspaces",
            required: false,
            default: false,
          },
        },
        configuration: {
          coderCaseId: "testcase-1",
          reviewerCaseId: "testcase-3",
          repairAgentId: "repair-agent",
        },
      },
    ];
  }

  listSessions(): readonly ExecutionSession[] {
    return [this.session()];
  }

  getSession(_reference: string): ExecutionSession {
    return this.session();
  }

  launch(input: LaunchExecutionInput): ExecutionSession {
    this.lastLaunchInput = input;
    this.status = "queued";
    return { ...this.session(), placement: input.placement };
  }

  launchWorkflow(input: LaunchWorkflowInput): ExecutionSession {
    this.lastWorkflowInput = input;
    this.status = "queued";
    return { ...this.session(), agentId: "workflow" };
  }

  resolveApproval(_reference: string, approved: boolean): ExecutionSession {
    this.status = approved ? "running" : "failed";
    return this.session();
  }

  cancel(_reference: string): ExecutionSession {
    this.status = "cancelled";
    return this.session();
  }

  subscribe(_listener: () => void): () => void {
    return () => {};
  }

  complete(): void {
    this.status = "completed";
  }

  private session(): ExecutionSession {
    return {
      id: "execution-1",
      agentId: "sample-agent",
      agentName: "Sample Agent",
      repositoryUrl: "https://github.com/example/repository",
      placement: "remote",
      status: this.status,
      ...(this.status === "completed" ? { summary: "Done" } : {}),
      runs: [],
      events:
        this.status === "completed"
          ? [
              {
                type: "session.completed",
                timestamp: "2026-01-01T00:00:01.000Z",
                sessionId: "execution-1",
                message: "Execution completed",
              },
            ]
          : [],
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    };
  }
}

async function startGateway(executions: ExecutionApi): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server = createGatewayServer({ executions, token });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function authorizationHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

async function responseJson(response: Response): Promise<ExecutionSession> {
  return (await response.json()) as ExecutionSession;
}