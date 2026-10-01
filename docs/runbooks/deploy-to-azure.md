---
title: Deploy the NoCode Agent Platform to Azure
description: Provision the Azure execution and observability plane, publish the session image, and verify a governed agent run
ms.date: 2026-10-01
ms.topic: how-to
---

## Deployment Scope

The current Bicep deployment provisions the Azure execution and observability
plane:

- Azure Container Registry with a private custom session image
- User-assigned managed identity with registry pull access
- Azure Container Apps environment and custom dynamic session pool
- Log Analytics and workspace-based Application Insights
- Azure Managed Grafana with Azure Monitor access
- Session diagnostics, pool metrics, and least-privilege role assignments

The gateway, CLI, and TUI continue to run on the operator's machine. They call
Microsoft Foundry for model inference and use the Azure session pool for
sandboxed tool execution. The template does not create the Foundry resource,
model deployment, public gateway hosting, DNS, or TLS.

> [!IMPORTANT]
> This is a development baseline. It uses one Sweden Central pool with public
> Azure endpoints, internet egress, one warm session, and a maximum of 10
> concurrent sessions. It is not the multi-region production topology for
> 25,000 developers.

## Prerequisites

Install or obtain:

- Node.js 22 or later
- Azure CLI with Bicep support
- An Azure subscription where you can create resources and role assignments
- An existing Microsoft Foundry Responses API deployment
- `Cognitive Services OpenAI User` on the Foundry resource

The deployment principal needs permission to create role assignments. Use
`Owner`, or combine `Contributor` with `Role Based Access Control
Administrator`, at the target resource-group or subscription scope.

Install project dependencies and authenticate:

```bash
npm install
az login
```

## Set Deployment Variables

Run these commands from the repository root. Replace the subscription when you
target another environment.

```bash
export AZURE_SUBSCRIPTION_ID=""
export AZURE_LOCATION="swedencentral"
export AZURE_RESOURCE_GROUP="rg-nocode-session-dev"
export FOUNDATION_DEPLOYMENT="nocode-session-dev-foundation-v2"
export POOL_DEPLOYMENT="nocode-session-dev-v2"
export SESSION_IMAGE_TAG="0.2.0"

az account set --subscription "$AZURE_SUBSCRIPTION_ID"
export DEPLOYMENT_PRINCIPAL_OBJECT_ID="$(az ad signed-in-user show \
  --query id \
  --output tsv)"

az account show \
  --query '{subscription:name,subscriptionId:id,tenantId:tenantId}' \
  --output table
printf 'Deployment principal: %s\n' "$DEPLOYMENT_PRINCIPAL_OBJECT_ID"
```

For service-principal or workload-identity deployment, set
`DEPLOYMENT_PRINCIPAL_OBJECT_ID` to that principal's object ID instead of using
`az ad signed-in-user show`.

The checked-in `infra/main.dev.bicepparam` contains development defaults. The
commands below override its operator-specific object ID and image tag.

## Register Azure Providers

Register each resource provider used by the template:

```bash
for namespace in \
  Microsoft.App \
  Microsoft.ContainerRegistry \
  Microsoft.Dashboard \
  Microsoft.Insights \
  Microsoft.ManagedIdentity \
  Microsoft.OperationalInsights
do
  az provider register --namespace "$namespace" --wait
done
```

Validate the Bicep template before provisioning:

```bash
az bicep version
az bicep build --file infra/main.bicep
```

## Deploy the Foundation

The first stage creates the resource group, registry, monitoring resources,
Grafana workspace, identities, and role assignments. The session pool remains
disabled until its private image exists.

Preview the foundation deployment:

```bash
az deployment sub what-if \
  --location "$AZURE_LOCATION" \
  --template-file infra/main.bicep \
  --parameters infra/main.dev.bicepparam \
  --parameters \
    location="$AZURE_LOCATION" \
    resourceGroupName="$AZURE_RESOURCE_GROUP" \
    deploymentPrincipalObjectId="$DEPLOYMENT_PRINCIPAL_OBJECT_ID" \
    deploySessionPool=false \
    sessionImageTag="$SESSION_IMAGE_TAG"
```

Create the foundation:

```bash
az deployment sub create \
  --name "$FOUNDATION_DEPLOYMENT" \
  --location "$AZURE_LOCATION" \
  --template-file infra/main.bicep \
  --parameters infra/main.dev.bicepparam \
  --parameters \
    location="$AZURE_LOCATION" \
    resourceGroupName="$AZURE_RESOURCE_GROUP" \
    deploymentPrincipalObjectId="$DEPLOYMENT_PRINCIPAL_OBJECT_ID" \
    deploySessionPool=false \
    sessionImageTag="$SESSION_IMAGE_TAG"

export ACR_NAME="$(az deployment sub show \
  --name "$FOUNDATION_DEPLOYMENT" \
  --query properties.outputs.registryName.value \
  --output tsv)"

printf 'Registry: %s\n' "$ACR_NAME"
```

## Build the Session Image

Use ACR Tasks to build and publish the Node and Python session image without
requiring a local Docker daemon:

```bash
az acr build \
  --registry "$ACR_NAME" \
  --image "nocode/coding-session:$SESSION_IMAGE_TAG" \
  sandbox-images/coding
```

Use a new immutable tag whenever the image changes. Azure Container Apps
session pools can retain the image configured on an existing generation.

Confirm that the image exists:

```bash
az acr repository show-tags \
  --name "$ACR_NAME" \
  --repository nocode/coding-session \
  --output table
```

## Deploy the Session Pool

The second stage enables the custom session pool after the image is available:

```bash
az deployment sub what-if \
  --location "$AZURE_LOCATION" \
  --template-file infra/main.bicep \
  --parameters infra/main.dev.bicepparam \
  --parameters \
    location="$AZURE_LOCATION" \
    resourceGroupName="$AZURE_RESOURCE_GROUP" \
    deploymentPrincipalObjectId="$DEPLOYMENT_PRINCIPAL_OBJECT_ID" \
    deploySessionPool=true \
    sessionImageTag="$SESSION_IMAGE_TAG"

az deployment sub create \
  --name "$POOL_DEPLOYMENT" \
  --location "$AZURE_LOCATION" \
  --template-file infra/main.bicep \
  --parameters infra/main.dev.bicepparam \
  --parameters \
    location="$AZURE_LOCATION" \
    resourceGroupName="$AZURE_RESOURCE_GROUP" \
    deploymentPrincipalObjectId="$DEPLOYMENT_PRINCIPAL_OBJECT_ID" \
    deploySessionPool=true \
    sessionImageTag="$SESSION_IMAGE_TAG"
```

Capture the deployment outputs in your shell:

```bash
export AZURE_CONTAINER_APPS_SESSION_POOL_ENDPOINT="$(az deployment sub show \
  --name "$POOL_DEPLOYMENT" \
  --query properties.outputs.sessionPoolEndpoint.value \
  --output tsv)"
export APPLICATION_INSIGHTS_NAME="$(az deployment sub show \
  --name "$POOL_DEPLOYMENT" \
  --query properties.outputs.appInsightsName.value \
  --output tsv)"
export AZURE_GRAFANA_NAME="$(az deployment sub show \
  --name "$POOL_DEPLOYMENT" \
  --query properties.outputs.grafanaName.value \
  --output tsv)"
export AZURE_GRAFANA_ENDPOINT="$(az deployment sub show \
  --name "$POOL_DEPLOYMENT" \
  --query properties.outputs.grafanaEndpoint.value \
  --output tsv)"

printf 'Session pool: %s\nGrafana: %s\n' \
  "$AZURE_CONTAINER_APPS_SESSION_POOL_ENDPOINT" \
  "$AZURE_GRAFANA_ENDPOINT"
```

These values are resource coordinates, not credentials. Do not capture Azure
access tokens or bearer tokens in source-controlled files.

## Configure the Runtime

Set the session-pool contract and Application Insights connection string:

```bash
export AZURE_TOKEN_CREDENTIALS="AzureCliCredential"
export NOCODE_SANDBOX_PROVIDER="azure-container-apps-session-pool"
export AZURE_CONTAINER_APPS_SESSION_POOL_NETWORK_MODE="bridge"
export AZURE_CONTAINER_APPS_SESSION_POOL_PROFILE="node-hyperv-1cpu-2gi-egress"
export AZURE_CONTAINER_APPS_SESSION_POOL_CPU_LIMIT="1"
export AZURE_CONTAINER_APPS_SESSION_POOL_MEMORY_MB="2048"
export APPLICATIONINSIGHTS_CONNECTION_STRING="$(az resource show \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --resource-type Microsoft.Insights/components \
  --name "$APPLICATION_INSIGHTS_NAME" \
  --api-version 2020-02-02 \
  --query properties.ConnectionString \
  --output tsv)"
```

The catalog currently points Foundry agents to the existing
`gpt-5.4-mini` deployment. `DefaultAzureCredential` obtains model and session
pool tokens through the active Azure CLI login. No model key is required.

## Import the Grafana Dashboard

Install the Azure Managed Grafana CLI extension and import the checked-in
dashboard definition:

```bash
az extension add --name amg --allow-preview true --yes
az grafana dashboard import \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --name "$AZURE_GRAFANA_NAME" \
  --definition infra/dashboards/nocode-session-overview.json \
  --overwrite true
```

Open the workspace:

```bash
open "$AZURE_GRAFANA_ENDPOINT"
```

## Route Foundry Diagnostics

Send Foundry request metadata to the same Log Analytics workspace. The current
development Foundry resource is in `rg-multi-agent-qa`; override these values
for another environment.

```bash
export FOUNDRY_RESOURCE_GROUP="rg-multi-agent-qa"
export FOUNDRY_RESOURCE_NAME=""
export LOG_ANALYTICS_WORKSPACE="log-nocode-session-dev"

export FOUNDRY_RESOURCE_ID="$(az resource show \
  --resource-group "$FOUNDRY_RESOURCE_GROUP" \
  --resource-type Microsoft.CognitiveServices/accounts \
  --name "$FOUNDRY_RESOURCE_NAME" \
  --query id \
  --output tsv)"
export LOG_ANALYTICS_WORKSPACE_ID="$(az monitor log-analytics workspace show \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --workspace-name "$LOG_ANALYTICS_WORKSPACE" \
  --query id \
  --output tsv)"

az monitor diagnostic-settings create \
  --name nocode-foundry-guardrails \
  --resource "$FOUNDRY_RESOURCE_ID" \
  --workspace "$LOG_ANALYTICS_WORKSPACE_ID" \
  --logs '[{"category":"RequestResponse","enabled":true},{"category":"AzureOpenAIRequestUsage","enabled":true}]' \
  --metrics '[{"category":"AllMetrics","enabled":true}]'
```

## Verify the Deployment

Exercise workspace import, command execution, export, and cleanup without a
model call:

```bash
npm run sandbox:smoke:azure
```

Send a baseline application trace:

```bash
npm run trace:smoke
```

Start the TUI:

```bash
npm run tui -- --verbose
```

Run the fail-closed host-boundary simulation:

```text
/agent run sandbox-escape-simulator <repo https url>
```

The expected result is one denied `security.escape_attempt`, zero sandbox
commands, three `security.detected` events, a failed session, and sandbox
termination. The three signals are `root-filesystem-access`,
`credential-discovery`, and `container-runtime-access`.

Verify the exported security metrics in Log Analytics:

```bash
export LOG_ANALYTICS_CUSTOMER_ID="$(az monitor log-analytics workspace show \
  --resource-group "$AZURE_RESOURCE_GROUP" \
  --workspace-name "$LOG_ANALYTICS_WORKSPACE" \
  --query customerId \
  --output tsv)"

az monitor log-analytics query \
  --workspace "$LOG_ANALYTICS_CUSTOMER_ID" \
  --analytics-query 'AppMetrics
| where TimeGenerated > ago(1h)
| where Name == "nocode.security.detections"
| where tostring(Properties["agent.id"]) == "sandbox-escape-simulator"
| summarize Hits=sum(Sum) by Signal=tostring(Properties["signal"]), Boundary=tostring(Properties["boundary"])
| order by Signal asc' \
  --output table
```

Expect one row for each signal, with `Hits` equal to `1` and `Boundary` equal
to `host`. Azure Monitor ingestion can take several minutes.

## Run the Gateway

Start the loopback gateway when OpenCode, Pi, or another MCP client needs to
launch agents:

```bash
export NOCODE_GATEWAY_TOKEN="$(openssl rand -hex 32)"
printf 'Gateway token: %s\n' "$NOCODE_GATEWAY_TOKEN"
npm run gateway
```

The gateway always exposes local Docker as `local`. Because the Azure session
pool endpoint is configured above, it also exposes the session pool as
`remote`. Startup prints `Available placements: local, remote`. MCP, Pi, and
REST clients must pass `placement` for every execution or workflow launch. A
remote request is rejected when the Azure target is unavailable; it never
falls back to local execution.

Keep the token in the client process environment. Do not commit it or pass it
over plain HTTP outside the local machine. The gateway listens on
`http://127.0.0.1:8787` by default.

## Remove the Development Environment

> [!CAUTION]
> This command permanently deletes the session pool, registry images,
> telemetry, and Grafana workspace in the resource group.

```bash
az group delete \
  --name "$AZURE_RESOURCE_GROUP" \
  --subscription "$AZURE_SUBSCRIPTION_ID"
```

## Production Follow-Up

Before production rollout:

- Deploy the gateway as an Azure-hosted service with managed identity
- Replace direct user role assignments with workload identity assignments
- Add regional control planes and pools for the EU and US
- Separate egress-enabled coding pools from no-egress review pools
- Add private networking, DNS, TLS, and ingress controls
- Add durable queues, regional routing, autoscaling, quotas, and backpressure
- Define backup, disaster recovery, retention, and incident-response controls
- Load-test the target concurrency instead of using the development limit of 10

## Related Guidance

- [Azure Container Apps Session Pool Runbook](azure-container-apps-session-pool.md)
- [External Client Execution Samples](../../samples/external-clients/README.md)
- [System Architecture](../design/system-architecture.md)
- [Session Pool Architecture Decision](../decisions/0001-runtime-profile-session-pools.md)
