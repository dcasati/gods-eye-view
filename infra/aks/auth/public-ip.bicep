param location string = resourceGroup().location
param publicIPName string
param dnsLabel string

resource publicIP 'Microsoft.Network/publicIPAddresses@2024-05-01' = {
  name: publicIPName
  location: location
  sku: {
    name: 'Standard'
    tier: 'Regional'
  }
  properties: {
    publicIPAllocationMethod: 'Static'
    publicIPAddressVersion: 'IPv4'
    dnsSettings: {
      domainNameLabel: dnsLabel
    }
  }
}

output address string = publicIP.properties.ipAddress
output hostname string = publicIP.properties.dnsSettings.fqdn
