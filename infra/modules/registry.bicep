targetScope = 'resourceGroup'

@description('Azure region for the registry and pull identity.')
param location string

@description('Globally unique Azure Container Registry name.')
param registryName string

@description('User-assigned managed identity name for image pulls.')
param pullIdentityName string

@description('Tags applied to all resources.')
param tags object

var acrPullRoleDefinitionId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

resource registry 'Microsoft.ContainerRegistry/registries@2025-04-01' = {
  name: registryName
  location: location
  tags: tags
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    anonymousPullEnabled: false
    dataEndpointEnabled: false
    networkRuleBypassOptions: 'AzureServices'
    publicNetworkAccess: 'Enabled'
    policies: {
      azureADAuthenticationAsArmPolicy: {
        status: 'enabled'
      }
    }
  }
}

resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: pullIdentityName
  location: location
  tags: tags
  properties: {
    isolationScope: 'Regional'
  }
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(registry.id, pullIdentity.id, acrPullRoleDefinitionId)
  scope: registry
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleDefinitionId)
    principalId: pullIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

output registryName string = registry.name
output loginServer string = registry.properties.loginServer
output pullIdentityResourceId string = pullIdentity.id
