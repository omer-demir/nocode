---
title: Agent Catalog Samples
description: File-backed agent, capability, tool, and scenario definitions for local governed-agent experiments
ms.date: 2026-09-29
ms.topic: how-to
---

## Layout

Sample data is separate from runtime code:

* `catalog/agents.json` contains Agent Registry identity, role instructions,
  runtime, model, sandbox profile, and a pinned harness reference
* `catalog/workflows.json` contains workflow identity, inputs, and participant
  configuration
* `catalog/harnesses.json` contains versioned shared instructions, capability
  sets, tool allowlists, and approval policy
* `catalog/capabilities.json` contains reusable capability descriptions
* `catalog/tools.json` contains model-facing tool descriptions, JSON parameter
  schemas, required capabilities, mutation flags, network requirements, and
  default policy decisions
* `last-hour-vue-migration/scenario.json` contains the repository, tasks,
  selected agents, independent clone rules, and testcase output dependency
* `external-clients/` contains OpenCode MCP and native Pi extension samples for
  the shared execution gateway

`FileCatalog` resolves each exact harness version and produces an effective
agent configuration. Harness instructions precede role-specific agent
instructions. Tools, capabilities, and tool policy come only from the harness,
so an agent cannot silently widen a shared harness. A later backend can
implement the same `AgentRegistry` contract and return the effective shape.

### Sequential Workflow Declaration

Declare an ordered developer flow in `catalog/workflows.json` with
`kind: "sequential"`. The first step clones the repository. Later steps use
`step-output` to receive an earlier step's workspace:

```json
{
  "id": "vue-migration-developer-flow",
  "kind": "sequential",
  "identity": {
    "subject": "workflow://nocode/vue-migration-developer-flow"
  },
  "name": "Vue Migration Developer Flow",
  "description": "Implement, then review and improve the migration.",
  "version": "1.0.0",
  "inputs": {
    "fresh": {
      "type": "boolean",
      "description": "Prepare a fresh workspace.",
      "required": false,
      "default": false
    }
  },
  "configuration": {
    "steps": [
      {
        "id": "implement",
        "agentId": "vue-migration-coder",
        "task": "Implement and validate the Vue migration.",
        "workspace": { "source": "clone" }
      },
      {
        "id": "review-and-improve",
        "agentId": "vue-migration-reviewer-implementor",
        "task": "Review the migration, implement corrections, and validate it.",
        "workspace": {
          "source": "step-output",
          "stepId": "implement"
        }
      }
    ]
  }
}
```

The registry validates agent IDs, unique step IDs, and backward-only workspace
references before the workflow can run.

## Agent Discovery

List the registered agents and their OpenCode-style descriptions:

```bash
npm run cli -- agents
```

Use `--catalog <directory>` to load another file-backed catalog.

## LastHour Scenario

The LastHour repository is an older Express and Mongoose application with no
checked-in public frontend. The scenario therefore introduces a Vue 3 and Vite
frontend rather than upgrading an existing Vue version.

Build the sandbox image before running a sample:

```bash
npm run sandbox:build
```

Sign in with the Azure CLI. The application uses `DefaultAzureCredential`, so
no API key is required:

```bash
az login
az account get-access-token \
  --resource https://ai.azure.com \
  --query expiresOn \
  --output tsv
```

Each sample agent declares its Foundry endpoint and deployment in
`catalog/agents.json`. The TUI and scenario runner use the selected agent's
declaration. Set `FOUNDRY_RESPONSES_ENDPOINT` or `FOUNDRY_MODEL` only when a
process-wide diagnostic or emergency override is required.

Run testcase 1 with a fresh clone, internet-enabled sandbox, package tools, and
write approval:

```bash
npm run cli -- sample run \
  samples/last-hour-vue-migration/scenario.json \
  --case testcase-1 \
  --fresh \
  --yes
```

Run testcase 2 against an independent fresh clone:

```bash
npm run cli -- sample run \
  samples/last-hour-vue-migration/scenario.json \
  --case testcase-2 \
  --fresh \
  --yes
```

Run testcase 3 after testcase 1. It reuses testcase 1's workspace with a
read-only bind mount, Docker network mode `none`, and only read, search, and Git
diff tools:

```bash
npm run cli -- sample run \
  samples/last-hour-vue-migration/scenario.json \
  --case testcase-3
```

Run the complete sequence in scenario order:

```bash
npm run cli -- sample run \
  samples/last-hour-vue-migration/scenario.json \
  --case all \
  --fresh \
  --yes
```

Run the gated coder, reviewer, and repair workflow:

```bash
npm run cli -- workflows
npm run cli -- workflow review-repair \
  https://github.com/owner/repository.git \
  --fresh
```

The workflow creates and terminates a separate sandbox for every phase. The
coder runs with write access and internet egress. The reviewer consumes the
exported coder workspace through a separate read-only sandbox. Its summary is
shown at an explicit acceptance gate. An accepted review starts the repair
agent in a new write-capable sandbox; a rejected review stops without allocating
that sandbox.

Start the same workflow from the TUI and keep its phases under one parent
session:

```text
/workflow list
/workflow run review-repair https://github.com/owner/repository.git fresh
```

Run the sequential developer flow with:

```text
/workflow run vue-migration-developer-flow https://github.com/owner/repository.git fresh
```

Repository URLs are runtime inputs. Workflow declarations remain reusable and
contain only orchestration, agent selection, tasks, and workspace handoffs.

After the workflow completes, inspect its outputs or continue work in the same
persisted workspace:

```text
/session attach <session-id>
/session history <session-id>
/session message <session-id> "Add integration tests"
/session run-agent <session-id> offline-code-reviewer "Review current changes"
/session publish <session-id> --branch agent/vue-migration
```

Every follow-up allocates a fresh sandbox. The session retains the workspace
and run history, not the terminated container or private model reasoning.

Interactive CLI approval prompts accept `a` or `allow-all` to approve later
tool requests without prompting, and `d` or `deny-all` to reject them. The
choice lasts only for the current workflow process. `--yes` approves all tool
requests and the review gate noninteractively.

Use `--yes` only for unattended sample runs where both tool approvals and the
review acceptance gate should be approved automatically. Override the default
participants with `--coder-case`, `--reviewer-case`, and `--repair-agent`.

> [!IMPORTANT]
> Current remote execution uses the existing
> `node-hyperv-1cpu-2gi-egress` pool for every phase. Reviewer tools and files
> remain read-only, but pool-level network egress is still technically
> available to its container.

Configure the existing pool:

```bash
export NOCODE_SANDBOX_PROVIDER="azure-container-apps-session-pool"
export AZURE_CONTAINER_APPS_SESSION_POOL_ENDPOINT="https://<pool-endpoint>"
export AZURE_CONTAINER_APPS_SESSION_POOL_NETWORK_MODE="bridge"
export AZURE_CONTAINER_APPS_SESSION_POOL_PROFILE="node-hyperv-1cpu-2gi-egress"
export AZURE_CONTAINER_APPS_SESSION_POOL_CPU_LIMIT="1"
export AZURE_CONTAINER_APPS_SESSION_POOL_MEMORY_MB="2048"
```

At larger scale or for stronger reviewer isolation, provision a separate
egress-disabled pool and configure `AZURE_CONTAINER_APPS_SESSION_POOLS` for
profile-based routing. That is an optional scaling and hardening step, not a
current deployment requirement.

## Python Repository Agents

Set `"runtime": "python"` on a catalog agent to select the governed Python
commands. The shared `0.2.0` sandbox image includes Python 3, pip, and virtual
environment support. `package.install` accepts package names or a
workspace-relative `requirementsFile`, while `test.run` executes pytest and
`build.run` builds the package through the virtual environment.

Prepared repositories are stored under `.agent-workspaces/`, which is ignored
by Git. Testcase 1 and testcase 2 use separate directories. Testcase 3 resolves
to the testcase 1 directory.

## Restricted Egress

Internet-capable agents use Docker bridge networking. When outbound container
traffic requires an explicit proxy, set one or more of these variables before
running a scenario:

```bash
export SANDBOX_HTTP_PROXY="http://proxy.example:8080"
export SANDBOX_HTTPS_PROXY="http://proxy.example:8080"
export SANDBOX_NO_PROXY="localhost,127.0.0.1"
```

Only agents with `network.internet` receive these values. Do not place proxy
credentials in these variables because processes inside an internet-enabled
sandbox can read their environment.

## Add An Agent

1. Select an immutable harness version from `catalog/harnesses.json`, or add a
  new version when the shared instructions or policy must change.
2. Add an object to `catalog/agents.json` with a stable ID, logical identity,
  version, role, mode, discovery description, role instructions, model
  configuration, and pinned harness reference.
3. Declare local Docker and remote Hyper-V sandbox profiles. The remote profile
  names the compatible Azure session-pool contract.
4. Add or update a scenario test case that references the agent ID.
5. Run `npm test` to validate harness references, catalog references, and policy
  behavior.

The catalog loader rejects sandbox network or workspace settings that conflict
with the `network.internet` and `workspace.write` capabilities. Runtime
providers also reject isolation, resource, network, or pool requirements they
cannot enforce. Scenario JSON cannot weaken those controls.

The identity subject, for example
`agent://nocode/vue-migration-coder`, is included in runtime events, policy
spans, logs, model metrics, and persisted sessions. It is an audit identity,
not an Azure credential.

## External Clients

The [external client runbook](external-clients/README.md) starts the shared
NoCode execution gateway and connects OpenCode, Pi, or a direct HTTP client.
All clients use the same controller, policy, approval, Tool Gateway, and
sandbox path as the interactive console.
