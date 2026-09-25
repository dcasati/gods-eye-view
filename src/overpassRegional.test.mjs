import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  loadOverpassSourceConfig,
  isRegionalRoadQuery,
  overpassEndpointsForBody,
} from '../server/providers/overpass/regional.js';
import { fetchOverpassPayload } from '../server/providers/overpass/transport.js';

const bounds = [29.9, -98.2, 30.7, -97.2];
const globals = ['https://global.example/api/interpreter'];
const config = loadOverpassSourceConfig(
  {
    OVERPASS_REGIONAL_URL:
      'http://overpass-austin.gods-eye-view.svc.cluster.local/api/interpreter',
    OVERPASS_REGIONAL_BOUNDS: bounds.join(','),
  },
  globals,
);
const form = (query) => new URLSearchParams({ data: query }).toString();
const road = (bbox = '30.26,-97.75,30.28,-97.73') =>
  `[out:json][timeout:25];(way["highway"~"motorway|primary|residential"](${bbox}););out geom qt;`;

test('only wholly contained, supported road queries prefer regional', () => {
  for (const bbox of ['30.26,-97.75,30.28,-97.73', bounds.join(',')]) {
    assert.equal(isRegionalRoadQuery(form(road(bbox)), bounds), true);
    assert.deepEqual(overpassEndpointsForBody(form(road(bbox)), config), [
      config.regional.url,
      ...globals,
    ]);
  }
  for (const bbox of [
    '29.8,-97.75,30.28,-97.73',
    '30.26,-98.3,30.28,-97.73',
    '30.26,-97.75,30.8,-97.73',
    '30.26,-97.75,30.28,-97.1',
    '40,-74,40.1,-73.9',
    '30.3,-97.75,30.2,-97.73',
    '30.2,170,30.3,-170',
  ])
    assert.deepEqual(
      overpassEndpointsForBody(form(road(bbox)), config),
      globals,
      bbox,
    );
});

const unsupported = [
  '[out:json];is_in(30.27,-97.74);out;',
  '[out:json];way["highway"](around:100,30.27,-97.74);out geom;',
  '[out:json];area(3600000001)->.a;rel(pivot.a);out geom;',
  '[out:json];(relation["boundary"="administrative"](30.26,-97.75,30.28,-97.73););out geom;',
  '[out:json];(way["highway"](30.26,-97.75,30.28,-97.73);way["highway"];);out geom;',
  '[out:json];(way["highway"="(30.26,-97.75,30.28,-97.73)"];);out geom;',
  road() + 'way["highway"];out;',
  road().replace('););', ');way["highway"](40,-74,40.1,-73.9););'),
  road().replace('[timeout:25]', '[timeout:25][bbox:30,-98,31,-97]'),
  road().replace('out geom qt;', 'out geom qt;/* hidden */way;out;'),
  road().replace('way["highway"', 'relation["highway"'),
  road().replace('way["highway"', 'node["highway"'),
];
test('admin, around, non-road, malformed, mixed and unbounded queries stay global', () => {
  for (const query of unsupported)
    assert.deepEqual(
      overpassEndpointsForBody(form(query), config),
      globals,
      query,
    );
  assert.equal(
    isRegionalRoadQuery(form(road()) + '&data=way%3Bout%3B', bounds),
    false,
  );
  assert.equal(
    isRegionalRoadQuery(form(road()) + '&endpoint=http://evil.example', bounds),
    false,
  );
});

test('defaults and operator full-planet overrides are explicit and server-only', () => {
  assert.deepEqual(loadOverpassSourceConfig({}, globals), {
    upstreams: globals,
    regional: null,
  });
  const custom = loadOverpassSourceConfig(
    {
      OVERPASS_UPSTREAMS_JSON:
        '["http://full-planet.namespace.svc/api/interpreter"]',
    },
    globals,
  );
  assert.deepEqual(custom.upstreams, [
    'http://full-planet.namespace.svc/api/interpreter',
  ]);
});

test('configuration errors fail loudly rather than silently changing coverage', () => {
  for (const value of [
    '',
    '{}',
    '[]',
    'null',
    '["ftp://a/x"]',
    '["https://u:p@a/x"]',
    '["https://a/x?q=1"]',
    '["https://a/x#x"]',
    '["https://a/x?"]',
    '["https://a/x#"]',
    '[" https://a/x"]',
    '[3]',
    '["https://a/\\\\\\\\x"]',
  ]) {
    assert.throws(
      () =>
        loadOverpassSourceConfig({ OVERPASS_UPSTREAMS_JSON: value }, globals),
      /OVERPASS_UPSTREAMS_JSON/,
    );
  }
  for (const value of [
    '',
    '29.9,-98.2,30.7',
    'a,b,c,d',
    '30,-98,29,-97',
    '29,170,30,-170',
    '-91,-98,30,-97',
    '29,-98,91,-97',
    '29,-181,30,-97',
    '29,-98,30,181',
    '29,,30,-97',
  ]) {
    assert.throws(
      () =>
        loadOverpassSourceConfig(
          {
            OVERPASS_REGIONAL_URL: 'http://regional.svc/api',
            OVERPASS_REGIONAL_BOUNDS: value,
          },
          globals,
        ),
      /OVERPASS_REGIONAL/,
    );
  }
  assert.throws(() =>
    loadOverpassSourceConfig(
      { OVERPASS_REGIONAL_URL: 'http://regional.svc/api' },
      globals,
    ),
  );
  assert.throws(() =>
    loadOverpassSourceConfig(
      { OVERPASS_REGIONAL_BOUNDS: bounds.join(',') },
      globals,
    ),
  );
  const child = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "await import('./server/providers/overpass/constants.js')",
    ],
    {
      env: { ...process.env, OVERPASS_UPSTREAMS_JSON: '[]' },
      encoding: 'utf8',
    },
  );
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /OVERPASS_UPSTREAMS_JSON/);
});

test('regional failures, runtime errors and invalid 200s fall through to full-planet sources', async () => {
  for (const failure of [
    new Error('timeout'),
    { status: 503, body: '{}' },
    { status: 429, body: '{}' },
    {
      status: 200,
      body: '{"elements":[],"remark":"runtime error: timed out"}',
    },
    { status: 200, body: '<html>broken service</html>' },
    { status: 200, body: '{"elements":[],"remark":"incomplete snapshot"}' },
  ]) {
    const tried = [];
    const result = await fetchOverpassPayload(form(road()), 1e6, {
      sourceConfig: config,
      fetchImpl: async (url) => {
        tried.push(url);
        if (url === config.regional.url && failure instanceof Error)
          throw failure;
        const answer =
          url === config.regional.url
            ? failure
            : { status: 200, body: '{"elements":[{"type":"way","id":1}]}' };
        return { ...answer, headers: { get: () => 'application/json' } };
      },
      readBody: async (response) => response.body,
      simplify: (body) => body,
    });

    test('regional success stops fan-out while outside roads never contact regional', async () => {
      for (const bbox of ['30.26,-97.75,30.28,-97.73', '40,-74,40.1,-73.9']) {
        const tried = [];
        const result = await fetchOverpassPayload(form(road(bbox)), 1e6, {
          sourceConfig: config,
          fetchImpl: async (url) => {
            tried.push(url);
            return { status: 200, headers: { get: () => 'application/json' } };
          },
          readBody: async () => '{"elements":[{"type":"way","id":123}]}',
          simplify: (body) => body,
        });
        const expected = bbox.startsWith('40')
          ? globals[0]
          : config.regional.url;
        assert.equal(result.endpoint, expected);
        assert.deepEqual(tried, [expected]);
      }
    });
    assert.deepEqual(tried, [config.regional.url, ...globals]);
    assert.equal(result.endpoint, globals[0]);
  }
});

test('Python regional adapter applies the same conservative road grammar', () => {
  const queries = [
    road(),
    road(bounds.join(',')),
    ...unsupported,
    road('40,-74,40.1,-73.9'),
  ];
  const child = spawnSync(
    'python3',
    [
      '-B',
      '-c',
      `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("regional", "infra/overpass/server.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps([module.safe_query(q, [29.9,-98.2,30.7,-97.2]) for q in json.load(sys.stdin)]))
`,
    ],
    { input: JSON.stringify(queries), encoding: 'utf8' },
  );
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(
    JSON.parse(child.stdout),
    queries.map((q) => isRegionalRoadQuery(form(q), bounds)),
  );
});
