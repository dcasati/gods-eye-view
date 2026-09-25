"""Private, bounded HTTP adapter for read-only osm3s_query (no dispatcher)."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import subprocess
import threading
import urllib.parse
from profiles import load_profile, smoke_query, validate_snapshot

SLOTS = threading.BoundedSemaphore(2)
NUMBER = r"-?\d+(?:\.\d+)?"
BOX = rf"\(\s*({NUMBER})\s*,\s*({NUMBER})\s*,\s*({NUMBER})\s*,\s*({NUMBER})\s*\)"
SELECTOR = rf'way\s*\[\s*"highway"\s*(?:[=~]\s*"[a-zA-Z0-9_|^$().?+* -]+")?\s*\]\s*{BOX}\s*;\s*'
QUERY = re.compile(rf'^\s*\[out:json\]\s*(?:\[timeout:\d+\]\s*)?;\s*\(\s*((?:{SELECTOR})+)\)\s*;\s*out\s+geom(?:\s+qt)?\s*;\s*$')


def safe_query(query, bounds):
    match = QUERY.fullmatch(query)
    if not match:
        return False
    for box in re.finditer(BOX, match[1]):
        s, w, n, e = map(float, box.groups())
        if not (bounds[0] <= s < n <= bounds[2] and bounds[1] <= w < e <= bounds[3]):
            return False
    return True


def main():
    # Resolve once: refresh activation never mixes DB files for in-flight readers.
    snapshot = Path("/db/current").resolve(strict=True)
    metadata = json.loads((snapshot / "snapshot.json").read_text())
    _, profile = load_profile()
    validate_snapshot(metadata, profile)
    database = snapshot / "database"
    smoke = subprocess.run(
        ["/app/bin/osm3s_query", f"--db-dir={database}"],
        input=smoke_query(profile),
        text=True, capture_output=True, timeout=20, check=True,
    )
    checked = json.loads(smoke.stdout)
    if checked.get("remark") or not any(int(e.get("tags", {}).get("ways", 0)) > 0 for e in checked["elements"]):
        raise RuntimeError("Snapshot failed startup road-data check")

    class Handler(BaseHTTPRequestHandler):
        def respond(self, status, body):
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Overpass-Snapshot", metadata["osm_timestamp"])
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/healthz":
                self.respond(200, json.dumps(metadata).encode())
            else:
                self.respond(404, b'{"error":"Not found"}')

        def do_POST(self):
            self.connection.settimeout(10)
            if self.path != "/api/interpreter":
                self.respond(404, b'{"error":"Not found"}')
                return
            try:
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 24576 or self.headers.get("Transfer-Encoding"):
                    raise ValueError()
                params = urllib.parse.parse_qs(self.rfile.read(size).decode(), strict_parsing=True)
                if set(params) != {"data"} or len(params["data"]) != 1:
                    raise ValueError()
                query = params["data"][0]
                if not safe_query(query, metadata["bounds"]):
                    raise ValueError()
            except (ValueError, UnicodeError):
                self.respond(400, b'{"error":"Only contained regional road bbox queries are supported"}')
                return
            if not SLOTS.acquire(blocking=False):
                self.respond(503, b'{"error":"Regional query capacity reached"}')
                return
            try:
                # Two <=256 MiB query budgets, plus DB/page cache. Hard process
                # deadline is lower than the proxy's per-source network deadline.
                query = re.sub(r"\[timeout:\d+\]", "", query).replace(
                    "[out:json]", "[out:json][timeout:15][maxsize:268435456]", 1
                )
                result = subprocess.run(
                    ["/app/bin/osm3s_query", f"--db-dir={database}"],
                    input=query, text=True, capture_output=True, timeout=18,
                )
                body = result.stdout.encode()
                parsed = json.loads(body)
                if result.returncode or parsed.get("remark") or not isinstance(parsed.get("elements"), list) or len(body) > 32 * 1024 * 1024:
                    raise ValueError("Overpass failure")
                self.respond(200, body)
            except (subprocess.TimeoutExpired, ValueError):
                self.respond(503, b'{"error":"Regional Overpass query failed"}')
            finally:
                SLOTS.release()

    print("Serving immutable snapshot", metadata, flush=True)
    ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()


if __name__ == "__main__":
    main()
