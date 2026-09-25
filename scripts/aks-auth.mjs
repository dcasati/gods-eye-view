import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { probeEdge } from './aks-auth-probe.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const name = 'gods-eye-view-auth';
const settingsFile = path.join(root, 'infra/aks/auth/oauth2-proxy.cfg');

export function validateSettings(settings) {
  const required = [
    'context',
    'subscription',
    'resourceGroup',
    'cluster',
    'namespace',
    'tenantId',
    'clientId',
    'origin',
    'image',
  ];
  const allowed = [
    ...required,
    'publicIPName',
    'publicIPResourceGroup',
    'assignmentRequired',
  ];
  assert.deepEqual(
    Object.keys(settings).filter((key) => !allowed.includes(key)),
    [],
    'Unexpected settings (never store secrets here)',
  );
  for (const key of required)
    assert.ok(
      typeof settings[key] === 'string' && settings[key],
      `Missing ${key}`,
    );
  for (const key of ['subscription', 'tenantId', 'clientId']) {
    assert.match(
      settings[key],
      /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i,
      `Invalid ${key}`,
    );
  }
  assert.match(settings.namespace, /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
  const url = new URL(settings.origin);
  assert.equal(url.protocol, 'https:');
  assert.equal(
    url.origin,
    settings.origin,
    'Use an exact HTTPS origin without path or trailing slash',
  );
  assert.equal(url.port, '', 'Public access must use standard HTTPS port 443');
  assert.match(
    url.hostname,
    /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i,
  );
  assert.match(
    settings.image,
    /^quay\.io\/oauth2-proxy\/oauth2-proxy:v7\.15\.2@sha256:[0-9a-f]{64}$/,
  );
  assert.equal(
    typeof settings.assignmentRequired,
    'boolean',
    'Explicitly choose tenant-wide or assigned-user sign-in',
  );
  return settings;
}

export function environment(settings) {
  return {
    OAUTH2_PROXY_CLIENT_ID: settings.clientId,
    OAUTH2_PROXY_OIDC_ISSUER_URL: `https://login.microsoftonline.com/${settings.tenantId}/v2.0`,
    OAUTH2_PROXY_ENTRA_ID_ALLOWED_TENANTS: settings.tenantId,
    OAUTH2_PROXY_REDIRECT_URL: `${settings.origin}/oauth2/callback`,
    OAUTH2_PROXY_UPSTREAMS: `http://gods-eye-view.${settings.namespace}.svc.cluster.local:80/`,
  };
}

export function overlay(settings, directory) {
  validateSettings(settings);
  return {
    apiVersion: 'kustomize.config.k8s.io/v1beta1',
    kind: 'Kustomization',
    namespace: settings.namespace,
    resources: [path.relative(directory, path.join(root, 'infra/aks/auth'))],
    images: [
      {
        name: 'quay.io/oauth2-proxy/oauth2-proxy',
        newName: 'quay.io/oauth2-proxy/oauth2-proxy',
        newTag: 'v7.15.2',
        digest: settings.image.split('@')[1],
      },
    ],
    configMapGenerator: [
      {
        name: `${name}-environment`,
        literals: Object.entries(environment(settings)).map(
          ([key, value]) => `${key}=${value}`,
        ),
      },
    ],
    patches: [
      {
        target: { kind: 'ServiceAccount', name },
        patch: JSON.stringify([
          {
            op: 'replace',
            path: '/metadata/annotations/azure.workload.identity~1client-id',
            value: settings.clientId,
          },
        ]),
      },
    ],
  };
}

function command(executable, args, input) {
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    input,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${executable} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

export function assertPrivateServices(services, authName = name) {
  for (const service of services) {
    assert.ok(
      !service.spec.externalIPs?.length,
      `External IP bypass: ${service.metadata.name}`,
    );
    if (service.metadata.name !== authName) {
      assert.equal(
        service.spec.type,
        'ClusterIP',
        `Public/ExternalName bypass: ${service.metadata.name}`,
      );
      assert.ok(
        !service.spec.ports.some((port) => port.nodePort),
        'Unexpected application NodePort',
      );
    }
  }
}

async function portForward(settings) {
  const child = spawn(
    'kubectl',
    [
      '--context',
      settings.context,
      '-n',
      settings.namespace,
      'port-forward',
      '--address=127.0.0.1',
      `service/${name}`,
      ':443',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Private port-forward timed out'));
    }, 30000);
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = output.match(/Forwarding from 127\.0\.0\.1:(\d+)/);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', () => {
      clearTimeout(timer);
      reject(new Error('Private port-forward exited before readiness'));
    });
  });
  return { child, port };
}

export async function main([action, settingsPath]) {
  assert.ok(
    ['prepare', 'verify', 'verify-public', 'activate', 'rollback'].includes(
      action,
    ),
    'Usage: node scripts/aks-auth.mjs prepare|verify|verify-public|activate|rollback .azure/auth/settings.json',
  );
  assert.ok(settingsPath, 'Settings path is required');
  const resolved = path.resolve(settingsPath);
  const directory = path.dirname(resolved);
  assert.ok(
    directory.startsWith(path.join(root, '.azure') + path.sep),
    'Operational settings must remain beneath ignored .azure/',
  );
  const settings = validateSettings(JSON.parse(readFileSync(resolved, 'utf8')));
  if (action === 'prepare') {
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      path.join(directory, 'kustomization.yaml'),
      JSON.stringify(overlay(settings, directory), null, 2) + '\n',
    );
    console.log(
      'Auth-only ClusterIP overlay prepared. No Azure or Kubernetes resources changed.',
    );
    return;
  }
  const kube = (...args) =>
    command('kubectl', [
      '--context',
      settings.context,
      '-n',
      settings.namespace,
      ...args,
    ]);
  const get = (...args) => JSON.parse(kube('get', ...args, '-o', 'json'));
  const service = get('service', name);
  assert.deepEqual(service.spec.selector, { 'app.kubernetes.io/name': name });
  if (action === 'rollback') {
    // Preserve allocation and remove only the public route; never touch app/roads.
    const patch = [
      {
        op: 'test',
        path: '/metadata/resourceVersion',
        value: service.metadata.resourceVersion,
      },
      { op: 'replace', path: '/spec/type', value: 'ClusterIP' },
    ];
    service.spec.ports.forEach((port, index) => {
      if (port.nodePort)
        patch.push({ op: 'remove', path: `/spec/ports/${index}/nodePort` });
    });
    if (service.spec.healthCheckNodePort)
      patch.push({ op: 'remove', path: '/spec/healthCheckNodePort' });
    if (service.spec.externalTrafficPolicy)
      patch.push({ op: 'remove', path: '/spec/externalTrafficPolicy' });
    if (service.spec.allocateLoadBalancerNodePorts !== undefined)
      patch.push({ op: 'remove', path: '/spec/allocateLoadBalancerNodePorts' });
    kube('patch', 'service', name, '--type=json', '-p', JSON.stringify(patch));
    assert.equal(get('service', name).spec.type, 'ClusterIP');
    console.log(
      'Proxy returned to ClusterIP. Wait for Azure load-balancer reconciliation and verify the former endpoint is unreachable.',
    );
    return;
  }
  const az = (...args) => JSON.parse(command('az', [...args, '-o', 'json']));
  const account = az('account', 'show');
  assert.equal(account.id, settings.subscription);
  assert.equal(account.tenantId, settings.tenantId);
  const cluster = az(
    'aks',
    'show',
    '-g',
    settings.resourceGroup,
    '-n',
    settings.cluster,
    '--subscription',
    settings.subscription,
  );
  assert.equal(cluster.oidcIssuerProfile.enabled, true);
  assert.equal(cluster.securityProfile.workloadIdentity.enabled, true);
  const apiServer = JSON.parse(
    command('kubectl', [
      '--context',
      settings.context,
      'config',
      'view',
      '--minify',
      '-o',
      'json',
    ]),
  ).clusters[0].cluster.server;
  assert.ok(
    [cluster.fqdn, cluster.privateFqdn]
      .filter(Boolean)
      .includes(new URL(apiServer).hostname),
    'kubectl context is not the selected AKS cluster',
  );
  assertPrivateServices(get('services').items);
  // Cross-namespace ingress/Gateway routing needs an explicit review, not a guess.
  assert.equal(
    JSON.parse(
      command('kubectl', [
        '--context',
        settings.context,
        'get',
        'ingress',
        '-A',
        '-o',
        'json',
      ]),
    ).items.length,
    0,
    'Review existing Ingress routes before activation',
  );
  const resources = command('kubectl', [
    '--context',
    settings.context,
    'api-resources',
    '-o',
    'name',
  ]).split('\n');
  for (const resource of [
    'gateways.gateway.networking.k8s.io',
    'httproutes.gateway.networking.k8s.io',
    'tcproutes.gateway.networking.k8s.io',
  ]) {
    if (resources.includes(resource)) {
      assert.equal(
        JSON.parse(
          command('kubectl', [
            '--context',
            settings.context,
            'get',
            resource,
            '-A',
            '-o',
            'json',
          ]),
        ).items.length,
        0,
        'Review Gateway routes before activation',
      );
    }
  }
  const application = az('ad', 'app', 'show', '--id', settings.clientId);
  assert.equal(application.signInAudience, 'AzureADMyOrg');
  assert.deepEqual(application.web.redirectUris, [
    `${settings.origin}/oauth2/callback`,
  ]);
  assert.equal(
    application.passwordCredentials.length,
    0,
    'Unexpected application password',
  );
  assert.equal(
    application.keyCredentials.length,
    0,
    'Unexpected application certificate credential',
  );
  assert.equal(
    application.requiredResourceAccess.length,
    0,
    'Unexpected API permissions',
  );
  assert.equal(
    application.web.implicitGrantSettings.enableAccessTokenIssuance,
    false,
  );
  assert.equal(
    application.web.implicitGrantSettings.enableIdTokenIssuance,
    false,
  );
  const principal = az('ad', 'sp', 'show', '--id', settings.clientId);
  assert.equal(
    principal.appRoleAssignmentRequired,
    settings.assignmentRequired,
    'Entra assignment policy differs from approved settings',
  );
  const credentials = az(
    'ad',
    'app',
    'federated-credential',
    'list',
    '--id',
    settings.clientId,
  );
  assert.equal(
    credentials.length,
    1,
    'Use a dedicated auth app with only this federation',
  );
  assert.equal(credentials[0].issuer, cluster.oidcIssuerProfile.issuerUrl);
  assert.equal(
    credentials[0].subject,
    `system:serviceaccount:${settings.namespace}:${name}`,
  );
  assert.deepEqual(credentials[0].audiences, ['api://AzureADTokenExchange']);
  const sa = get('serviceaccount', name);
  assert.equal(
    sa.metadata.annotations['azure.workload.identity/client-id'],
    settings.clientId,
  );
  assert.equal(sa.automountServiceAccountToken, false);

  const rendered = command('kubectl', ['kustomize', directory]);
  const renderedObjects = command(
    'kubectl',
    [
      '--context',
      settings.context,
      '-n',
      settings.namespace,
      'create',
      '--dry-run=client',
      '-f',
      '-',
      '-o',
      'json',
    ],
    rendered,
  );
  // kubectl prints one JSON object per YAML document, not a JSON List.
  const expected = JSON.parse(
    command(
      'python3',
      [
        '-c',
        `
import json,sys
remaining=sys.stdin.read().strip()
objects=[]
while remaining:
    item,end=json.JSONDecoder().raw_decode(remaining)
    objects.extend(item["items"] if item.get("kind")=="List" else [item])
    remaining=remaining[end:].strip()
print(json.dumps(objects))
`,
      ],
      renderedObjects,
    ),
  );
  const deployment = get('deployment', name);
  const desired = expected.find((item) => item.kind === 'Deployment').spec
    .template.spec;
  const actual = deployment.spec.template.spec;
  assert.equal(actual.serviceAccountName, name);
  assert.equal(actual.automountServiceAccountToken, false);
  assert.ok(!actual.hostNetwork && !actual.hostPID && !actual.hostIPC);
  assert.equal(actual.initContainers?.length || 0, 0);
  assert.equal(actual.containers.length, 1);
  assert.equal(actual.containers[0].image, settings.image);
  assert.equal(actual.containers[0].command?.length || 0, 0);
  assert.ok(
    isDeepStrictEqual(actual.containers[0].args, [
      '--config=/etc/oauth2-proxy/config/oauth2-proxy.cfg',
    ]),
    'Only the reviewed configuration file may supply proxy options',
  );
  assert.ok(
    isDeepStrictEqual(actual.containers[0].env, [
      {
        name: 'OAUTH2_PROXY_COOKIE_SECRET',
        valueFrom: {
          secretKeyRef: { name: `${name}-cookie`, key: 'cookie-secret' },
        },
      },
    ]),
    'Unexpected environment override; secret values are never printed',
  );
  assert.equal(
    actual.containers[0].ports.some((port) => port.hostPort),
    false,
  );
  for (const key of [
    'args',
    'env',
    'envFrom',
    'volumeMounts',
    'securityContext',
  ]) {
    assert.ok(
      isDeepStrictEqual(actual.containers[0][key], desired.containers[0][key]),
      `Unexpected proxy ${key}`,
    );
  }
  assert.deepEqual(actual.volumes, desired.volumes, 'Unexpected proxy volume');
  assert.equal(
    deployment.spec.template.metadata.labels['azure.workload.identity/use'],
    'true',
  );
  assert.equal(
    deployment.status.observedGeneration,
    deployment.metadata.generation,
  );
  assert.equal(deployment.status.updatedReplicas, deployment.spec.replicas);
  assert.equal(deployment.status.availableReplicas, deployment.spec.replicas);
  assert.equal(deployment.status.readyReplicas, deployment.spec.replicas);
  const configVersions = [];
  for (const item of expected.filter(
    (resource) => resource.kind === 'ConfigMap',
  )) {
    const config = get('configmap', item.metadata.name);
    assert.ok(
      isDeepStrictEqual(config.data, item.data),
      'Live proxy configuration differs from prepared overlay',
    );
    configVersions.push([
      config.metadata.name,
      config.metadata.resourceVersion,
    ]);
    if (config.data['oauth2-proxy.cfg'])
      assert.equal(
        config.data['oauth2-proxy.cfg'],
        readFileSync(settingsFile, 'utf8'),
      );
    else assert.deepEqual(config.data, environment(settings));
  }
  const pods = get('pods', '-l', `app.kubernetes.io/name=${name}`).items.filter(
    (pod) => !pod.metadata.deletionTimestamp,
  );
  assert.equal(pods.length, deployment.spec.replicas);
  for (const pod of pods) {
    assert.ok(
      pod.status.conditions.some(
        (condition) =>
          condition.type === 'Ready' && condition.status === 'True',
      ),
    );
    assert.equal(pod.spec.containers.length, 1, 'Unexpected proxy sidecar');
    assert.equal(pod.spec.containers[0].image, settings.image);
    assert.equal(pod.spec.serviceAccountName, name);
    const tokenVolume = pod.spec.volumes.find((volume) =>
      volume.projected?.sources.some(
        (source) =>
          source.serviceAccountToken?.audience === 'api://AzureADTokenExchange',
      ),
    );
    assert.ok(tokenVolume, 'Missing workload identity projected token');
    const env = pod.spec.containers[0].env;
    assert.equal(
      env.find((value) => value.name === 'AZURE_CLIENT_ID')?.value,
      settings.clientId,
    );
    assert.equal(
      env.find((value) => value.name === 'AZURE_TENANT_ID')?.value,
      settings.tenantId,
    );
    assert.ok(
      env.find((value) => value.name === 'AZURE_FEDERATED_TOKEN_FILE')?.value,
    );
  }
  assert.deepEqual(
    service.spec.ports.map(
      ({ name: portName, port, targetPort, protocol }) => ({
        name: portName,
        port,
        targetPort,
        protocol,
      }),
    ),
    [{ name: 'https', port: 443, targetPort: 'https', protocol: 'TCP' }],
  );
  assert.ok(['ClusterIP', 'LoadBalancer'].includes(service.spec.type));
  const secretVersions = [`${name}-cookie`, `${name}-tls`].map((secretName) => [
    secretName,
    kube(
      'get',
      'secret',
      secretName,
      '-o',
      'jsonpath={.metadata.resourceVersion}',
    ),
  ]);
  const forwarded = await portForward(settings);
  let result;
  try {
    // No CA override: activation requires a publicly trusted certificate.
    result = await probeEdge(settings, {
      address: '127.0.0.1',
      port: forwarded.port,
    });
  } finally {
    forwarded.child.kill();
  }
  console.log(JSON.stringify(result));
  if (action === 'verify' || action === 'verify-public') {
    if (action === 'verify-public') {
      assert.equal(service.spec.type, 'LoadBalancer');
      console.log(JSON.stringify(await probeEdge(settings)));
    }
    console.log(
      'Private checks passed. Real user sign-in and upstream feature checks remain separate.',
    );
    return;
  }
  assert.equal(
    service.spec.type,
    'ClusterIP',
    'Activation starts from a private proxy',
  );
  assert.ok(
    settings.publicIPName && settings.publicIPResourceGroup,
    'Reserve a dedicated public IP/DNS before activation',
  );
  const publicIP = az(
    'network',
    'public-ip',
    'show',
    '-g',
    settings.publicIPResourceGroup,
    '-n',
    settings.publicIPName,
    '--subscription',
    settings.subscription,
  );
  assert.equal(publicIP.sku.name, 'Standard');
  assert.equal(publicIP.publicIPAllocationMethod, 'Static');
  assert.equal(publicIP.location, cluster.location);
  assert.equal(publicIP.dnsSettings?.fqdn, new URL(settings.origin).hostname);
  assert.ok(
    !publicIP.ipConfiguration,
    'Public IP must not still be attached to a certificate-validation Service',
  );
  assert.equal(
    get('deployment', name).metadata.resourceVersion,
    deployment.metadata.resourceVersion,
    'Proxy changed during checks',
  );
  for (const [configName, version] of configVersions) {
    assert.equal(
      get('configmap', configName).metadata.resourceVersion,
      version,
      'Configuration changed during checks',
    );
  }
  for (const [secretName, version] of secretVersions) {
    assert.equal(
      kube(
        'get',
        'secret',
        secretName,
        '-o',
        'jsonpath={.metadata.resourceVersion}',
      ),
      version,
      'Authentication Secret changed during checks',
    );
  }
  assertPrivateServices(get('services').items);
  const annotations = {
    ...service.metadata.annotations,
    'service.beta.kubernetes.io/azure-pip-name': settings.publicIPName,
    'service.beta.kubernetes.io/azure-load-balancer-resource-group':
      settings.publicIPResourceGroup,
    'service.beta.kubernetes.io/port_443_health-probe_protocol': 'tcp',
  };
  kube(
    'patch',
    'service',
    name,
    '--type=json',
    '-p',
    JSON.stringify([
      {
        op: 'test',
        path: '/metadata/resourceVersion',
        value: service.metadata.resourceVersion,
      },
      { op: 'add', path: '/metadata/annotations', value: annotations },
      { op: 'add', path: '/spec/externalTrafficPolicy', value: 'Local' },
      { op: 'replace', path: '/spec/type', value: 'LoadBalancer' },
    ]),
  );
  try {
    kube(
      'wait',
      `service/${name}`,
      `--for=jsonpath={.status.loadBalancer.ingress[0].ip}=${publicIP.ipAddress}`,
      '--timeout=180s',
    );
    console.log(JSON.stringify(await probeEdge(settings)));
  } catch (error) {
    await main(['rollback', settingsPath]);
    throw new Error(
      `Public verification failed; proxy returned to ClusterIP: ${error.message}`,
    );
  }
  console.log(
    `Only the TLS authentication proxy is public at ${settings.origin}. Public negative checks passed; real user sign-in remains unverified.`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`Auth operation stopped: ${error.message}`);
    process.exitCode = 1;
  });
}
