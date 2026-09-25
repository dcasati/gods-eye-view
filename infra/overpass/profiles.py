"""Known road snapshot profiles, shared by import and startup verification."""
import os

PROFILES = {
    "austin": {
        "bounds": [29.9, -98.2, 30.7, -97.2],
        "source": "https://download.geofabrik.de/north-america/us/texas-latest.osm.pbf",
        "smoke_bounds": [30.26, -97.75, 30.28, -97.73],
    },
    "calgary": {
        "bounds": [50.7, -114.6, 51.4, -113.6],
        "source": "https://download.geofabrik.de/north-america/canada/alberta-latest.osm.pbf",
        "smoke_bounds": [51.04, -114.08, 51.06, -114.05],
    },
}


def load_profile():
    name = os.environ.get("OVERPASS_REGION", "austin")
    if name not in PROFILES:
        raise ValueError(f"Unknown OVERPASS_REGION: {name}")
    return name, PROFILES[name]


def smoke_query(profile):
    bbox = ",".join(map(str, profile["smoke_bounds"]))
    return f'[out:json][timeout:10];way["highway"]({bbox});out count;'


def validate_snapshot(metadata, profile):
    if metadata["bounds"] != profile["bounds"] or metadata["source"] != profile["source"]:
        raise RuntimeError("Existing snapshot coverage/source mismatch; refusing reuse")
