import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import {
  validateSettings,
  overlay,
  environment,
  assertPrivateServices,
} from '../../scripts/aks-auth.mjs';
import { probeEdge, requestEdge } from '../../scripts/aks-auth-probe.mjs';
import { createChallengeServer } from '../../infra/aks/auth-acme/server.mjs';

const settings = {
  context: 'example',
  subscription: randomUUID(),
  resourceGroup: 'example',
  cluster: 'example',
  namespace: 'another-namespace',
  tenantId: randomUUID(),
  clientId: randomUUID(),
  origin: 'https://example.org',
  image: `quay.io/oauth2-proxy/oauth2-proxy:v7.15.2@sha256:${'a'.repeat(64)}`,
  assignmentRequired: true,
};

test('auth overlay is isolated, private and portable', () => {
  const generated = overlay(settings, path.join(process.cwd(), '.azure/auth'));
  assert.deepEqual(generated.resources, ['../../infra/aks/auth']);
  assert.equal(generated.namespace, settings.namespace);
  assert.equal(
    environment(settings).OAUTH2_PROXY_UPSTREAMS,
    'http://gods-eye-view.another-namespace.svc.cluster.local:80/',
  );
  const service = readFileSync('infra/aks/auth/service.yaml', 'utf8');
  assert.match(service, /type: ClusterIP/);
  assert.doesNotMatch(service, /LoadBalancer|NodePort|externalIPs/);
  const cfg = readFileSync('infra/aks/auth/oauth2-proxy.cfg', 'utf8');
  assert.match(cfg, /entra_id_federated_token_auth = true/);
  assert.match(cfg, /reverse_proxy = false/);
  assert.match(cfg, /insecure_oidc_skip_nonce = false/);
  assert.doesNotMatch(
    cfg,
    /skip_auth_routes|skip_auth_regex|trusted_ips|client_secret|static:\/\//,
  );
  assert.match(cfg, /pass_access_token = false/);
  assert.match(cfg, /pass_authorization_header = false/);
  for (const key of ['cookie_secure', 'cookie_httponly', 'proxy_websockets']) {
    assert.match(cfg, new RegExp(`${key} = true`));
  }
});

test('settings reject unsafe origins, secrets, unpinned images and tenant aliases', () => {
  assert.equal(validateSettings(settings), settings);
  for (const patch of [
    { origin: 'http://example.org' },
    { origin: 'https://example.org/' },
    { origin: 'https://user:password@example.org' },
    { origin: 'https://example.org:4443' },
    { clientSecret: 'never' },
    { tenantId: 'common' },
    { image: 'quay.io/oauth2-proxy/oauth2-proxy:latest' },
  ])
    assert.throws(() => validateSettings({ ...settings, ...patch }));
});

test('exposure gate rejects direct service bypasses', () => {
  const service = (name, type = 'ClusterIP', extra = {}) => ({
    metadata: { name },
    spec: { type, ports: [{ port: 80 }], ...extra },
  });
  assert.doesNotThrow(() =>
    assertPrivateServices([
      service('gods-eye-view'),
      service('overpass-calgary'),
    ]),
  );
  for (const type of ['LoadBalancer', 'NodePort', 'ExternalName']) {
    assert.throws(() =>
      assertPrivateServices([service('gods-eye-view', type)]),
    );
  }
  assert.throws(() =>
    assertPrivateServices([
      service('gods-eye-view', 'ClusterIP', { externalIPs: ['192.0.2.1'] }),
    ]),
  );
  assert.throws(() =>
    assertPrivateServices([
      service('overpass-calgary', 'ClusterIP', {
        ports: [{ nodePort: 30080 }],
      }),
    ]),
  );
});

test('ACME responder serves only one exact public token, never application paths', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'gev-acme-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const token = 'a'.repeat(43);
  writeFileSync(path.join(directory, 'token'), token);
  writeFileSync(path.join(directory, 'authorization'), `${token}.thumbprint`);
  const server = createChallengeServer(directory);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const origin = `http://127.0.0.1:${server.address().port}`;
  const exact = `/.well-known/acme-challenge/${token}`;
  assert.equal(
    await (await fetch(origin + exact)).text(),
    `${token}.thumbprint`,
  );
  for (const route of [
    '/',
    '/api/runtime-config.js',
    '/assets/app.js',
    '/oauth2/callback',
    `${exact}?query=1`,
    `${exact}/`,
    '/.well-known/acme-challenge/invalid',
  ]) {
    assert.equal((await fetch(origin + route)).status, 404);
  }
  assert.equal((await fetch(origin + exact, { method: 'POST' })).status, 404);
  writeFileSync(path.join(directory, 'token'), '');
  assert.equal((await fetch(origin + exact)).status, 404);
});

test(
  'real oauth2-proxy rejects anonymous/forged requests before reaching upstream',
  {
    skip: !process.env.OAUTH2_PROXY_BIN || !process.env.PROXY_TEST_TENANT,
    timeout: 90000,
  },
  async (t) => {
    const directory = mkdtempSync(path.join(tmpdir(), 'gev-auth-test-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const cert = path.join(directory, 'tls.crt');
    const key = path.join(directory, 'tls.key');
    const generated = spawnSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '1',
        '-subj',
        '/CN=localhost',
        '-addext',
        'subjectAltName=DNS:localhost',
        '-keyout',
        key,
        '-out',
        cert,
      ],
      { encoding: 'utf8' },
    );
    assert.equal(generated.status, 0, generated.stderr);
    let upstreamRequests = 0;
    const upstream = createServer((_request, response) => {
      upstreamRequests++;
      response.end('UNAUTHENTICATED_UPSTREAM_BYPASS');
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    t.after(() => upstream.close());
    const reservation = createServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    const port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const cfg = readFileSync('infra/aks/auth/oauth2-proxy.cfg', 'utf8')
      .replace('0.0.0.0:4443', `127.0.0.1:${port}`)
      .replace('127.0.0.1:4180', '127.0.0.1:0')
      .replace('/etc/oauth2-proxy/tls/tls.crt', cert)
      .replace('/etc/oauth2-proxy/tls/tls.key', key);
    const config = path.join(directory, 'oauth2-proxy.cfg');
    writeFileSync(config, cfg);
    const tokenFile = path.join(directory, 'invalid-test-token');
    writeFileSync(tokenFile, 'invalid-test-token', { mode: 0o600 });
    const localSettings = {
      ...settings,
      origin: 'https://localhost',
      tenantId: process.env.PROXY_TEST_TENANT,
    };
    const child = spawn(process.env.OAUTH2_PROXY_BIN, [`--config=${config}`], {
      env: {
        ...process.env,
        ...environment(localSettings),
        OAUTH2_PROXY_UPSTREAMS: `http://127.0.0.1:${upstream.address().port}/`,
        OAUTH2_PROXY_COOKIE_SECRET: randomBytes(32).toString('base64url'),
        AZURE_FEDERATED_TOKEN_FILE: tokenFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await once(child, 'exit');
      }
    });
    let log = '';
    child.stdout.on('data', (chunk) => {
      log += chunk;
    });
    child.stderr.on('data', (chunk) => {
      log += chunk;
    });
    const connection = { address: '127.0.0.1', port, ca: readFileSync(cert) };
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      assert.equal(child.exitCode, null, `Proxy exited: ${log}`);
      try {
        ready =
          (await requestEdge(localSettings.origin, '/oauth2/ready', connection))
            .status === 200;
      } catch (error) {
        if (error.code !== 'ECONNREFUSED') throw error;
      }
      if (ready) break;
      await delay(200);
    }
    assert.ok(ready, `Proxy did not become ready: ${log}`);
    const result = await probeEdge(localSettings, connection);
    assert.ok(result.negativeChecks >= 40);
    assert.equal(result.authenticatedSignIn, 'not tested');
    assert.equal(
      upstreamRequests,
      0,
      'An unauthenticated request reached the application',
    );
  },
);
