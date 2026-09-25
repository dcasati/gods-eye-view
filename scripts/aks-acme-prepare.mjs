import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateSettings } from './aks-auth.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const [settingsPath, outputPath] = process.argv.slice(2);
assert.ok(
  settingsPath && outputPath,
  'Usage: node scripts/aks-acme-prepare.mjs .azure/auth/settings.json .azure/auth-acme',
);
const directory = path.resolve(outputPath);
assert.ok(
  directory.startsWith(path.join(root, '.azure') + path.sep),
  'Output must remain under ignored .azure/',
);
const settings = validateSettings(
  JSON.parse(readFileSync(settingsPath, 'utf8')),
);
assert.ok(
  settings.publicIPName && settings.publicIPResourceGroup,
  'Dedicated public IP settings required',
);
const result = spawnSync(
  'kubectl',
  [
    '--context',
    settings.context,
    '-n',
    settings.namespace,
    'get',
    'deployment',
    'gods-eye-view',
    '-o',
    'jsonpath={.spec.template.spec.containers[0].image}',
  ],
  { encoding: 'utf8' },
);
assert.equal(result.status, 0, result.stderr);
const image = result.stdout.trim();
assert.match(image, /@sha256:[0-9a-f]{64}$/);
const [repository, digest] = image.split('@');
mkdirSync(directory, { recursive: true });
writeFileSync(
  path.join(directory, 'kustomization.yaml'),
  JSON.stringify(
    {
      apiVersion: 'kustomize.config.k8s.io/v1beta1',
      kind: 'Kustomization',
      namespace: settings.namespace,
      resources: [
        path.relative(directory, path.join(root, 'infra/aks/auth-acme')),
      ],
      images: [{ name: 'gods-eye-view', newName: repository, digest }],
      patches: [
        {
          target: { kind: 'Service', name: 'gods-eye-view-acme' },
          patch: JSON.stringify([
            {
              op: 'add',
              path: '/metadata/annotations',
              value: {
                'service.beta.kubernetes.io/azure-pip-name':
                  settings.publicIPName,
                'service.beta.kubernetes.io/azure-load-balancer-resource-group':
                  settings.publicIPResourceGroup,
                'service.beta.kubernetes.io/port_80_health-probe_protocol':
                  'tcp',
              },
            },
          ]),
        },
      ],
    },
    null,
    2,
  ) + '\n',
);
console.log(
  'Challenge-only ClusterIP overlay prepared; it does not run or route the app.',
);
