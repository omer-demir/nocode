#!/usr/bin/env node
import { resolve } from "node:path";
import { FileCatalog, loadScenario } from "../catalog/file-catalog.js";
import { RepositoryWorkspaceManager } from "../scenarios/workspace-manager.js";
import { startTelemetry } from "../telemetry/telemetry.js";
import { TuiController } from "../tui/controller.js";
import { TuiSessionStore } from "../tui/session-store.js";
import { ExecutionService } from "./execution-service.js";
import { createGatewayServer, validateGatewayBinding } from "./http-server.js";
import { createSandboxProviderForPlacement } from "../sandbox/create-sandbox-provider.js";

const host = option("--host") ?? process.env.NOCODE_GATEWAY_HOST ?? "127.0.0.1";
const port = parsePort(option("--port") ?? process.env.NOCODE_GATEWAY_PORT ?? "8787");
const token = process.env.NOCODE_GATEWAY_TOKEN;
validateGatewayBinding(host, token);

const catalog = await FileCatalog.load(
  resolve(option("--catalog") ?? "samples/catalog"),
);
const scenario = await loadScenario(
  resolve(
    option("--scenario") ?? "samples/last-hour-vue-migration/scenario.json",
  ),
);
const store = new TuiSessionStore();
const workspaceManager = new RepositoryWorkspaceManager(
  resolve(option("--workspace-root") ?? ".agent-workspaces"),
);
const localController = new TuiController({
  catalog,
  scenario,
  workspaceManager,
  store,
  sandboxProvider: createSandboxProviderForPlacement("local"),
});
const controllers: {
  local: TuiController;
  remote?: TuiController;
} = { local: localController };
if (process.env.AZURE_CONTAINER_APPS_SESSION_POOL_ENDPOINT) {
  controllers.remote = new TuiController({
    catalog,
    scenario,
    workspaceManager,
    store,
    sandboxProvider: createSandboxProviderForPlacement("remote"),
  });
}
const activeControllers = Object.values(controllers);
const telemetry = startTelemetry("nocode-gateway");
const server = createGatewayServer({
  executions: new ExecutionService(controllers, store),
  ...(token === undefined ? {} : { token }),
});

server.listen(port, host, () => {
  console.log(`NoCode execution gateway listening at http://${host}:${port}`);
  console.log(`REST API: http://${host}:${port}/api`);
  console.log(`MCP endpoint: http://${host}:${port}/mcp`);
  console.log(
    `Available placements: ${activeControllers
      .map((controller) => controller.sandboxPlacement())
      .join(", ")}`,
  );
});

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  for (const controller of activeControllers) controller.cancelAll();
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
  await Promise.all(activeControllers.map((controller) => controller.waitForIdle()));
  await telemetry.shutdown();
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function parsePort(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error(`Invalid gateway port: ${value}`);
  }
  return parsed;
}