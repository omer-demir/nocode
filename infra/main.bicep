targetScope = 'subscription'

@description('Azure region for all regional resources.')
param location string

@description('Resource group that owns the development environment.')
param resourceGroupName string

@description('Environment label applied to names and tags.')
param environmentName string = 'dev'

@description('Generation suffix used when recreating session infrastructure.')
param sessionGeneration string = 'v2'

@description('Object ID of the user or service principal deploying and operating the development environment.')
param deploymentPrincipalObjectId string

@description('Create the custom session pool after the private image has been published to ACR.')
param deploySessionPool bool = false

@description('Repository path for the custom session image.')
param sessionImageRepository string = 'nocode/coding-session'

@description('Immutable tag for the custom session image.')
param sessionImageTag string = '0.2.0'

var uniqueSuffix = take(uniqueString(subscription().id, resourceGroupName), 7)
var registryName = 'crnocodesession${uniqueSuffix}'
var pullIdentityName = 'id-nocode-session-pull-${environmentName}'
var workspaceName = 'log-nocode-session-${environmentName}'
var appInsightsName = 'appi-nocode-session-${environmentName}'
var managedEnvironmentName = 'cae-nocode-session-${environmentName}-${sessionGeneration}'
var sessionPoolName = 'spnocodesession${environmentName}${sessionGeneration}'
var grafanaName = take('amg-nocode-${environmentName}-${uniqueSuffix}', 23)
var tags = {
  environment: environmentName
  workload: 'nocode-agent'
  managedBy: 'bicep'
}

resource resourceGroup 'Microsoft.Resources/resourceGroups@2024-11-01' = {
  name: resourceGroupName
  location: location
  tags: tags
}

module registry './modules/registry.bicep' = {
  name: 'registry-${environmentName}'
  scope: resourceGroup
  params: {
    location: location
    registryName: registryName
    pullIdentityName: pullIdentityName
    tags: tags
  }
}

module monitoring './modules/monitoring.bicep' = {
  name: 'monitoring-${environmentName}'
  scope: resourceGroup
  params: {
    location: location
    workspaceName: workspaceName
    appInsightsName: appInsightsName
    deploymentPrincipalObjectId: deploymentPrincipalObjectId
    tags: tags
  }
}

module grafana './modules/grafana.bicep' = {
  name: 'grafana-${environmentName}'
  scope: resourceGroup
  params: {
    location: location
    grafanaName: grafanaName
    deploymentPrincipalObjectId: deploymentPrincipalObjectId
    tags: tags
  }
}

module sessions './modules/sessions.bicep' = if (deploySessionPool) {
  name: 'sessions-${environmentName}'
  scope: resourceGroup
  params: {
    location: location
    managedEnvironmentName: managedEnvironmentName
    sessionPoolName: sessionPoolName
    sessionImage: '${registry.outputs.loginServer}/${sessionImageRepository}:${sessionImageTag}'
    registryServer: registry.outputs.loginServer
    pullIdentityResourceId: registry.outputs.pullIdentityResourceId
    workspaceResourceId: monitoring.outputs.workspaceResourceId
    deploymentPrincipalObjectId: deploymentPrincipalObjectId
    tags: tags
  }
}

output resourceGroupName string = resourceGroup.name
output registryName string = registry.outputs.registryName
output registryLoginServer string = registry.outputs.loginServer
output appInsightsName string = monitoring.outputs.appInsightsName
output grafanaName string = grafana.outputs.grafanaName
output grafanaEndpoint string = grafana.outputs.endpoint
output sessionPoolName string = sessionPoolName
output sessionPoolEndpoint string = sessions.?outputs.poolManagementEndpoint ?? ''
