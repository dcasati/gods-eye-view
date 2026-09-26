import test from 'node:test';
import assert from 'node:assert/strict';

let instance = 0;
async function fixture(t) {
  let now = Date.parse('2026-09-26T20:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const store = await import(
    `../../server/providers/vessels/ais-store.js?cache-test=${instance++}`
  );
  return {
    ...store,
    advance(ms) {
      now += ms;
    },
    position(id, lat = 51) {
      return store.ingestAisStreamEnvelope({
        MessageType: 'PositionReport',
        Message: { PositionReport: { UserID: id, Sog: 10 } },
        MetaData: {
          MMSI: String(id),
          latitude: lat,
          longitude: 1,
          time_utc: new Date(now).toISOString(),
        },
      });
    },
    static(id, name = 'Test vessel') {
      return store.ingestAisStreamEnvelope({
        MessageType: 'ShipStaticData',
        Message: { ShipStaticData: { UserID: id, Name: name } },
      });
    },
  };
}

test('ordinary position updates do not iterate whole caches between sweeps', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 2000; i++) f.position(200000000 + i);
  const iterator = Map.prototype[Symbol.iterator];
  let visited = 0;
  Map.prototype[Symbol.iterator] = function* () {
    for (const entry of iterator.call(this)) {
      visited++;
      yield entry;
    }
  };
  try {
    for (let i = 0; i < 1000; i++) f.position(200000000 + i);
    assert.equal(visited, 0);
    f.advance(15_000);
    f.position(200000000);
    assert.ok(visited >= 2000, 'maintenance still runs when due');
    visited = 0;
    f.position(200000001);
    assert.equal(visited, 0);
  } finally {
    Map.prototype[Symbol.iterator] = iterator;
  }
});

test('capacity eviction retains recently updated vessels and removes their old tracks', async (t) => {
  const f = await fixture(t);
  f.position(200000000);
  f.advance(30_000);
  f.position(200000000, 51.01);
  assert.equal(f.readAisTrack('200000000').length, 2);
  for (let i = 1; i < f.AISSTREAM_CACHE_MAX; i++) f.position(200000000 + i);
  f.position(200000001);
  f.position(300000000);
  const rows = f.aisStreamRows(f.AISSTREAM_CACHE_MAX + 1);
  assert.equal(rows.length, f.AISSTREAM_CACHE_MAX);
  assert.ok(!rows.some((r) => r.mmsi === '200000000'));
  assert.ok(rows.some((r) => r.mmsi === '200000001'));
  assert.deepEqual(f.readAisTrack('200000000'), []);
  f.position(200000000, 51.02);
  assert.deepEqual(f.readAisTrack('200000000'), []);
});

test('positionless static metadata is bounded and preserves recent metadata', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < f.AISSTREAM_CACHE_MAX; i++)
    assert.equal(f.static(200000000 + i), true);
  f.static(200000001, 'Refreshed');
  f.static(300000000, 'Newest');
  assert.deepEqual(f.aisStreamRows(10), []);
  f.position(200000000);
  f.position(200000001);
  f.position(300000000);
  const rows = new Map(f.aisStreamRows(10).map((r) => [r.mmsi, r]));
  assert.equal(rows.get('200000000').name, 'MMSI 200000000');
  assert.equal(rows.get('200000001').name, 'Refreshed');
  assert.equal(rows.get('300000000').name, 'Newest');
});

test('expiry hides rows and tracks between sweeps and does not revive stale tracks', async (t) => {
  const f = await fixture(t);
  f.position(200000000);
  f.advance(30_000);
  f.position(200000000, 51.01);
  f.advance(f.AISSTREAM_STALE_MS);
  assert.equal(f.aisStreamRows(10).length, 1);
  assert.equal(f.readAisTrack('200000000').length, 2);
  f.advance(1);
  assert.deepEqual(f.aisStreamRows(10), []);
  assert.deepEqual(f.readAisTrack('200000000'), []);
  f.position(200000000, 51.02);
  assert.deepEqual(f.readAisTrack('200000000'), []);
});

test('static-only traffic triggers expiry and active positions retain metadata', async (t) => {
  const f = await fixture(t);
  f.static(200000000, 'Expired');
  f.static(200000001, 'Active');
  f.advance(f.AISSTREAM_STALE_MS - 1);
  f.position(200000001);
  f.advance(15_001);
  f.static(200000002);
  f.position(200000000);
  f.position(200000001);
  const rows = new Map(f.aisStreamRows(10).map((r) => [r.mmsi, r]));
  assert.equal(rows.get('200000000').name, 'MMSI 200000000');
  assert.equal(rows.get('200000001').name, 'Active');
});

test('quiet-feed reads reclaim expired cache entries', async (t) => {
  const f = await fixture(t);
  f.static(200000000);
  f.position(200000000);
  f.advance(30_000);
  f.position(200000000, 51.01);
  f.advance(f.AISSTREAM_STALE_MS + 1);
  assert.deepEqual(f.readAisTrack('200000000'), []);
  assert.deepEqual(f.aisStreamRows(10), []);
  f.position(200000000);
  assert.equal(f.aisStreamRows(10)[0].name, 'MMSI 200000000');
  assert.deepEqual(f.readAisTrack('200000000'), []);
});

test('track thinning and 64-sample ring remain intact', async (t) => {
  const f = await fixture(t);
  f.position(200000000);
  f.advance(10_000);
  f.position(200000000, 51.01);
  assert.deepEqual(f.readAisTrack('200000000'), []);
  for (let i = 1; i <= 70; i++) {
    f.advance(30_000);
    f.position(200000000, 51 + i / 100);
  }
  const track = f.readAisTrack('200000000');
  assert.equal(track.length, 64);
  assert.ok(track.every((p, i) => i === 0 || p.t > track[i - 1].t));
  assert.ok(Math.abs(track.at(-1).lat - 51.7) < 0.00001);
});
