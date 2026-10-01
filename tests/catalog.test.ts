import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { FileCatalog, loadScenario } from "../src/catalog/file-catalog.js";
import { CatalogPolicyEngine } from "../src/governance/catalog-policy-engine.js";
import {
  FoundryContentFilterError,
  FoundryModelProvider,
} from "../src/agent/foundry-model-provider.js";
import {
  FOUNDRY_GUARDRAIL_PROBE_PROMPT,
  FoundryGuardrailProbeModelProvider,
} from "../src/agent/foundry-guardrail-probe-model-provider.js";
import { GuardrailCanaryModelProvider } from "../src/agent/guardrail-canary-model-provider.js";
import { resolveAgentModelConfiguration } from "../src/catalog/model-configuration.js";
import { ToolGateway } from "../src/tools/tool-gateway.js";
import type { SandboxProvider } from "../src/sandbox/sandbox-provider.js";

const catalogPath = resolve("samples/catalog");
const scenarioPath = resolve("samples/last-hour-vue-migration/scenario.json");

describe("file-backed agent catalog", () => {
  it("loads descriptions and validates all agent references", async () => {
    const catalog = await FileCatalog.load(catalogPath);
    assert.equal(catalog.list().length, 9);
    assert.equal(catalog.listWorkflows().length, 2);
    assert.deepEqual(catalog.getWorkflow("review-repair").configuration, {
      coderCaseId: "testcase-1",
      reviewerCaseId: "testcase-3",
      repairAgentId: "vue-migration-repairer",
    });
    assert.equal(
      catalog.getWorkflow("review-repair").identity.subject,
      "workflow://nocode/review-repair",
    );
    assert.deepEqual(catalog.getWorkflow("review-repair").inputs.repositoryUrl, {
      type: "string",
      description: "HTTPS Git repository URL to process in this workflow run.",
      required: true,
    });
    const developerFlow = catalog.getWorkflow("vue-migration-developer-flow");
    assert.equal(developerFlow.kind, "sequential");
    if (developerFlow.kind === "sequential") {
      assert.deepEqual(
        developerFlow.configuration.steps.map((step) => step.agentId),
        ["vue-migration-coder", "vue-migration-reviewer-implementor"],
      );
      assert.deepEqual(developerFlow.configuration.steps[1]?.workspace, {
        source: "step-output",
        stepId: "implement",
      });
    }
    assert.match(catalog.get("vue-migration-coder").description, /Migrates/);
    assert.equal(catalog.get("offline-code-reviewer").mode, "subagent");
    assert.equal(catalog.get("vue-migration-repairer").role, "repair-agent");
    assert.equal(catalog.get("python-repository-coder").runtime, "python");
    assert.deepEqual(catalog.get("vue-migration-coder").harness, {
      id: "governed-code-change",
      version: 1,
    });
    assert.deepEqual(
      catalog.get("python-repository-coder").tools,
      catalog.get("vue-migration-coder").tools,
    );
    assert.match(
      catalog.get("python-repository-coder").instructions,
      /Operate only through the provided governed tools/,
    );
    assert.deepEqual(
      catalog.get("offline-code-reviewer").sandbox.profiles.remote,
      {
        isolation: "hyper-v",
        poolProfile: "node-hyperv-1cpu-2gi-egress",
        cpuLimit: 1,
        memoryMb: 2048,
        networkMode: "bridge",
        workspaceAccess: "read-only",
      },
    );
    assert.equal(
      catalog.get("vue-migration-coder").identity.subject,
      "agent://nocode/vue-migration-coder",
    );
    assert.deepEqual(catalog.get("vue-migration-coder").model, {
      provider: "microsoft-foundry",
      endpoint:
        "https://omerdemir-9440-resource.services.ai.azure.com/openai/v1/responses",
      deployment: "gpt-5.4-mini",
    });
    assert.deepEqual(catalog.get("rogue-agent-simulator").tools, [
      "filesystem.write",
    ]);
    assert.deepEqual(catalog.get("guardrail-canary").tools, [
      "security.canary",
    ]);
    assert.deepEqual(catalog.get("guardrail-canary").model, {
      provider: "deterministic-guardrail-canary",
    });
    assert.deepEqual(catalog.get("foundry-guardrail-simulator").model, {
      provider: "microsoft-foundry-guardrail-probe",
      endpoint:
        "https://omerdemir-9440-resource.services.ai.azure.com/openai/v1/responses",
      deployment: "gpt-5.4-mini",
    });
    assert.deepEqual(catalog.get("foundry-guardrail-simulator").tools, []);
    assert.deepEqual(catalog.get("sandbox-escape-simulator").tools, [
      "security.escape_attempt",
    ]);
    assert.deepEqual(catalog.get("sandbox-escape-simulator").model, {
      provider: "microsoft-foundry",
      endpoint:
        "https://omerdemir-9440-resource.services.ai.azure.com/openai/v1/responses",
      deployment: "gpt-5.4-mini",
      requireToolOnFirstTurn: true,
    });
    assert.equal(
      catalog.get("sandbox-escape-simulator").sandbox.profiles.local
        .workspaceAccess,
      "read-only",
    );
    assert.equal(
      catalog.get("guardrail-canary").sandbox.profiles.remote.workspaceAccess,
      "read-only",
    );
  });

  it("allows runtime overrides of declared Foundry configuration", async () => {
    const catalog = await FileCatalog.load(catalogPath);
    const resolved = resolveAgentModelConfiguration(
      catalog.get("vue-migration-coder").model,
      {
        FOUNDRY_RESPONSES_ENDPOINT: "https://override.example/openai/v1/responses",
        FOUNDRY_MODEL: "override-model",
      },
    );
    assert.deepEqual(resolved, {
      provider: "microsoft-foundry",
      endpoint: "https://override.example/openai/v1/responses",
      deployment: "override-model",
    });
  });

  it("defines testcase 3 as testcase 1 output", async () => {
    const scenario = await loadScenario(scenarioPath);
    const review = scenario.testCases.find((testCase) => testCase.id === "testcase-3");
    assert.deepEqual(review?.workspace, {
      source: "test-case-output",
      testCaseId: "testcase-1",
    });
  });

  it("denies write and network tools for the offline reviewer", async () => {
    const catalog = await FileCatalog.load(catalogPath);
    const reviewer = catalog.get("offline-code-reviewer");
    const policy = new CatalogPolicyEngine(reviewer, catalog.tools);
    const write = await policy.evaluate({
      id: "write",
      name: "filesystem.write",
      arguments: {},
    });
    const install = await policy.evaluate({
      id: "install",
      name: "package.install",
      arguments: {},
    });
    const diff = await policy.evaluate({
      id: "diff",
      name: "git.diff",
      arguments: {},
    });
    assert.equal(write.outcome, "DENY");
    assert.equal(install.outcome, "DENY");
    assert.equal(diff.outcome, "ALLOW");
  });

  it("always denies the live rogue-agent write before tool execution", async () => {
    const catalog = await FileCatalog.load(catalogPath);
    const simulator = catalog.get("rogue-agent-simulator");
    const policy = new CatalogPolicyEngine(simulator, catalog.tools);
    const decision = await policy.evaluate({
      id: "rogue-write",
      name: "filesystem.write",
      arguments: {
        path: ".nocode-rogue-attempt.txt",
        content: "THIS SHOULD NEVER BE WRITTEN",
      },
    });

    assert.equal(decision.outcome, "DENY");
    assert.equal(decision.rule, "agent-policy:rogue-agent-simulator");
  });

  it("deterministically requests and verifies the denied guardrail canary", async () => {
    const catalog = await FileCatalog.load(catalogPath);
    const simulator = catalog.get("guardrail-canary");
    const model = new GuardrailCanaryModelProvider();
    let commandsExecuted = 0;
    const sandboxProvider: SandboxProvider = {
      placement: "local",
      async create() {
        return { id: "canary-sandbox", provider: "local-docker" };
      },
      async execute() {
        commandsExecuted += 1;
        throw new Error("The denied canary must not execute in the sandbox");
      },
      async terminate() {},
    };
    const gateway = new ToolGateway({
      sandboxProvider,
      sandboxId: "canary-sandbox",
      policyEngine: new CatalogPolicyEngine(simulator, catalog.tools),
      approvalHandler: { async request() { return false; } },
    });
    const first = await model.complete([
      { role: "user", content: "Run the guardrail canary" },
    ]);
    assert.equal(first.toolRequest?.name, "security.canary");

    const result = await gateway.invoke(first.toolRequest!);
    assert.equal(result.success, false);
    assert.equal(result.telemetry?.policyOutcome, "DENY");
    assert.equal(result.telemetry?.commandCount, 0);
    assert.equal(commandsExecuted, 0);

    const completed = await model.complete([
      { role: "user", content: "Run the guardrail canary" },
      { role: "assistant", toolRequest: first.toolRequest },
      {
        role: "tool",
        result: {
          toolCallId: result.toolCallId,
          success: result.success,
          output: result.output,
        },
      },
    ]);
    assert.match(completed.content ?? "", /Guardrail canary passed/);
  });

  it("preserves sanitized Foundry content-filter error metadata", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          error: {
            message: "The response was filtered by the content policy.",
            code: "content_filter",
            innererror: { code: "ContentFiltered" },
            content_filters: [
              {
                blocked: true,
                source_type: "prompt",
                content_filter_results: {
                  hate: { filtered: false, severity: "safe" },
                  jailbreak: { detected: true, filtered: true },
                },
              },
            ],
          },
        }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );

    try {
      const provider = new FoundryModelProvider({
        endpoint: "https://model.example/openai/v1/responses",
        model: "test-model",
        tokenProvider: async () => "test-token",
      });
      await assert.rejects(
        provider.complete([{ role: "user", content: "guardrail canary" }]),
        (error: unknown) => {
          assert.ok(error instanceof FoundryContentFilterError);
          assert.equal(error.statusCode, 400);
          assert.equal(error.code, "content_filter");
          assert.equal(error.innerCode, "ContentFiltered");
          assert.deepEqual(error.categories, ["jailbreak"]);
          assert.equal(error.source, "prompt");
          return true;
        },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("retries a native Foundry guardrail hit twice before asking the client", async () => {
    const originalFetch = globalThis.fetch;
    const requestBodies: Record<string, unknown>[] = [];
    globalThis.fetch = async (_input, init) => {
      requestBodies.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>,
      );
      if (requestBodies.length <= 2) {
        return new Response(
          JSON.stringify({
            error: {
              message: "Filtered by the content policy.",
              code: "content_filter",
              innererror: { code: "ContentFiltered" },
              content_filters: [
                {
                  blocked: true,
                  source_type: "prompt",
                  content_filter_results: {
                    jailbreak: { detected: true, filtered: true },
                  },
                },
              ],
            },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          model: "test-model",
          output_text:
            "Azure Foundry blocked this request twice because of a guardrail. How would you like to proceed?",
          usage: {
            input_tokens: 20,
            output_tokens: 15,
            total_tokens: 35,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    try {
      const provider = new FoundryGuardrailProbeModelProvider({
        endpoint: "https://model.example/openai/v1/responses",
        model: "test-model",
        tokenProvider: async () => "test-token",
      });
      const response = await provider.complete([
        { role: "user", content: "Run the native guardrail test" },
      ]);
      assert.equal(requestBodies.length, 3);
      assert.equal(
        (requestBodies[0]?.input as Array<{ content?: string }>)[0]?.content,
        FOUNDRY_GUARDRAIL_PROBE_PROMPT,
      );
      assert.equal(
        (requestBodies[1]?.input as Array<{ content?: string }>)[0]?.content,
        FOUNDRY_GUARDRAIL_PROBE_PROMPT,
      );
      assert.doesNotMatch(
        JSON.stringify(requestBodies[2]),
        new RegExp(FOUNDRY_GUARDRAIL_PROBE_PROMPT),
      );
      assert.deepEqual(
        response.guardrailHits?.map((hit) => ({
          attempt: hit.attempt,
          category: hit.categories[0],
        })),
        [
          { attempt: 1, category: "jailbreak" },
          { attempt: 2, category: "jailbreak" },
        ],
      );
      assert.match(response.content ?? "", /How would you like to proceed\?/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("exposes only the selected agent instructions and tools to the model", async () => {
    const catalog = await FileCatalog.load(catalogPath);
    const reviewer = catalog.get("offline-code-reviewer");
    const tools = reviewer.tools.map((name) => catalog.getTool(name));
    const originalFetch = globalThis.fetch;
    let requestBody: Record<string, unknown> | undefined;
    let requestUrl: string | undefined;
    let authorization: string | null | undefined;
    globalThis.fetch = async (input, init) => {
      requestUrl = String(input);
      authorization = new Headers(init?.headers).get("Authorization");
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          model: "test-model",
          output: [
            {
              type: "reasoning",
              summary: [
                {
                  type: "summary_text",
                  text: "Inspected the available repository evidence.",
                },
              ],
            },
            {
              type: "message",
              content: [{ type: "output_text", text: "reviewed" }],
            },
          ],
          usage: {
            input_tokens: 120,
            input_tokens_details: { cached_tokens: 40 },
            output_tokens: 30,
            output_tokens_details: { reasoning_tokens: 10 },
            total_tokens: 150,
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    try {
      const provider = new FoundryModelProvider({
        endpoint: "https://model.example/openai/v1/responses",
        model: "test-model",
        instructions: reviewer.instructions,
        tools,
        reasoningSummary: "auto",
        tokenProvider: async () => "test-token",
      });
      const response = await provider.complete([
        { role: "user", content: "Review the patch" },
      ]);
      const apiTools = requestBody?.tools as Array<{ name: string }>;
      assert.equal(requestUrl, "https://model.example/openai/v1/responses");
      assert.equal(authorization, "Bearer test-token");
      assert.equal(requestBody?.instructions, reviewer.instructions);
      assert.deepEqual(requestBody?.reasoning, { summary: "auto" });
      assert.equal(response.content, "reviewed");
      assert.equal(
        response.reasoningSummary,
        "Inspected the available repository evidence.",
      );
      assert.equal(response.usage?.provider, "microsoft-foundry");
      assert.equal(response.usage?.model, "test-model");
      assert.equal(response.usage?.inputTokens, 120);
      assert.equal(response.usage?.outputTokens, 30);
      assert.equal(response.usage?.totalTokens, 150);
      assert.equal(response.usage?.cachedInputTokens, 40);
      assert.equal(response.usage?.reasoningTokens, 10);
      assert.equal(response.usage?.userInputCharacters, 16);
      assert.equal(
        response.usage?.fixedInputBytes,
        Buffer.byteLength(reviewer.instructions) +
          Buffer.byteLength(JSON.stringify(requestBody?.tools)),
      );
      assert.equal(
        response.usage?.requestBytes,
        Buffer.byteLength(JSON.stringify(requestBody)),
      );
      assert.deepEqual(
        apiTools.map((tool) => tool.name),
        ["filesystem_read", "filesystem_search", "git_diff"],
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("continues Foundry responses with governed function results", async () => {
    const originalFetch = globalThis.fetch;
    const requestBodies: Record<string, unknown>[] = [];
    let requestCount = 0;
    globalThis.fetch = async (_input, init) => {
      requestBodies.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>,
      );
      requestCount += 1;
      return new Response(
        JSON.stringify(
          requestCount === 1
            ? {
                output: [
                  {
                    type: "function_call",
                    call_id: "call-1",
                    name: "filesystem_read",
                    arguments: '{"path":"package.json"}',
                  },
                ],
              }
            : { output_text: "done" },
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    try {
      const provider = new FoundryModelProvider({
        endpoint: "https://model.example/openai/v1/responses",
        model: "test-model",
        requireToolOnFirstTurn: true,
        tokenProvider: async () => "test-token",
      });
      const first = await provider.complete([
        { role: "user", content: "Read package.json" },
      ]);
      assert.deepEqual(first.toolRequest, {
        id: "call-1",
        name: "filesystem.read",
        arguments: { path: "package.json" },
      });

      const second = await provider.complete([
        { role: "user", content: "Read package.json" },
        { role: "assistant", toolRequest: first.toolRequest },
        {
          role: "tool",
          result: {
            toolCallId: "call-1",
            success: true,
            output: '{"name":"nocode-agent-platform"}',
          },
        },
      ]);
      const continuation = requestBodies[1]?.input as Array<
        Record<string, unknown>
      >;
      assert.equal(requestBodies[0]?.tool_choice, "required");
      assert.equal(requestBodies[1]?.tool_choice, "none");
      assert.equal(continuation[1]?.type, "function_call");
      assert.equal(continuation[2]?.type, "function_call_output");
      assert.equal(second.content, "done");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});