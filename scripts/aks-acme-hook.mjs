import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';

const settings = JSON.parse(
  readFileSync(process.env.AKS_AUTH_SETTINGS, 'utf8'),
);
const cleanup = process.argv[2] === 'cleanup';
assert.equal(process.env.CERTBOT_DOMAIN, new URL(settings.origin).hostname);
const token = process.env.CERTBOT_TOKEN;
const authorization = process.env.CERTBOT_VALIDATION;
assert.match(token, /^[\w-]{20,}$/);
assert.ok(authorization.startsWith(`${token}.`));
const result = spawnSync(
  'kubectl',
  [
    '--context',
    settings.context,
    '-n',
    settings.namespace,
    'patch',
    'configmap',
    'gods-eye-view-acme-token',
    '--type=merge',
    '--patch-file=/dev/stdin',
  ],
  {
    input: JSON.stringify({
      data: {
        token: cleanup ? '' : token,
        authorization: cleanup ? '' : authorization,
      },
    }),
    encoding: 'utf8',
  },
);
if (result.status !== 0)
  throw new Error(`Challenge token update failed: ${result.stderr}`);
if (!cleanup) {
  const url = `http://${process.env.CERTBOT_DOMAIN}/.well-known/acme-challenge/${token}`;
  let ready = false;
  for (let attempt = 0; attempt < 90; attempt++) {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(10000),
      redirect: 'error',
    });
    if (response.status === 200 && (await response.text()) === authorization) {
      ready = true;
      break;
    }
    assert.ok(
      [200, 404, 503].includes(response.status),
      'Unexpected challenge endpoint response',
    );
    await delay(2000);
  }
  assert.ok(
    ready,
    'Public challenge token did not propagate; refusing issuance',
  );
  console.log(
    'Exact public challenge token verified; no application upstream exists.',
  );
}
