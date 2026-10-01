targetScope = 'resourceGroup'

@description('Azure region for the Container Apps resources.')
param location string

@description('Container Apps managed environment name.')
param managedEnvironmentName string

@description('Custom dynamic session pool name.')
param sessionPoolName string

@description('Fully qualified custom session image reference.')
param sessionImage string

@description('Azure Container Registry login server.')
param registryServer string

@description('Resource ID of the image-pull user-assigned managed identity.')
param pullIdentityResourceId string

@description('Resource ID of the Log Analytics workspace receiving session diagnostics.')
param workspaceResourceId string

@description('Object ID authorized to allocate and invoke sessions.')
param deploymentPrincipalObjectId string

@description('Tags applied to all resources.')
param tags object

var sessionExecutorRoleDefinitionId = '0fb8eba5-a2bb-4abe-b1c1-49dfad359bb0'

resource managedEnvironment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: managedEnvironmentName
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'azure-monitor'
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    zoneRedundant: false
  }
}

resource environmentDiagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-session-environment'
  scope: managedEnvironment
  properties: {
    workspaceId: workspaceResourceId
    logAnalyticsDestinationType: 'Dedicated'
    logs: [
      {
        category: 'AppEnvSessionConsoleLogs'
        enabled: true
      }
      {
        category: 'AppEnvSessionLifeCycleLogs'
        enabled: true
      }
      {
        category: 'AppEnvSessionPoolEventLogs'
        enabled: true
      }
    ]
  }
}

resource sessionPool 'Microsoft.App/sessionPools@2025-02-02-preview' = {
  name: sessionPoolName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${pullIdentityResourceId}': {}
    }
  }
  properties: {
    environmentId: managedEnvironment.id
    poolManagementType: 'Dynamic'
    containerType: 'CustomContainer'
    dynamicPoolConfiguration: {
      lifecycleConfiguration: {
        lifecycleType: 'Timed'
        cooldownPeriodInSeconds: 300
      }
    }
    scaleConfiguration: {
      maxConcurrentSessions: 10
      readySessionInstances: 1
    }
    sessionNetworkConfiguration: {
      status: 'EgressEnabled'
    }
    managedIdentitySettings: [
      {
        identity: pullIdentityResourceId
        lifecycle: 'None'
      }
    ]
    customContainerTemplate: {
      registryCredentials: {
        server: registryServer
        identity: pullIdentityResourceId
      }
      ingress: {
        targetPort: 3000
      }
      containers: [
        {
          name: 'coding-session'
          image: sessionImage
          resources: {
            cpu: 1
            memory: '2Gi'
          }
          probes: [
            {
              type: 'Startup'
              httpGet: {
                path: '/health'
                port: 3000
                scheme: 'HTTP'
              }
              initialDelaySeconds: 1
              periodSeconds: 2
              timeoutSeconds: 1
              failureThreshold: 30
              successThreshold: 1
            }
          ]
        }
      ]
    }
  }
}

resource poolMetrics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: 'diag-session-pool-metrics'
  scope: sessionPool
  properties: {
    workspaceId: workspaceResourceId
    metrics: [
      {
        category: 'AllMetrics'
        enabled: true
      }
    ]
  }
}

resource sessionExecutor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(sessionPool.id, deploymentPrincipalObjectId, sessionExecutorRoleDefinitionId)
  scope: sessionPool
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', sessionExecutorRoleDefinitionId)
    principalId: deploymentPrincipalObjectId
    principalType: 'User'
  }
}

output poolManagementEndpoint string = sessionPool.properties.poolManagementEndpoint
