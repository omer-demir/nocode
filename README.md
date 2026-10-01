---
title: NoCode Governed Agent Platform
description: Governed coding agent with local Docker or Azure Container Apps session isolation and OpenTelemetry
ms.date: 2026-10-01
ms.topic: overview
---

## Scope

This repository implements the first local vertical slice from the platform
design. A CLI runs a model-driven agent loop, every tool request passes through
policy and the Tool Gateway, and commands execute in a disposable Docker
sandbox. OpenTelemetry connects the session, model, policy, tool, and sandbox
operations in one trace.

The implementation covers three hackathon increments:

* PR-001: OTel Collector, Grafana, Tempo, Prometheus, and an `agent.session`
  smoke trace
* PR-002: `SandboxProvider` and `LocalDockerSandboxProvider` with independent
  unit and Docker integration tests
* PR-003: CLI, agent loop, policy, Tool Gateway, Docker execution, and the
  `filesystem.read`, `filesystem.write`, `filesystem.search`, and `test.run`
  tools

## Prerequisites

* Node.js 22 or later
* Docker Engine with Docker Compose v2
* An npm-based or Python target repository
* Azure CLI only for agents that use Microsoft Foundry inference

Docker Desktop provides Docker Engine and Compose on macOS and Windows. On
Linux, install Docker Engine and the Compose plugin. Allocate at least 4 GB of
memory to Docker so the observability services and an agent sandbox can run at
the same time.

Verify the required tools:

```bash
node --version
npm --version
docker --version
docker compose version
docker info
```

## Local Docker Quick Start

This path starts the complete local execution plane from a clean clone. It uses
Docker for telemetry services and disposable agent sandboxes. The first smoke
test uses the deterministic demo model, so it needs no Azure account, model
credentials, or API key.

### Install And Build

```bash
git clone <repository-url>
cd lithocode_prep
npm ci
docker compose pull
docker compose up -d --wait
npm run sandbox:build
```

The Compose stack and sandbox image are separate:

* `docker compose up` starts Grafana, Prometheus, Tempo, and the OpenTelemetry
  Collector
* `npm run sandbox:build` creates `nocode/coding-sandbox:0.2.0`, the image used
  for governed Node.js and Python repository operations
* The runtime creates a new restricted sandbox container for each execution and
  removes it when the execution ends

Confirm that everything is ready:

```bash
docker compose ps
docker image inspect nocode/coding-sandbox:0.2.0 >/dev/null
curl --fail http://localhost:3000/api/health
curl --fail http://localhost:9090/-/ready
curl --fail http://localhost:3200/ready
```

All four Compose services should report a running state, and each command
should exit successfully.

### Run A Credential-Free Smoke Test

Create a disposable npm repository under the ignored workspace directory:

```bash
mkdir -p .agent-workspaces/local-smoke-target
cat > .agent-workspaces/local-smoke-target/package.json <<'JSON'
{
  "name": "local-smoke-target",
  "private": true,
  "scripts": {
    "test": "node -e \"console.log('local sandbox test passed')\""
  }
}
JSON
```

Run the deterministic agent against that repository:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
  npm run cli -- run "Verify the local Docker workflow" \
  --repo "$PWD/.agent-workspaces/local-smoke-target" \
  --provider demo \
  --yes
```

The run should search and read `package.json`, create `.nocode-demo.txt`, run
the target repository's test script, and finish with `Completed the governed
read, search, write, and test workflow.` The sandbox container is removed
automatically. Open Grafana at <http://localhost:3000> to inspect the trace and
the NoCode Agent Sessions dashboard.

> [!IMPORTANT]
> Use a disposable clone or a repository with a clean working tree for agent
> testing. Local sandbox writes are applied to the bind-mounted target
> repository.

### Run Catalog Agents Locally

Catalog agents use Microsoft Foundry for inference while keeping repository
execution in local Docker containers. Sign in with an identity that has the
`Cognitive Services OpenAI User` role on the configured Foundry resource:

```bash
az login
az account get-access-token \
  --resource https://ai.azure.com \
  --query expiresOn \
  --output tsv
npm run tui
```

Choose `local` placement in the launch wizard. Do not set
`NOCODE_SANDBOX_PROVIDER` or any
`AZURE_CONTAINER_APPS_SESSION_POOL_*` variables for this path. The default
provider is `local-docker`.

From the TUI, verify discovery before starting work:

```text
/agent list
/workflow list
```

Then launch an agent against a reachable HTTPS Git repository:

```text
/vue-migrator https://github.com/owner/repository.git
```

The selected local sandbox profile controls network access. Coding profiles use
Docker bridge networking so they can clone repositories and install declared
packages. The offline reviewer uses Docker network mode `none`.

### Start The Local Gateway

The gateway is optional. Start it when testing OpenCode, Pi, MCP, or the HTTP
API:

```bash
export NOCODE_GATEWAY_TOKEN="$(openssl rand -hex 32)"
printf 'Gateway token: %s\n' "$NOCODE_GATEWAY_TOKEN"
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 npm run gateway
```

Keep that terminal running. In another terminal, verify the gateway:

```bash
export NOCODE_GATEWAY_TOKEN="<token-printed-by-the-gateway-terminal>"
curl --fail http://127.0.0.1:8787/health
curl --fail \
  -H "Authorization: Bearer $NOCODE_GATEWAY_TOKEN" \
  http://127.0.0.1:8787/api/agents
```

The gateway binds only to `127.0.0.1` by default and advertises `local`
placement. It adds remote placement only when
`AZURE_CONTAINER_APPS_SESSION_POOL_ENDPOINT` is configured.

For OpenCode, generate a local configuration under the ignored workspace
directory. This replaces the checked-in authorization placeholder without
putting the token in a tracked file:

```bash
mkdir -p .agent-workspaces/opencode
node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";

const source = "samples/external-clients/opencode/opencode.json";
const target = ".agent-workspaces/opencode/opencode.json";
const config = JSON.parse(readFileSync(source, "utf8"));
config.mcp.nocode.headers.Authorization =
  `Bearer ${process.env.NOCODE_GATEWAY_TOKEN}`;
writeFileSync(target, `${JSON.stringify(config, null, 2)}\n`);
NODE
export OPENCODE_CONFIG="$PWD/.agent-workspaces/opencode/opencode.json"
opencode
```

The [external client runbook](samples/external-clients/README.md) contains the
MCP, Pi, and HTTP examples.

### Stop And Reset The Local Environment

Stop the processes running the TUI or gateway with `Ctrl+C`, then stop the
Compose services:

```bash
docker compose down --remove-orphans
```

Add `--volumes` when you also want to remove local Grafana, Prometheus, and
Tempo data:

```bash
docker compose down --remove-orphans --volumes
```

Remove the optional smoke target and sandbox image when a full reset is needed:

```bash
rm -rf .agent-workspaces/local-smoke-target
docker image rm nocode/coding-sandbox:0.2.0
```

### Troubleshoot Local Startup

* If `docker compose up --wait` fails, run `docker compose ps` and
  `docker compose logs <service-name>` to inspect the failing service
* If an agent reports that `nocode/coding-sandbox:0.2.0` is missing, run
  `npm run sandbox:build` from the repository root
* If ports `3000`, `3200`, `4317`, `4318`, `8787`, or `9090` are already in
  use, stop the conflicting process or change the corresponding local
  configuration before retrying
* If Foundry returns an authorization error, repeat `az login`, verify the
  active subscription with `az account show`, and confirm the required role
* If a previous run stopped unexpectedly, inspect labeled containers with
  `docker ps -a --filter label=nocode.sandbox=true` before removing only the
  stale container by ID
* On native Linux, local sandboxes run as user and group `1000:1000`. If writes
  fail, verify the target repository permissions with `id` and `ls -ld`, then
  grant that user access to the disposable test repository
* If package installation fails in a coding sandbox, confirm Docker has network
  access and that the selected agent profile uses bridge networking

## Start Observability

Install dependencies and start the local stack:

```bash
npm ci
docker compose up -d --wait
```

Emit the baseline trace:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 npm run cli -- doctor
```

The command prints the trace ID. Open Grafana at <http://localhost:3000>, select
Explore and the Tempo data source, then search for that ID or for the
`service.name` value `agentctl`.

Grafana also provisions the
[NoCode Agent Sessions dashboard](http://localhost:3000/d/nocode-agent-sessions-local/nocode-agent-sessions-local)
in the NoCode folder. The dashboard reads runtime metrics from Prometheus and
agent traces from Tempo. Its scorecards cover prompt and context growth, tool
usage and errors, agent autonomy, token asymmetry, repository writes and rework,
governance decisions, guardrail hits, model-provider rate limits, and potential
rogue-agent signals. A rogue-agent signal means policy blocked an action outside
the agent's allowed tools or capabilities. It does not assert that an identity
is compromised.

Estimated model cost remains empty until both USD rates are configured. Supply
the rates published for the deployed model instead of embedding prices in the
catalog:

```bash
export NOCODE_MODEL_INPUT_COST_PER_MILLION_TOKENS="<input-rate>"
export NOCODE_MODEL_OUTPUT_COST_PER_MILLION_TOKENS="<output-rate>"
```

Telemetry exports numeric sizes, counts, policy categories, bounded rule names,
and path fingerprints. It does not export prompt text, source code, file paths,
credentials, command text, raw tool output, or chain-of-thought.

Run the vertical slice below to populate the panels.

Prometheus is available at <http://localhost:9090>, Tempo at
<http://localhost:3200>, and the Collector accepts OTLP/HTTP on port `4318`.

## Run The Vertical Slice

The deterministic demo provider needs no model credentials. It searches and
reads `package.json`, requests approval to write `.nocode-demo.txt`, and runs
the target repository's `npm test` script:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
  npm run cli -- run "Prove the governed workflow" \
  --repo /absolute/path/to/npm-repository \
  --provider demo \
  --yes
```

Omit `--yes` to approve the write interactively. In a noninteractive process,
an unapproved write is denied. Reads, searches, and the fixed test command are
allowed. Unregistered tools are denied by default.

For Microsoft Foundry, sign in through Azure CLI. The identity needs the
`Cognitive Services OpenAI User` role on the Foundry resource:

```bash
az login
az account get-access-token \
  --resource https://ai.azure.com \
  --query expiresOn \
  --output tsv

OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
  npm run cli -- run "Fix the failing tests" \
  --repo /absolute/path/to/npm-repository \
  --provider foundry
```

`DefaultAzureCredential` obtains and refreshes the bearer token from the Azure
CLI login. No model key is read or stored. Catalog agents declare their model
provider, endpoint, and deployment in `samples/catalog/agents.json`:

```json
"model": {
  "provider": "microsoft-foundry",
  "endpoint": "https://omerdemir-9440-resource.services.ai.azure.com/openai/v1/responses",
  "deployment": "gpt-5.4-mini"
}
```

The TUI and scenario runner resolve this declaration for each selected agent.
`FOUNDRY_RESPONSES_ENDPOINT` and `FOUNDRY_MODEL` remain optional process-wide
overrides for diagnostics or emergency routing. Foundry authentication uses the
`https://ai.azure.com/.default` token scope.

Agents pin a shared harness from `samples/catalog/harnesses.json`. The harness
owns reusable baseline instructions, capabilities, tool allowlists, and approval
policy. Agent entries retain identity, role-specific instructions, model,
runtime, and sandbox selection. The resolved harness ID and version are included
in runtime telemetry for audit correlation.

Workflows are registered in `samples/catalog/workflows.json`. Each definition
declares its logical identity, version, supported inputs, and participant
configuration. The TUI and gateway resolve workflow executions from this
registry. Sequential workflows declare ordered agent steps and explicit
workspace handoffs between those steps.

List the same registry from the CLI with `npm run cli -- workflows`.

## Validate

Run fast tests and compilation checks:

```bash
npm run typecheck
npm run typecheck:samples
npm test
npm run build
```

Run the real Docker integration suite:

```bash
RUN_DOCKER_TESTS=1 npm test
```

Export the integration trace to the local Collector:

```bash
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
  RUN_DOCKER_TESTS=1 npm test
```

Stop the observability environment with `docker compose down`.

## Execution Boundaries

The agent runtime has no shell or filesystem implementation. It can only submit
typed tool requests to the Tool Gateway. The gateway applies policy, validates
paths, obtains write approval, and calls the injected `SandboxProvider`.

The local provider invokes Docker without a host shell and uses these defaults:

* Non-root user `1000:1000`
* No network
* Read-only container root filesystem
* All Linux capabilities dropped
* `no-new-privileges`
* CPU, memory, process, duration, and output limits
* No Docker socket mount

The repository workspace is the only writable bind mount. The provider always
removes its disposable container when a session completes or fails.

The Azure provider archives the prepared workspace, imports it into a custom
Azure Container Apps session, invokes commands through the image's HTTP API,
exports permitted changes, and stops the session. Follow the
[Azure deployment guide](docs/runbooks/deploy-to-azure.md) to provision the
development execution and observability plane. Use the
[Azure session pool runbook](docs/runbooks/azure-container-apps-session-pool.md)
to deploy the Bicep infrastructure, build the Node test image, run the live
session smoke, and inspect Azure Monitor telemetry in Managed Grafana. The same
pool contract accepts versioned Python and other custom HTTP container images.

## Agent Catalog Samples

The [sample catalog](samples/README.md) keeps agent descriptions and
instructions, capability definitions, tool schemas, and scenario definitions in
JSON outside runtime code. It includes three LastHour Vue migration cases:

* Internet-enabled coding agent on a fresh clone
* Internet-enabled review-first agent implementing on an independent clone
* Offline, read-only code reviewer using the first case's output

List registered agent descriptions with `npm run cli -- agents`. Build the
Git-enabled sandbox with `npm run sandbox:build`, then follow the sample runbook
for individual or chained execution.

## Interactive Agent Console

Build the sandbox image, run `az login`, and start the terminal interface:

```bash
npm run sandbox:build
npm run tui
```

Discover and launch agents from the prompt:

```text
/agent list
/vue-migrator https://github.com/owner/repository.git
/vue-reviewer https://github.com/owner/repository.git
/python-coder https://github.com/owner/python-repository.git
/agent run offline-code-reviewer https://github.com/owner/repository.git
```

The launch wizard asks where to run the agent, accepts optional task details,
and requests confirmation. Confirmed work continues in the background while
the prompt remains usable. The sessions and activity panes show sanitized live
runtime events without displaying prompts, file contents, tool output, or
credentials.

Session history is persisted atomically to
`.agent-workspaces/sessions.json`. Completed, failed, and cancelled sessions can
be listed and attached after restarting the TUI. A session that was active when
the process stopped is restored as failed because its in-memory model loop and
approval continuations cannot be resumed. Use `--session-store <path>` to select
a different local store.

Use these commands to operate active sessions:

```text
/sessions
/session attach <session-id>
/session message <session-id> "Add integration tests"
/session run-agent <session-id> offline-code-reviewer "Review current changes"
/session history <session-id>
/session publish <session-id> --branch agent/vue-migration
/workspace <session-id>
/approve <session-id>
/deny <session-id>
/allow-all <session-id>
/deny-all <session-id>
/cancel <session-id>
```

Completed workflow phases appear under `Outputs` in the attached TUI session.
Their agent, phase, summary, workspace, and outcome are persisted in
`.agent-workspaces/sessions.json` and exposed as `runs` by the execution API.

Follow-up messages and additional agents reuse the exported workspace but run
in a new governed sandbox. They do not reconnect to a terminated container.
Each result is appended to the collaboration history. Publishing validates the
branch, commits the current delta, and pushes it to `origin`; the host running
the TUI must have Git credentials for that remote.

`/allow-all` and `/deny-all` remember the decision for later approval requests
in that execution. The remembered choice is discarded when the execution ends
or is cancelled; it is not persisted or reused by another agent session.

Start with expanded sanitized logs when you need session, sandbox, tool-call,
model usage, and logical agent identity details:

```bash
npm run tui -- --verbose
```

Verbose mode also requests an `auto` reasoning summary from supported Microsoft
Foundry Responses API models. A returned summary appears on the completed model
turn with latency and token usage. Reasoning summaries are model-generated,
may not be returned for every turn, and are not raw private chain-of-thought.
The TUI continues to exclude full prompts, file contents, credentials, and raw
tool output. See the Microsoft documentation for
[reasoning summaries](https://learn.microsoft.com/azure/foundry/openai/how-to/reasoning#reasoning-summary).

Run the included scenarios with `/test list` and `/test run <id|all>`. Testcase
3 depends on testcase 1 output, so use `/test run all` when that workspace has
not already been prepared. The console accepts the placement supported by the
configured sandbox provider.

Explore registered workflows and start the approval-gated review and repair
workflow from the TUI:

```text
/workflow list
/workflow run review-repair https://github.com/owner/repository.git fresh
```

The workflow declaration defines orchestration and agent handoffs. The caller
supplies the target repository for each run.

This allocates separate write, read-only, and write sessions for the coder,
reviewer, and repairer. Use `/approve <session-id>` after reviewing the findings
to start repair. With the current single Azure pool, every remote phase shares
the pool's network egress setting, but the reviewer still has read-only
workspace access and no network-capable tools.

## Python Repositories

The `python-repository-coder` agent uses the same sandbox image with Python 3,
pip, and virtual-environment support. Its governed package tool creates
`.venv`, installs fixed `pytest` and `build` tooling, then installs declared
packages or a workspace-relative requirements file. `test.run` maps to
`.venv/bin/python -m pytest`, and `build.run` maps to
`.venv/bin/python -m build`.

Launch it from the TUI with `/python-coder <repository-url>`. For another
Python agent, set `"runtime": "python"` in its catalog descriptor and retain
only the package, test, and build capabilities that role needs. Arbitrary shell
commands are not exposed.

## External Client Gateway

The shared gateway exposes the same governed controller to external clients
through a JSON API, SSE progress streams, and Streamable HTTP MCP. Start it
after building the sandbox and signing in with Azure CLI:

```bash
export NOCODE_GATEWAY_TOKEN="$(openssl rand -hex 32)"
npm run gateway
```

It binds to `127.0.0.1:8787` by default. OpenCode uses the MCP endpoint, while
the native Pi extension uses the HTTP API. Both can list agents and available
placements, explicitly select local Docker or the configured remote Azure
session pool, inspect executions, resolve approvals, and cancel work without
receiving host workspace paths or bypassing the Tool Gateway. The gateway
rejects unavailable placements instead of silently falling back.

Follow the [external client runbook](samples/external-clients/README.md) for
the ready OpenCode configuration, Pi extension, API examples, authentication,
and remote-host guidance.

## Current Limits

This slice supports fixed npm and Python package, test, and build commands. It
does not yet implement Git worktrees, credential brokering, asynchronous remote
commands, or arbitrary test frameworks. Those additions remain behind the
existing provider, model, policy, and tool interfaces described in the
[design documents](docs/design/README.md).
