"""Build an immutable roads-only Austin snapshot; never modify a serving DB."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request
import uuid

ROOT = Path("/db")
BOUNDS = [29.9, -98.2, 30.7, -97.2]  # south, west, north, east
SOURCE = "https://download.geofabrik.de/north-america/us/texas-latest.osm.pbf"
SMOKE_QUERY = '[out:json][timeout:10];way["highway"](30.26,-97.75,30.28,-97.73);out count;'


def run(*args):
    print("Running:", *args, flush=True)
    subprocess.run(args, check=True)


def main():
    current = ROOT / "current"
    if current.exists() and "--refresh" not in sys.argv:
        metadata = json.loads((current / "snapshot.json").read_text())
        if metadata["bounds"] != BOUNDS:
            raise RuntimeError("Existing snapshot coverage mismatch; refusing reuse")
        print("Reusing snapshot", metadata, flush=True)
        return
    marker = ROOT / "bootstrap-in-progress"
    initial = not current.exists() and "--refresh" not in sys.argv
    if initial and marker.exists():
        raise RuntimeError(
            "Unfinished bootstrap: inspect " + marker.read_text().strip()
            + "; after diagnosis remove only /db/bootstrap-in-progress to retry"
        )
    snapshot_id = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    stage = ROOT / "snapshots" / snapshot_id
    stage.mkdir(parents=True)
    if initial:
        marker.write_text(str(stage) + "\n")
    texas, crop, roads = (stage / name for name in ("texas.osm.pbf", "crop.osm.pbf", "roads.osm.pbf"))
    # Failed imports stay isolated for diagnosis; no current data or cache is deleted.
    sha = hashlib.sha256()
    print("Downloading public Geofabrik Texas extract", flush=True)
    request = urllib.request.Request(SOURCE, headers={"User-Agent": "gods-eye-view/0.1 (+https://github.com/bilawalsidhu/gods-eye-view)"})
    with urllib.request.urlopen(request, timeout=120) as response, texas.open("wb") as output:
        resolved_url = response.url
        modified = response.headers.get("Last-Modified")
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
            sha.update(chunk)
    timestamp = subprocess.check_output(
        ["osmium", "fileinfo", "-g", "header.option.osmosis_replication_timestamp", str(texas)],
        text=True,
    ).strip()
    if not timestamp:
        timestamp = subprocess.check_output(
            ["osmium", "fileinfo", "-e", "-g", "data.timestamp.last", str(texas)], text=True
        ).strip()
    if not timestamp:
        raise RuntimeError("Source snapshot has no timestamp; refusing undated data")
    run("osmium", "extract", "--bbox=-98.2,29.9,-97.2,30.7", "--strategy=complete_ways", str(texas), "-o", str(crop))
    run("osmium", "tags-filter", str(crop), "w/highway", "-o", str(roads))
    database = stage / "database"
    database.mkdir()
    # Stream XML directly, avoiding a multi-GB decompressed intermediate file.
    convert = subprocess.Popen(["osmium", "cat", str(roads), "-f", "osm"], stdout=subprocess.PIPE)
    try:
        imported = subprocess.run([
            "/app/bin/update_database", f"--db-dir={database}", f"--version={timestamp}",
            "--compression-method=gz", "--map-compression-method=gz", "--flush-size=16",
        ], stdin=convert.stdout, check=False)
        convert.stdout.close()
        conversion_status = convert.wait()
    finally:
        if convert.poll() is None:
            convert.kill()
            convert.wait()
    if imported.returncode or conversion_status:
        raise RuntimeError("OSM conversion/import failed")
    smoke = subprocess.run(
        ["/app/bin/osm3s_query", f"--db-dir={database}"], input=SMOKE_QUERY,
        text=True, capture_output=True, timeout=30, check=True,
    )
    data = json.loads(smoke.stdout)
    if data.get("remark") or not any(int(e.get("tags", {}).get("ways", 0)) > 0 for e in data["elements"]):
        raise RuntimeError("Austin downtown contains no roads; refusing snapshot activation")
    metadata = {
        "id": snapshot_id, "bounds": BOUNDS, "contents": "highway ways and referenced nodes only",
        "source": SOURCE, "resolved_source": resolved_url, "source_last_modified": modified,
        "source_sha256": sha.hexdigest(), "osm_timestamp": timestamp,
        "imported_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "overpass_version": "0.7.62.11", "updates": "manual immutable snapshot replacement",
    }
    (stage / "snapshot.json").write_text(json.dumps(metadata, indent=2) + "\n")
    for intermediate in (texas, crop, roads):
        intermediate.unlink()
    link = ROOT / ("activate-" + snapshot_id)
    link.symlink_to(stage.relative_to(ROOT), target_is_directory=True)
    os.replace(link, current)
    if initial:
        marker.unlink()
    print("Activated snapshot:", json.dumps(metadata), flush=True)


if __name__ == "__main__":
    main()
