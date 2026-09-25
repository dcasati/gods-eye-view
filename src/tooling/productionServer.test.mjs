import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createProductionServer } from '../../server/standalone/production.mjs';
import { browserRuntimeConfig } from '../../server/standalone/runtime-config.mjs';
import containerConfig from '../../server/standalone/container.vite.config.js';

test('runtime config exposes only explicitly browser-facing values', () => {
  const config = browserRuntimeConfig({
    GOOGLE_MAPS_API_KEY: 'public-google',
    CESIUM_ION_TOKEN: 'public-ion',
    VITE_AIS_LIVE_MAX_ROWS: '500',
    OPENAI_API_KEY: 'private-openai',
    GOOGLE_MAPS_SERVER_API_KEY: 'private-google',
    AISSTREAM_API_KEY: 'private-ais',
    VITE_UNEXPECTED_SECRET: 'private-vite',
  });
  assert.equal(config.GOOGLE_MAPS_API_KEY, 'public-google');
  assert.equal(config.CESIUM_ION_TOKEN, 'public-ion');
  assert.equal(config.VITE_AIS_LIVE_MAX_ROWS, '500');
  assert.equal(config.VITE_AIS_LIVE_API_URL, '');
  assert.equal(JSON.stringify(config).includes('private-'), false);
});

test('container build reads no dotenv files or implicit VITE environment values', () => {
  assert.equal(containerConfig.envDir, false);
  assert.deepEqual(containerConfig.envPrefix, []);
  for (const [key, value] of Object.entries(containerConfig.define)) {
    assert.equal(
      value,
      `globalThis.__GEV_RUNTIME_CONFIG__.${key.split('.').at(-1)}`,
    );
  }
  const tags = containerConfig.plugins.at(-1).transformIndexHtml.handler();
  assert.equal(tags[0].attrs.src, '/api/runtime-config.js');
  assert.equal(tags[0].injectTo, 'head-prepend');
  assert.equal(tags[0].attrs.type, undefined);
});

async function fixture(t, options = {}) {
  const dist = await mkdtemp(path.join(tmpdir(), 'gev-production-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await writeFile(
    path.join(dist, 'index.html'),
    '<!doctype html><title>GEV</title>',
  );
  await writeFile(path.join(dist, '.env'), 'NEVER_SERVE_THIS');
  await mkdir(path.join(dist, 'assets'));
  await writeFile(
    path.join(dist, 'assets', 'fixture.js'),
    'console.log("asset");',
  );
  const app = await createProductionServer({ dist, ...options });
  await new Promise((resolve) =>
    app.httpServer.listen(0, '127.0.0.1', resolve),
  );
  t.after(() => app.close());
  return `http://127.0.0.1:${app.httpServer.address().port}`;
}

test('production serves assets, runtime settings, probes and APIs but never dev key setup', async (t) => {
  let disposed = false;
  const base = await fixture(t, {
    env: {
      GOOGLE_MAPS_API_KEY: 'public-";throw new Error("escaped")//',
      OPENAI_API_KEY: 'NEVER_SERVE_THIS',
    },
    providers: [
      {
        configureServer() {
          throw new Error('Dev hooks must not execute');
        },
        configurePreviewServer({ middlewares, httpServer }) {
          httpServer.once('close', () => {
            disposed = true;
          });
          middlewares.use('/api/fixture', (_req, res) => {
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ provider: true }));
          });
        },
      },
    ],
  });
  t.after(() => assert.equal(disposed, true));
  for (const route of ['/healthz', '/readyz']) {
    const response = await fetch(base + route);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok' });
  }
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>GEV/);
  assert.equal(page.headers.get('cache-control'), 'no-cache');
  assert.equal(page.headers.get('x-frame-options'), 'DENY');
  const asset = await fetch(`${base}/assets/fixture.js`);
  assert.equal(asset.status, 200);
  assert.match(asset.headers.get('content-type'), /javascript/);
  const script = await fetch(`${base}/api/runtime-config.js`);
  assert.equal(script.headers.get('cache-control'), 'no-store');
  const source = await script.text();
  assert.equal(source.includes('NEVER_SERVE_THIS'), false);
  const context = vm.createContext({});
  vm.runInContext(source, context);
  assert.equal(
    context.__GEV_RUNTIME_CONFIG__.GOOGLE_MAPS_API_KEY,
    'public-";throw new Error("escaped")//',
  );
  assert.equal(
    (await fetch(`${base}/api/runtime-config.js`, { method: 'POST' })).status,
    405,
  );
  const provider = await fetch(`${base}/api/fixture`);
  assert.deepEqual(await provider.json(), { provider: true });
  for (const route of [
    '/api/setup/status',
    '/api/setup/keys',
    '/api/unknown',
  ]) {
    const response = await fetch(base + route);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'Unknown API route' });
  }
  for (const route of [
    '/.env',
    '/package.json',
    '/server/standalone/production.mjs',
    '/missing.js',
  ]) {
    assert.equal((await fetch(base + route)).status, 404);
  }
});

test('production installs actual provider routes without Vite serving source files', async (t) => {
  const base = await fixture(t);
  const response = await fetch(`${base}/api/local-receivers/aircraft`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /json/);
  const unknown = await fetch(`${base}/api/unknown`);
  assert.equal(unknown.status, 404);
});

test('production startup fails when built assets are missing', async () => {
  await assert.rejects(
    createProductionServer({ dist: '/nonexistent-gev-build', providers: [] }),
    { code: 'ENOENT' },
  );
});
