import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

for (const region of ['austin', 'calgary']) {
  test(`${region} bootstrap activates only validated imports and refresh preserves previous snapshot`, async () => {
    const directory = `.gev-cache/overpass-bootstrap-test-${randomUUID()}`;
    await mkdir(directory, { recursive: true });
    try {
      const child = spawnSync(
        'python3',
        [
          '-B',
          '-c',
          `
import importlib.util, io, json, pathlib, sys
sys.path.insert(0, "infra/overpass")
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location("bootstrap", "infra/overpass/bootstrap.py")
b = importlib.util.module_from_spec(spec)
spec.loader.exec_module(b)
b.ROOT = pathlib.Path(sys.argv[1]).resolve()
class Download(io.BytesIO):
    url = b.load_profile()[1]["source"].replace("latest", "260924")
    headers = {"Last-Modified": "Thu, 24 Sep 2026 22:00:00 GMT"}
b.urllib.request.urlopen = lambda *a, **k: Download(b"source snapshot")
commands = []
def run(*args):
    commands.append(args)
    pathlib.Path(args[args.index("-o") + 1]).write_bytes(b"cropped")
b.run = run
b.subprocess.check_output = lambda *a, **k: "2026-09-24T21:00:00Z"
class Convert:
    def __init__(self, *a, **k): self.stdout = io.BytesIO(b"<osm/>")
    def wait(self): return 0
    def poll(self): return 0
b.subprocess.Popen = Convert
bad = False
def execute(args, **kwargs):
    commands.append(args)
    if "update_database" in args[0]:
        db = pathlib.Path(next(a[9:] for a in args if a.startswith("--db-dir=")))
        (db / "ways.bin").write_bytes(b"retained database")
        return SimpleNamespace(returncode=0)
    return SimpleNamespace(returncode=0, stdout=json.dumps({"elements": [
      {"type":"count", "tags":{"ways":"0" if bad else "42"}}
    ]}))
b.subprocess.run = execute
sys.argv = ["bootstrap.py"]
b.main()
first = (b.ROOT / "current").resolve()
metadata = json.loads((first / "snapshot.json").read_text())
assert metadata["osm_timestamp"] == "2026-09-24T21:00:00Z"
assert metadata["resolved_source"].endswith("-260924.osm.pbf")
region, profile = b.load_profile()
assert metadata["region"] == region
assert metadata["bounds"] == profile["bounds"]
assert len(metadata["source_sha256"]) == 64
assert not (first / "source.osm.pbf").exists()
assert any("--strategy=complete_ways" in cmd for cmd in commands)
south, west, north, east = profile["bounds"]
assert any(f"--bbox={west},{south},{east},{north}" in cmd for cmd in commands)
assert any("w/highway" in cmd for cmd in commands)
b.main()
assert (b.ROOT / "current").resolve() == first
sys.argv.append("--refresh")
bad = True
try:
    b.main()
    raise AssertionError("empty import was activated")
except RuntimeError as e:
    assert "no roads" in str(e)
assert (b.ROOT / "current").resolve() == first
assert (first / "database" / "ways.bin").read_bytes() == b"retained database"
bad = False
b.main()
assert (b.ROOT / "current").resolve() != first
assert (first / "database" / "ways.bin").exists()
import os
os.environ["OVERPASS_REGION"] = "calgary" if region == "austin" else "austin"
for args in (["bootstrap.py"], ["bootstrap.py", "--refresh"]):
    sys.argv = args
    try:
        b.main()
        raise AssertionError("wrong region reused or overwritten")
    except RuntimeError as e:
        assert "coverage/source mismatch" in str(e)
os.environ["OVERPASS_REGION"] = "unknown"
try:
    b.load_profile()
    raise AssertionError("unknown profile accepted")
except ValueError:
    pass
print("Non-destructive bootstrap/refresh passed")
`,
          directory,
        ],
        { encoding: 'utf8', env: { ...process.env, OVERPASS_REGION: region } },
      );
      assert.equal(child.status, 0, child.stderr + child.stdout);
      assert.match(child.stdout, /Non-destructive bootstrap\/refresh passed/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}
