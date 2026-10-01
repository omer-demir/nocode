targetScope = 'resourceGroup'

@description('Azure region for Azure Managed Grafana.')
param location string

@description('Globally unique Azure Managed Grafana workspace name.')
param grafanaName string

@description('Object ID granted Grafana administrator access.')
param deploymentPrincipalObjectId string

@description('Tags applied to all resources.')
param tags object

var monitoringReaderRoleDefinitionId = '43d0d8ad-25c7-4714-9337-8ba259a9fe05'
var grafanaAdminRoleDefinitionId = '22926164-76b3-42b3-bc55-97df8dab3e41'

resource grafana 'Microsoft.Dashboard/grafana@2024-10-01' = {
  name: grafanaName
  location: location
  tags: tags
  sku: {
    name: 'Standard'
  }
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    apiKey: 'Disabled'
    deterministicOutboundIP: 'Disabled'
    publicNetworkAccess: 'Enabled'
    zoneRedundancy: 'Disabled'
    grafanaConfigurations: {
      security: {
        csrfAlwaysCheck: true
      }
      snapshots: {
        externalEnabled: false
      }
      users: {
        viewersCanEdit: false
      }
    }
  }
}

resource grafanaMonitoringReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, grafana.id, monitoringReaderRoleDefinitionId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', monitoringReaderRoleDefinitionId)
    principalId: grafana.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

resource grafanaAdmin 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(grafana.id, deploymentPrincipalObjectId, grafanaAdminRoleDefinitionId)
  scope: grafana
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', grafanaAdminRoleDefinitionId)
    principalId: deploymentPrincipalObjectId
    principalType: 'User'
  }
}

output grafanaName string = grafana.name
output endpoint string = grafana.properties.endpoint
