using './main.bicep'

param location = 'swedencentral'
param resourceGroupName = 'rg-nocode-session-dev'
param environmentName = 'dev'
param sessionGeneration = 'v2'
param deploymentPrincipalObjectId = ''
param deploySessionPool = false
param sessionImageRepository = 'nocode/coding-session'
param sessionImageTag = '0.2.0'
