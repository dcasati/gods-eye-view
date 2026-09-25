"""Build-time nonroot import/query smoke test; no network or source download."""
import json
import os
from pathlib import Path
import shutil
import subprocess
from profiles import PROFILES, smoke_query

assert os.getuid() == 1000, "Image must execute as the runtime UID"
database = Path("build-selftest")
database.mkdir()
xml = """<osm version="0.6">
<node id="1" version="1" lat="30.270" lon="-97.740"/>
<node id="2" version="1" lat="30.271" lon="-97.741"/>
<node id="3" version="1" lat="51.050" lon="-114.070"/>
<node id="4" version="1" lat="51.051" lon="-114.071"/>
<way id="1" version="1"><nd ref="1"/><nd ref="2"/>
<tag k="highway" v="residential"/></way>
<way id="2" version="1"><nd ref="3"/><nd ref="4"/>
<tag k="highway" v="residential"/></way></osm>"""
try:
    subprocess.run(
        ["/app/bin/update_database", f"--db-dir={database.resolve()}",
         "--version=2026-09-24T21:00:00Z", "--flush-size=16",
         "--compression-method=gz", "--map-compression-method=gz"],
        input=xml, text=True, check=True, timeout=60,
    )
    result = subprocess.run(
        ["/app/bin/osm3s_query", f"--db-dir={database.resolve()}"],
        input='[out:json][timeout:10];(way["highway"](30.26,-97.75,30.28,-97.73););out geom qt;',
        text=True, capture_output=True, check=True, timeout=20,
    )
    payload = json.loads(result.stdout)
    assert not payload.get("remark"), payload
    assert len(payload["elements"]) == 1, payload
    assert len(payload["elements"][0]["geometry"]) == 2, payload
    assert payload["osm3s"]["timestamp_osm_base"] == "2026-09-24T21:00:00Z", payload
    for name, profile in PROFILES.items():
        result = subprocess.run(
            ["/app/bin/osm3s_query", f"--db-dir={database.resolve()}"],
            input=smoke_query(profile), text=True, capture_output=True, check=True, timeout=20,
        )
        payload = json.loads(result.stdout)
        assert not payload.get("remark"), payload
        assert any(int(e.get("tags", {}).get("ways", 0)) > 0 for e in payload["elements"]), name
    print("Nonroot import + direct query + source timestamp smoke test passed")
finally:
    shutil.rmtree(database)
