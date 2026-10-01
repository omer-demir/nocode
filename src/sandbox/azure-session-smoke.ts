import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AzureContainerAppsSessionPoolProvider } from "./azure-container-apps-session-pool-provider.js";

const endpoint = process.env.AZURE_CONTAINER_APPS_SESSION_POOL_ENDPOINT;
if (!endpoint) {
  throw new Error("AZURE_CONTAINER_APPS_SESSION_POOL_ENDPOINT is required");
}

const workspacePath = await mkdtemp(join(tmpdir(), "nocode-azure-session-"));
const provider = new AzureContainerAppsSessionPoolProvider({
  endpoint,
  networkMode: "bridge",
});
let sandboxId: string | undefined;

try {
  await writeFile(join(workspacePath, "input.txt"), "azure-session-smoke\n");
  const sandbox = await provider.create({
    workspacePath,
    workspaceAccess: "read-write",
    networkMode: "bridge",
  });
  sandboxId = sandbox.id;
  const result = await provider.execute({
    sandboxId,
    command: [
      "node",
      "-e",
      "require('node:fs').writeFileSync('output.txt', process.version)",
    ],
    timeoutMs: 30_000,
  });
  const completedSandboxId = sandboxId;
  sandboxId = undefined;
  await provider.terminate(completedSandboxId);
  const exportedValue = await readFile(join(workspacePath, "output.txt"), "utf8");
  console.log(
    JSON.stringify({
      provider: sandbox.provider,
      exitCode: result.exitCode,
      nodeVersion: exportedValue,
      outputTruncated: result.truncated,
    }),
  );
} finally {
  if (sandboxId) {
    await provider.terminate(sandboxId);
  }
  await rm(workspacePath, { recursive: true, force: true });
}