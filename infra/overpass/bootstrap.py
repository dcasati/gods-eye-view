"""Build an immutable regional roads-only snapshot; never modify a serving DB."""
import datetime
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import urllib.request
import uuid
from profiles import load_profile, smoke_query, validate_snapshot

ROOT = Path("/db")


def run(*args):
    print("Running:", *args, flush=True)
    subprocess.run(args, check=True)


def main():
    region, profile = load_profile()
    bounds, source = profile["bounds"], profile["source"]
    current = ROOT / "current"
    if current.exists():
        metadata = json.loads((current / "snapshot.json").read_text())
        validate_snapshot(metadata, profile)
        if "--refresh" not in sys.argv:
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
    extract, crop, roads = (stage / name for name in ("source.osm.pbf", "crop.osm.pbf", "roads.osm.pbf"))
    # Failed imports stay isolated for diagnosis; no current data or cache is deleted.
    sha = hashlib.sha256()
    print(f"Downloading public Geofabrik extract for {region}: {source}", flush=True)
    request = urllib.request.Request(source, headers={"User-Agent": "gods-eye-view/0.1 (+https://github.com/bilawalsidhu/gods-eye-view)"})
    with urllib.request.urlopen(request, timeout=120) as response, extract.open("wb") as output:
        resolved_url = response.url
        modified = response.headers.get("Last-Modified")
        while chunk := response.read(1024 * 1024):
            output.write(chunk)
            sha.update(chunk)
    timestamp = subprocess.check_output(
        ["osmium", "fileinfo", "-g", "header.option.osmosis_replication_timestamp", str(extract)],
        text=True,
    ).strip()
    if not timestamp:
        timestamp = subprocess.check_output(
            ["osmium", "fileinfo", "-e", "-g", "data.timestamp.last", str(extract)], text=True
        ).strip()
    if not timestamp:
        raise RuntimeError("Source snapshot has no timestamp; refusing undated data")
    south, west, north, east = bounds
    run("osmium", "extract", f"--bbox={west},{south},{east},{north}", "--strategy=complete_ways", str(extract), "-o", str(crop))
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
        ["/app/bin/osm3s_query", f"--db-dir={database}"], input=smoke_query(profile),
        text=True, capture_output=True, timeout=30, check=True,
    )
    data = json.loads(smoke.stdout)
    if data.get("remark") or not any(int(e.get("tags", {}).get("ways", 0)) > 0 for e in data["elements"]):
        raise RuntimeError(f"{region} downtown contains no roads; refusing snapshot activation")
    metadata = {
        "id": snapshot_id, "region": region, "bounds": bounds, "contents": "highway ways and referenced nodes only",
        "source": source, "resolved_source": resolved_url, "source_last_modified": modified,
        "source_sha256": sha.hexdigest(), "osm_timestamp": timestamp,
        "imported_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "overpass_version": "0.7.62.11", "updates": "manual immutable snapshot replacement",
    }
    (stage / "snapshot.json").write_text(json.dumps(metadata, indent=2) + "\n")
    for intermediate in (extract, crop, roads):
        intermediate.unlink()
    link = ROOT / ("activate-" + snapshot_id)
    link.symlink_to(stage.relative_to(ROOT), target_is_directory=True)
    os.replace(link, current)
    if initial:
        marker.unlink()
    print("Activated snapshot:", json.dumps(metadata), flush=True)


if __name__ == "__main__":
    main()
