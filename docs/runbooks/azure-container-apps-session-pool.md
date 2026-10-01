---
title: Azure Container Apps Session Pool Runbook
description: Build and run the governed coding sandbox in an Azure Container Apps custom session pool
ms.date: 2026-09-29
ms.topic: how-to
---

## Execution Model

The Azure provider keeps governance, model calls, approvals, and OpenTelemetry
in the client process. Only workspace transfer and tool commands run in the
remote custom container session.

The session image exposes these routes on port `3000`:

* `GET /health`
* `POST /workspace/import`
* `POST /execute`
* `GET /workspace/export`

The provider uses `DefaultAzureCredential` with the
`https://dynamicsessions.io/.default` scope. It uses one opaque identifier for
the session, exports write-capable workspaces before shutdown, and calls the
session pool stop API in cleanup.

## Provision With Bicep

The subscription-scoped template creates the resource group, ACR, pull
identity, Log Analytics, Application Insights, Container Apps environment,
custom session pool, diagnostic settings, Managed Grafana, and least-privilege
role assignments. The session deployment creates one egress-enabled pool. It
uses two stages because ARM cannot build a container image.

Set the approved target subscription and register the Grafana provider:

```bash
az login
az account set --subscription <subscription_id>
az provider register --namespace Microsoft.Dashboard --wait
az bicep build --file infra/main.bicep
```

Deploy the foundation with the pool disabled:

```bash
az deployment sub create \
  --location swedencentral \
  --template-file infra/main.bicep \
  --parameters infra/main.dev.bicepparam \
  --name nocode-session-dev-foundation-v2

export ACR_NAME="$(az deployment sub show \
  --name nocode-session-dev-foundation-v2 \
  --query properties.outputs.registryName.value \
  --output tsv)"
```

Build the Node and Python coding image, then enable the custom pool:

```bash
az acr build \
  --registry "$ACR_NAME" \
  --image nocode/coding-session:0.2.0 \
  sandbox-images/coding

az deployment sub create \
  --location swedencentral \
  --template-file infra/main.bicep \
  --parameters infra/main.dev.bicepparam deploySessionPool=true \
  --name nocode-session-dev-v2
```

The image is a parameterized OCI contract with Node.js, Python 3, pip, and
virtual-environment support. Change `sessionImageRepository` and
`sessionImageTag` for another custom image that implements the same HTTP routes.
Use a new immutable tag for every image update because session pools cache
configured images.

The pull identity has only `AcrPull` on the registry. Its pool identity lifecycle
is `None`, so untrusted session code cannot request identity tokens.

Azure automatically runs each custom-container session in a Hyper-V sandbox.
Hyper-V isolation is not a per-request setting. Image, CPU, memory, egress,
lifecycle, and managed identity exposure are pool-level controls. Agent
declarations therefore name a required pool profile, and the runtime fails
closed when the configured endpoint does not satisfy that contract.

> [!IMPORTANT]
> Pool egress is fixed at pool level. The current pool is egress-enabled, so
> every remote workflow phase uses `bridge`. The reviewer remains read-only at
> the workspace and tool-policy layers, but it is not network-isolated from the
> pool.

The template grants the deploying principal `Azure ContainerApps Session
Executor` on the pool. `Container Apps SessionPools Contributor` manages pool
resources but does not replace this data-plane role.

## Run A Remote Scenario

Configure the runtime from the pool's published management endpoint:

```bash
export NOCODE_SANDBOX_PROVIDER="azure-container-apps-session-pool"
export AZURE_CONTAINER_APPS_SESSION_POOL_ENDPOINT="$(az deployment sub show \
  --name nocode-session-dev-v2 \
  --query properties.outputs.sessionPoolEndpoint.value \
  --output tsv)"
export AZURE_CONTAINER_APPS_SESSION_POOL_NETWORK_MODE="bridge"
export AZURE_CONTAINER_APPS_SESSION_POOL_PROFILE="node-hyperv-1cpu-2gi-egress"
export AZURE_CONTAINER_APPS_SESSION_POOL_CPU_LIMIT="1"
export AZURE_CONTAINER_APPS_SESSION_POOL_MEMORY_MB="2048"
```

For future scale or stronger isolation, add dedicated pools for workload classes
such as no-egress review and larger builds. The runtime already accepts an
`AZURE_CONTAINER_APPS_SESSION_POOLS` profile map, but the current infrastructure
template intentionally provisions only the existing egress pool.

Start the complete remote workflow in the TUI:

```bash
AZURE_TOKEN_CREDENTIALS="AzureCliCredential" \
npm run tui -- --verbose
```

Then enter:

```text
/workflow review-repair https://github.com/owner/repository.git fresh
```

Verify workspace import, Node execution, workspace export, and cleanup without
making a model call:

```bash
npm run sandbox:smoke:azure
```

Run the internet-enabled migration case:

```bash
npm run cli -- sample run \
  samples/last-hour-vue-migration/scenario.json \
  --case testcase-1 \
  --fresh \
  --yes
```

Progress events are written to stderr as they happen. The final scenario JSON
remains on stdout, which keeps it suitable for redirection or automation.

Local development authenticates pool and Foundry requests through your Azure
CLI identity. Production orchestration should use a workload managed identity
and Microsoft Entra Agent ID token exchange to obtain distinct, auditable agent
principals. Keep the session pool identity lifecycle set to `None`; enabling
`Main` would allow untrusted session code to request tokens for the pool
identity.

## Inspect Logs, Metrics, And Traces

The CLI emits sanitized session, model, sandbox, and tool progress without
printing prompts, source text, tool output, or credentials.

Route the Foundry model resource's request metadata to the same Log Analytics
workspace before using the native guardrail correlation panel:

```bash
FOUNDRY_RESOURCE_ID="$(az resource show \
  --resource-group <foundry-resource-group> \
  --resource-type Microsoft.CognitiveServices/accounts \
  --name <foundry-resource-name> \
  --query id \
  --output tsv)"
WORKSPACE_ID="$(az monitor log-analytics workspace show \
  --resource-group rg-nocode-session-dev \
  --workspace-name log-nocode-session-dev \
  --query id \
  --output tsv)"
az monitor diagnostic-settings create \
  --name nocode-foundry-guardrails \
  --resource "$FOUNDRY_RESOURCE_ID" \
  --workspace "$WORKSPACE_ID" \
  --logs '[{"category":"RequestResponse","enabled":true},{"category":"AzureOpenAIRequestUsage","enabled":true}]' \
  --metrics '[{"category":"AllMetrics","enabled":true}]'
```

`RequestResponse` records expose the HTTP status but not the content-filter
category. Correlate HTTP `400` records with `nocode.model.guardrail_hits`, which
contains sanitized provider classification such as `jailbreak`.

Enable diagnostic settings on the Container Apps environment and route the
session log categories to Log Analytics. Query custom container output with:

```kusto
AppEnvSessionConsoleLogs
| where TimeGenerated > ago(1h)
| order by TimeGenerated desc
```

Use `AppEnvSessionLifeCycleLogs` and `AppEnvSessionPoolEventLogs` for platform
lifecycle and pool events. Direct-to-workspace configurations can expose these
as custom tables with a `_CL` suffix.

Azure Monitor exposes `PoolExecutingPodCount`, `PoolPendingPodCount`, and
`PoolReadyPodCount` on the session pool. Configure local application telemetry
through the Azure CLI credential:

```bash
export AZURE_TOKEN_CREDENTIALS="AzureCliCredential"
export APPLICATIONINSIGHTS_CONNECTION_STRING="$(az resource show \
  --resource-group rg-nocode-session-dev \
  --resource-type Microsoft.Insights/components \
  --name appi-nocode-session-dev \
  --api-version 2020-02-02 \
  --query properties.ConnectionString \
  --output tsv)"

npm run trace:smoke
```

The Bicep deployment grants the operator `Monitoring Metrics Publisher` on
Application Insights. In an Azure-hosted gateway, omit
`AZURE_TOKEN_CREDENTIALS` and grant the same role to its managed identity.

Open the provisioned dashboard at: <grafana_link>

The dashboard definition lives at
`infra/dashboards/nocode-session-overview.json`. Reimport it after changing a
pool generation or dashboard query:

```bash
az extension add --name amg --allow-preview true --yes
az grafana dashboard import \
  --resource-group rg-nocode-session-dev \
  --name <grafana_name> \
  --definition infra/dashboards/nocode-session-overview.json \
  --overwrite true
```

## Isolation And MicroVMs

Azure Container Apps custom sessions run each session in a Microsoft-managed
Hyper-V sandbox. The pool accepts an OCI container image but does not expose a
selectable Firecracker, Kata, or other microVM runtime.

The `SandboxProvider` boundary can support a separate microVM-backed service in
the future. That service would need to implement workspace import, command
execution, workspace export, network-policy enforcement, and termination. The
Azure session pool provider itself cannot be switched to a custom hypervisor.

## Current Limits

* Workspace archives are capped at 256 MiB
* Captured command output is capped at 1 MiB per command
* One command runs at a time in each session
* Commands are synchronous HTTP requests with a maximum configured timeout of
  one hour
* Remote work should remain within the pool lifecycle and platform request
  limits

Use a submit, poll, and artifact protocol or a durable job service before
moving genuinely long-running tasks to this execution path.

## References

* [Use session pools in Azure Container Apps](https://learn.microsoft.com/azure/container-apps/session-pool)
* [Azure Container Apps custom container sessions](https://learn.microsoft.com/azure/container-apps/sessions-custom-container)
* [Authentication and session identifiers](https://learn.microsoft.com/azure/container-apps/sessions-usage)
* [Supported session pool metrics](https://learn.microsoft.com/azure/azure-monitor/reference/supported-metrics/microsoft-app-sessionpools-metrics)
