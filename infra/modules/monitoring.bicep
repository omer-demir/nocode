targetScope = 'resourceGroup'

@description('Azure region for monitoring resources.')
param location string

@description('Log Analytics workspace name.')
param workspaceName string

@description('Workspace-based Application Insights component name.')
param appInsightsName string

@description('Object ID authorized to publish development telemetry.')
param deploymentPrincipalObjectId string

@description('Tags applied to all resources.')
param tags object

var monitoringMetricsPublisherRoleDefinitionId = '3913510d-42f4-4e42-8a64-420c390055eb'

resource workspace 'Microsoft.OperationalInsights/workspaces@2025-02-01' = {
  name: workspaceName
  location: location
  tags: tags
  properties: {
    retentionInDays: 30
    sku: {
      name: 'PerGB2018'
    }
    features: {
      disableLocalAuth: true
      enableLogAccessUsingOnlyResourcePermissions: true
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  kind: 'web'
  tags: tags
  properties: {
    Application_Type: 'web'
    DisableIpMasking: false
    DisableLocalAuth: true
    IngestionMode: 'LogAnalytics'
    RetentionInDays: 30
    WorkspaceResourceId: workspace.id
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

resource telemetryPublisher 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(appInsights.id, deploymentPrincipalObjectId, monitoringMetricsPublisherRoleDefinitionId)
  scope: appInsights
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', monitoringMetricsPublisherRoleDefinitionId)
    principalId: deploymentPrincipalObjectId
    principalType: 'User'
  }
}

output workspaceResourceId string = workspace.id
output appInsightsName string = appInsights.name
