# Private deployment on the existing AKS cluster

Target **only** Kubernetes context `aks-mira-caldova`, namespace
`gods-eye-view`, and the existing ACR `acrmiracaldova`. These artifacts do not
create a cluster, registry, ingress, load balancer, public IP, DNS record, or
Azure role assignment. The Service is **ClusterIP**, port **80 → 4173**.
Access is through an authorized, **localhost-only port-forward**.

The production container runs `node server/standalone/production.mjs` (also
available as `npm start`), serving built `dist/` and same-origin provider APIs.
This is not Vite's development server or `vite preview`. `GET /healthz` and
`GET /readyz` are local process/readiness checks, not guarantees that every
external provider is available.

## Preconditions

- Run commands from the repository root, using Bash, `kubectl`, Azure CLI, and
  Python 3. `kubectl kustomize` is sufficient; standalone Kustomize is not needed.
- Existing Azure authentication must be authorized for this ACR and its remote
  builds. Confirm the intended subscription independently before running Azure
  commands; Kubernetes context selection does **not** select an Azure subscription.
  Stop on authorization errors rather than changing accounts or cluster targets.
- Context `aks-mira-caldova` must already exist and be authorized for namespace,
  workload, Secret, and port-forward operations. Every Kubernetes command below
  specifies it explicitly; do not change the global current context.
- AKS nodes must already be able to pull from `acrmiracaldova.azurecr.io` using
  their existing identity and network path. This guide does not enable ACR admin
  credentials, create registry passwords, or modify AKS/ACR permissions.
- The image is built for **linux/amd64**; the cluster must have matching nodes.
  Namespace admission must allow the restricted pod specification.
- Application API credentials are optional and belong only in the
  `gods-eye-view-secrets` Kubernetes Secret. Never put them in Git, ConfigMap,
  image layers, build arguments, build logs, or the build context.

ACR remote build does not need a local Docker daemon, but does need working
Azure authorization. `infra/aks/kustomization.yaml` pins the published image
digest. Deployment history and verification evidence are recorded in
`.azure/deployment-plan.md`.

## 1. Build a credential-free image remotely

Use a clean, reviewed checkout containing the production Dockerfile,
`.dockerignore`, and application changes. Keep the credentials env file **outside
this checkout**. Confirm `.dockerignore` excludes local `.env` files, private
credentials, caches, logs, and other local artifacts. Do not upload an existing
working directory containing arbitrary credential files, even if they are
Git-ignored: Docker/ACR build context filtering uses `.dockerignore`, not
`.gitignore`. No API keys are required at build time.

Use a unique tag, never `latest`. Record its immutable digest after the build:

```bash
set -euo pipefail
IMAGE_TAG="aks-$(git rev-parse --short=12 HEAD)-$(date -u +%Y%m%dT%H%M%SZ)"
az acr build \
  --subscription 6ab9178f-09bc-45be-ba47-f682147eb1f0 \
  --registry acrmiracaldova \
  --platform linux/amd64 \
  --file Dockerfile \
  --image "gods-eye-view:${IMAGE_TAG}" \
  .

IMAGE_DIGEST="$(az acr repository show \
  --subscription 6ab9178f-09bc-45be-ba47-f682147eb1f0 \
  --name acrmiracaldova \
  --image "gods-eye-view:${IMAGE_TAG}" \
  --query digest --output tsv)"
[[ "$IMAGE_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] || {
  echo "Expected an ACR image digest; refusing deployment." >&2
  exit 1
}
IMAGE_REF="acrmiracaldova.azurecr.io/gods-eye-view@${IMAGE_DIGEST}"
```

Keep `IMAGE_REF` for subsequent applies and rollback. The base Deployment has
an intentionally unusable `:PLACEHOLDER` image, replaced by the digest in
`kustomization.yaml`. Apply the complete Kustomize directory, not the base
Deployment by itself. When updating, also update that recorded digest.

## 2. Create the namespace and supply optional credentials

```bash
kubectl --context aks-mira-caldova apply -f infra/aks/namespace.yaml
```

The initial launch is **keyless**: do not read an original checkout's `.env` or
other credential files without explicit consent. For this new namespace, create
an empty Secret **only if absent**, using `create`, never `apply` or `replace`:

```bash
set -euo pipefail
EXISTING_SECRET="$(kubectl --context aks-mira-caldova --namespace gods-eye-view \
  get secret gods-eye-view-secrets --ignore-not-found -o name)"
if [[ -z "$EXISTING_SECRET" ]]; then
  kubectl --context aks-mira-caldova --namespace gods-eye-view \
    create secret generic gods-eye-view-secrets
else
  echo "Existing Secret preserved; review before deployment if keyless operation is required."
fi
```

The lookup prints only the resource name, never its data. Lookup errors stop the
script. If another operator creates the Secret between lookup and creation,
`create` fails safely rather than overwriting it. Never apply an empty Secret or
a manifest containing blank example credentials over an existing Secret.

The Deployment's `secretRef` is explicitly **optional** (`optional: true`):
an absent or empty Secret permits keyless startup, while an existing populated
Secret supplies its credentials. Existing credentials are not erased to force
keyless mode; stop for review if an existing Secret's intended use is unclear.

To enable providers, use a user-selected, owner-readable env file outside the
checkout with only the credential names needed, in `NAME=value` format (no shell
`export`, expansion, or surrounding shell quotes). Refer to `.env.example` for
descriptions, but **do not use that entire file as a Secret**: non-secret settings
belong in the ConfigMap. Supported credential names include:

| Credential names | Purpose |
| --- | --- |
| `GOOGLE_MAPS_API_KEY`, `CESIUM_ION_TOKEN` | Browser map providers; intentionally browser-visible |
| `GOOGLE_MAPS_SERVER_API_KEY` | Separate server-side Google Places/Street View key |
| `OPENAI_API_KEY` | Voice and HUD summaries |
| `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET` | Optional OpenSky OAuth; also change ConfigMap auth mode to `oauth` |
| `OPENSKY_USERNAME`, `OPENSKY_PASSWORD` | Optional OpenSky basic auth; also change auth mode to `basic` |
| `AISSTREAM_API_KEY` | Live vessels |
| `FIRMS_MAP_KEY` | NASA FIRMS fires |
| `TOMTOM_API_KEY` | Live traffic tiles |
| `LL2_API_TOKEN`, `TFL_APP_KEY` | Optional provider allowances |

Use a **complete file containing every credential this workflow should retain**
when updating an existing Secret. Server-side apply merges with fields owned by
other managers, but omitting a key previously owned by this manager removes it.
Do not use `--force-conflicts`; resolve ownership conflicts deliberately.
This does not print Secret values or store them in a last-applied annotation:

```bash
set -euo pipefail
# Set this to your existing credential file; do not put its contents in commands.
SECRETS_ENV_FILE="/absolute/path/outside/checkout/provider-credentials.env"
test -s "$SECRETS_ENV_FILE"
kubectl --context aks-mira-caldova --namespace gods-eye-view \
  create secret generic gods-eye-view-secrets \
  --from-env-file="$SECRETS_ENV_FILE" --dry-run=client -o json |
  python3 -c '
import json, sys
secret = json.load(sys.stdin)
data = secret.get("data", {})
allowed = set("""GOOGLE_MAPS_API_KEY CESIUM_ION_TOKEN GOOGLE_MAPS_SERVER_API_KEY
OPENAI_API_KEY OPENSKY_CLIENT_ID OPENSKY_CLIENT_SECRET OPENSKY_USERNAME
OPENSKY_PASSWORD AISSTREAM_API_KEY FIRMS_MAP_KEY TOMTOM_API_KEY LL2_API_TOKEN
TFL_APP_KEY""".split())
if not data or not set(data) <= allowed or not all(data.values()):
    sys.exit("Refusing empty Secret, blank credentials, or non-credential settings.")
json.dump(secret, sys.stdout)
' |
  kubectl --context aks-mira-caldova --namespace gods-eye-view \
    apply --server-side --field-manager=gev-secret-env -f -
```

The intermediate Secret JSON travels only through the pipe. Do not enable shell
tracing, pipe it to `tee`, request verbose HTTP logs, or run `kubectl get secret
-o yaml`. Kubernetes Secrets are not encrypted merely because their data is
base64-encoded: use namespace-scoped RBAC and the cluster's encryption-at-rest
controls. Pod environment access and exec permissions also grant access to keys.

`GOOGLE_MAPS_API_KEY` and `CESIUM_ION_TOKEN` remain in the Secret at rest but are
**necessarily exposed to the browser** through `/api/runtime-config.js`, a classic
blocking script loaded before the application module. Restrict
Google keys by API and the intended localhost HTTP referrer, and scope Cesium
tokens to required public assets and allowed URLs. Prefer the separate
server-side Google key with suitable API/IP restrictions. Only the allowlisted
browser keys and `VITE_AIS_*` settings are returned; other credentials remain
server-side.

## 3. Configure and apply the digest-pinned workload

The complete Kustomize directory also includes the regional source. Complete
**Austin regional roads: build and initial import** below and record its image
digest before this apply; replacing the app image alone leaves a deliberately
unusable regional placeholder.

Review `infra/aks/configmap.yaml` before applying. It sets `NODE_ENV=production`,
`HOST=0.0.0.0`, `PORT=4173`, anonymous OpenSky access, the OpenAI model/context
defaults from `.env.example`, same-origin `/api/ais-live`, and vessel/label caps.
Google and OpenAI per-IP rate guards are explicitly enabled at 60 and 30
requests/minute; TomTom's soft upstream-fetch ceiling is 6,000 per UTC day.
These are **not billing caps**. Set provider-side quotas and usage limits too.
Models and provider pricing may change independently of this deployment.

Using `IMAGE_REF` from step 1, render and replace only this application's image:

```bash
set -euo pipefail
[[ "${IMAGE_REF:-}" =~ ^acrmiracaldova\.azurecr\.io/gods-eye-view@sha256:[a-f0-9]{64}$ ]] || {
  echo "Set IMAGE_REF to the verified ACR digest before applying." >&2
  exit 1
}
kubectl --context aks-mira-caldova kustomize infra/aks |
  sed -E "s|acrmiracaldova\\.azurecr\\.io/gods-eye-view[:@][^[:space:]]+|${IMAGE_REF}|g" |
  kubectl --context aks-mira-caldova --namespace gods-eye-view apply -f -

kubectl --context aks-mira-caldova --namespace gods-eye-view \
  rollout status deployment/gods-eye-view --timeout=180s
kubectl --context aks-mira-caldova --namespace gods-eye-view \
  get deployment gods-eye-view \
  -o jsonpath='{.spec.template.spec.containers[0].image}{"\n"}'
kubectl --context aks-mira-caldova --namespace gods-eye-view \
  get pods,services,networkpolicies
```

For an offline render only (no cluster access or deployment):

```bash
KUBECONFIG=/dev/null kubectl --context aks-mira-caldova kustomize infra/aks
```

Rendering checks Kustomize composition, **not full Kubernetes schema validity**.
If `kubeconform` and a matching Kubernetes JSON-schema directory are already
available, validate offline against the target cluster version without reading
cluster credentials (set these two variables to your installed schema bundle):

```bash
set -euo pipefail
: "${KUBERNETES_VERSION:?Set the target Kubernetes version, for example 1.34.0}"
: "${KUBERNETES_SCHEMA_LOCATION:?Set a local kubeconform schema-location template}"
KUBECONFIG=/dev/null kubectl --context aks-mira-caldova kustomize infra/aks |
  kubeconform -strict -summary \
    -kubernetes-version "$KUBERNETES_VERSION" \
    -schema-location "$KUBERNETES_SCHEMA_LOCATION"
```

Do not use server-side dry-run while cluster operations are blocked. Offline
validation does not establish admission-policy compatibility, CNI enforcement,
ACR pull permission, or successful scheduling.

The pod runs as UID/GID 1000 with a read-only root filesystem, dropped
capabilities, no privilege escalation, `RuntimeDefault` seccomp, and no mounted
service-account token. `/app/.gev-cache` uses the `gods-eye-view-cache`
managed-csi ReadWriteOnce PVC (8Gi request; Azure Standard SSD minimum billing
tier is 32Gi). Writable `emptyDir` volumes are limited to
`/app/.gev-logs` and `/tmp`. There is no writable key-setup UI
or `.env` file; manage provider keys through the Secret, not the local
development Provider Settings workflow.

One replica requests 250m CPU / 512Mi memory and is limited to 2 CPU / 2Gi.
Startup, readiness, and liveness probes use the named HTTP port. The Node
process runs directly as PID 1 so it receives SIGTERM, with a 45-second
termination grace period. `Recreate` avoids temporarily running two provider
clients during updates; it deliberately introduces downtime. This is not an HA
deployment.

## 4. Access only from localhost

Run in a dedicated terminal and keep it open:

```bash
kubectl --context aks-mira-caldova --namespace gods-eye-view \
  port-forward --address 127.0.0.1 service/gods-eye-view 4173:80
```

Then open <http://127.0.0.1:4173>. In another terminal:

```bash
curl --fail http://127.0.0.1:4173/healthz
curl --fail http://127.0.0.1:4173/readyz
```

Do not bind port-forward to `0.0.0.0`, add an Ingress, use NodePort/LoadBalancer,
or share the forwarding endpoint. Anyone who reaches the app can invoke its
key-brokering APIs and spend provider quota; it is not a multi-user authenticated
service.

The ingress-only NetworkPolicy has **no ingress rules** and denies ordinary
inbound pod traffic when the cluster CNI enforces NetworkPolicy. Node/kubelet
traffic (including probes and the normal Kubernetes port-forward path) is not
blocked by this policy. Egress is intentionally unrestricted for DNS, HTTP(S),
WebSockets, and external providers; existing cluster-wide policies or firewalls
can still restrict it. Policies are additive: another policy selecting this pod
could allow ingress. Verify enforcement with the cluster administrator rather
than assuming that an accepted NetworkPolicy resource proves isolation.

The target cluster reported `networkPolicy: none` on 2026-09-25. The included
NetworkPolicy must therefore **not** be relied on for pod-level isolation; this
deployment does not change the shared cluster's CNI configuration.

Even without CNI policy enforcement, this configuration provisions **no public
Service or ingress**. However, ClusterIP alone does not prevent other workloads
or private-network clients with cluster routing from reaching the API. An
administrator with exec/port-forward permissions also bypasses this isolation.

## Updates, verification, and operations

- **Secret or ConfigMap change:** repeat the appropriate apply above, then
  restart; environment variables are read when the pod starts, not hot-reloaded.
  Reapplying the ConfigMap alone does not trigger a rollout.

  ```bash
  kubectl --context aks-mira-caldova --namespace gods-eye-view \
    rollout restart deployment/gods-eye-view
  kubectl --context aks-mira-caldova --namespace gods-eye-view \
    rollout status deployment/gods-eye-view --timeout=180s
  ```

- **Image update/rollback:** build and record a new digest, or set `IMAGE_REF` to
  a previously recorded digest, then repeat step 3. Never reapply the placeholder
  or use a mutable `latest` tag. Reconnect port-forward after a pod replacement.
- **Optional keys:** absent map keys fall back to keyless basemaps; OpenSky
  remains anonymous/rate-limited; missing OpenAI, FIRMS, or AIS keys disable or
  degrade those features; missing TomTom uses simulated traffic. Unconfigured
  provider failures do not mean the process health checks should fail.
- **Persistent cache:** `.gev-cache/overpass` and the on-disk TomTom budget now
  survive pod replacement on the cache PVC. Do not delete/recreate the PVC or
  wipe its contents during updates. Before the first migration from `emptyDir`,
  preserve any valuable existing cache separately; an old pod's `emptyDir`
  cannot be recovered after replacement. The observed Overpass cache was empty.
  File logs remain ephemeral and process-local rate limits still reset on
  process restart. Provider-side quotas remain essential.
- **Troubleshooting:** inspect status/events for image-pull, admission,
  scheduling, or probe failures. Check the existing node identity's ACR pull
  permission with an administrator; do not enable admin registry credentials as
  a shortcut.

  ```bash
  kubectl --context aks-mira-caldova --namespace gods-eye-view \
    describe deployment gods-eye-view
  kubectl --context aks-mira-caldova --namespace gods-eye-view \
    get events --sort-by=.lastTimestamp
  ```

  If reviewing application logs, treat them as private operational data and
  redact any provider URLs or identifiers before sharing. Do not dump pod
  environments or Secret contents for troubleshooting.

### Traffic unavailable versus loading

The traffic client permits **three total attempts per viewport**, not unlimited
automatic retries. Its failure indication remains visible throughout retry
backoff; each attempt has a **95-second request-plus-response-body deadline**.
When no roads are rendered, failure is explicitly **unavailable**, not a
successful empty road layer. After the budget is exhausted, manually toggle
the layer or move to a new viewport to reset it. This does not reset an
upstream provider's quota or restore its service.

First inspect whether the viewport's entire queried bbox lies inside Austin
coverage: latitude **29.9–30.7**, longitude **−98.2–−97.2**. Crossing an edge,
being partially inside, or being outside keeps that request on the global
sources. Only the supported highway-bbox grammar can use the regional source;
admin, boundary, `around`, and `is_in` queries stay global even near Austin.
The known public-mirror 406 responses and timeouts therefore remain a real
limitation outside regional road coverage. Repeated toggling cannot repair
them. Inside coverage, check the regional import logs, readiness, snapshot
timestamp and `x-overpass-upstream`; cached responses may predate a refresh.

## Austin regional roads: build and initial import

The private source is deliberately **not a full-planet Overpass service**.
Coverage is latitude **29.9–30.7**, longitude **−98.2–−97.2**, chosen as a
conservative Austin-area operational default. Only highway ways and their
referenced nodes are imported. No admin relations, area generation, attic,
planet cloning or planet replication runs.

`OVERPASS_REGIONAL_URL` and `OVERPASS_REGIONAL_BOUNDS` in the app ConfigMap are
server-only, read once at startup, and must be supplied together. Bounds are
`south,west,north,east`. The provider fully matches a small grammar (the app's
`(way["highway"~"..."](s,w,n,e););out geom qt;` queries), requires **every** bbox
to be inside coverage, and tries the private source first only in that case.
Crossing, overlapping, outside, around, boundary, admin, `is_in`, recursion,
non-road, and unfamiliar queries keep the full-planet path. Regional failures
fall through to those mirrors; HTTP-200 errors are not authoritative empties.
This does not make the currently failing global mirrors reliable outside Austin.
The regional HTTP adapter independently enforces the same road/coverage rules.

Unset both variables to disable regional routing. `OVERPASS_UPSTREAMS_JSON`
optionally replaces the ordered **full-planet** list with operator-controlled
http(s) interpreter URLs; no credentials, query strings, fragments or whitespace
are accepted. Private `.svc` hosts are intentionally allowed. Never put a
regional extract in that full-planet list. Invalid config fails server startup.
There is no request-level endpoint override or User-Agent evasion.

Build from the small, credential-free `infra/overpass` context:

The image reuses already-compiled, digest-pinned upstream binaries; this is a
small wrapper build, **not a fresh C++ compile or Texas import**. Allow roughly
**2–10 minutes plus ACR queue time and image-layer transfer** as a planning
allowance; the first successful build/push took 43 seconds, and the final
self-tested build took 35 seconds on 2026-09-25. The separate first import runs on AKS after
image publication and is estimated below. Either an authorized ACR remote
build or a CI Docker build/push can publish it; both must use this same context
and record the resulting digest. The GitHub OIDC identity template is
`infra/ci/identity.bicep` (ARM validation passed during preparation). Identity
template validation is not proof that federation, AcrPush or an image build
has actually completed.

```bash
REGIONAL_TAG="austin-$(git rev-parse --short=12 HEAD)-$(date -u +%Y%m%dT%H%M%SZ)"
az acr build --registry acrmiracaldova --platform linux/amd64 \
  --file infra/overpass/Dockerfile --image "overpass-austin:${REGIONAL_TAG}" infra/overpass
REGIONAL_DIGEST="$(az acr repository show --name acrmiracaldova \
  --image "overpass-austin:${REGIONAL_TAG}" --query digest --output tsv)"
[[ "$REGIONAL_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]] || exit 1
REGIONAL_REF="acrmiracaldova.azurecr.io/overpass-austin@${REGIONAL_DIGEST}"
```

Record this digest in `infra/aks/kustomization.yaml` as another `images` entry
named `acrmiracaldova.azurecr.io/overpass-austin` **before applying step 3**.
Both the init container and server must resolve to that digest; never deploy
the placeholder. The manual refresh Job below is intentionally not included in
Kustomize and takes the same image explicitly.

The derived Dockerfile pins upstream `wiktorn/overpass-api` **v0.7.62.11** at
`sha256:5f643f2aa500333f19458fe8be14457215d6e0b9f891ca5c5ed452b1f8882c47`
(registry index and linux/amd64 manifest verified 2026-09-25). Its root-oriented
entrypoint, nginx, supervisor, eval-based preprocessing, updater, and dispatcher
are **not run**. UID/GID 1000 runs `bootstrap.py`, then `server.py`. The latter
invokes `/app/bin/osm3s_query --db-dir=...`, the upstream-supported direct,
read-only database mode. No executable commands come from configuration.
Upstream references: [container scripts](https://github.com/wiktorn/Overpass-API),
[direct query CLI](https://github.com/drolbr/Overpass-API/blob/master/src/overpass_api/dispatch/osm3s_query.cc),
[import CLI](https://github.com/drolbr/Overpass-API/blob/master/src/overpass_api/osm-backend/update_database.cc).

First startup uses an init container to download the **public**, no-auth
[Texas PBF](https://download.geofabrik.de/north-america/us/texas-latest.osm.pbf),
crop with `osmium extract --strategy=complete_ways`, retain `w/highway` and
referenced nodes via `osmium tags-filter`, then stream XML into
`update_database --flush-size=16 --compression-method=gz
--map-compression-method=gz --version=<source timestamp>`. Complete ways retain
their outside-bbox nodes so road geometries at the crop edge are not truncated.
A nonempty downtown Austin road count must pass before activation.

The 64Gi managed-csi RWO disk allows source/download staging, import scratch,
and retained snapshots. Init and server each request **1 CPU / 2Gi**, limit
**2 CPU / 6Gi**; they run sequentially, not concurrently. The server permits
two concurrent queries with 256MiB QL budgets and an 18-second hard subprocess
deadline. Allow **roughly 15–90 minutes for first download/import** at these
limits (estimate, not measured on this cluster; slow disk/network may take
longer). Observe init logs instead of assuming the app's 180-second rollout
timeout covers it. An OOM/failure never activates a partial DB.
An interrupted first import leaves `/db/bootstrap-in-progress`; subsequent
init retries fail loudly instead of redownloading Texas until the disk fills.
Inspect the named staging directory and diagnose the failure, then remove only
that marker to authorize a fresh import (retain failed staging until reviewed).

```bash
kubectl --context aks-mira-caldova -n gods-eye-view logs \
  deployment/overpass-austin -c import -f
kubectl --context aks-mira-caldova -n gods-eye-view rollout status \
  deployment/overpass-austin --timeout=7200s
```

Data lives in `/db/snapshots/<UTC-id>/database`; `snapshot.json` records source
URL, resolved dated URL, SHA-256, Last-Modified, OSM timestamp, coverage,
import time and version. `/db/current` switches atomically only after a
successful import/check. The server mounts the disk **read-only**, resolves the
snapshot once and checks real downtown roads before binding port 8080.
`GET /healthz` returns this snapshot metadata; it does **not** claim current
planet freshness. Query JSON retains `osm3s.timestamp_osm_base` from that source.
`cachedAt` means cache fetch time, **not OSM data age**. Existing 24h memory /
7-day disk / stale-outage semantics are unchanged; refresh does not wipe cache.

All pods satisfy restricted PSS (nonroot, no privilege escalation, all caps
dropped, RuntimeDefault seccomp). Service `overpass-austin` is ClusterIP only.
Its NetworkPolicy allows app pods in the same namespace; the existing app
ingress-deny policy does not prevent outbound regional requests. The cluster's
`networkPolicy: none` remains unchanged, so do not claim enforced isolation.

Validate from the app pod (no provider keys needed), and verify a **nonempty**
`elements` array and `x-overpass-upstream` identifying the private service for:

```text
[out:json][timeout:15];(way["highway"~"primary|secondary|residential"](30.26,-97.75,30.28,-97.73););out geom qt;
```

Also test a bbox outside Austin and an admin query: neither may be sent to this
regional source. Repeat a successful request across an **app** rollout and
verify `x-overpass-cache: DISK` (or HIT after warming). Check `/healthz` snapshot
date separately; a successful cached response is not proof of current OSM data.

## Non-destructive regional refresh

Refresh is **manual**, not minute replication; check snapshot age operationally
and refresh weekly or when source changes matter. Full-planet diffs would break
the roads-only extract contract. Keep old snapshots for rollback.

1. Confirm disk free space for another Texas source + import + retained DB.
   Scale only `deployment/overpass-austin` to zero and wait for termination
   (RWO disk detach); app can serve durable stale cache or global fallback.
2. Create the manual Job with the verified regional image. Do not use `apply`
   against a Job generated for an earlier refresh:

   ```bash
   [[ "${REGIONAL_REF:-}" =~ ^acrmiracaldova\.azurecr\.io/overpass-austin@sha256:[a-f0-9]{64}$ ]] || exit 1
   kubectl --context aks-mira-caldova -n gods-eye-view scale \
     deployment/overpass-austin --replicas=0
   kubectl --context aks-mira-caldova -n gods-eye-view wait \
     --for=delete pod -l app.kubernetes.io/name=overpass-austin --timeout=180s
   sed "s|acrmiracaldova.azurecr.io/overpass-austin:PLACEHOLDER|${REGIONAL_REF}|" \
     infra/aks/overpass-refresh.yaml |
     kubectl --context aks-mira-caldova -n gods-eye-view create -f -
   ```

3. Watch that Job's logs and completion (four-hour Job deadline). Failure leaves
   `/db/current` and all previous snapshots intact; inspect failed staging
   before explicitly removing only unwanted staging directories. Never wipe
   the PVC, `.gev-cache`, or current/retained snapshots as a recovery shortcut.
4. Scale `deployment/overpass-austin` back to one whether refresh succeeded or
   failed; its init reuses current, and server startup verifies real data.
   Check `/healthz` for expected `id` and `osm_timestamp`.
   Rollback uses the same stopped-writer procedure and an atomic symlink switch
   to a verified retained snapshot, never database-file replacement in place.

Validation status: offline Node/provider tests, Python grammar checks and
Kustomize rendering are covered. ACR remote build **dtt** succeeded on
2026-09-25 in **35 seconds**, publishing
`acrmiracaldova.azurecr.io/overpass-austin:regional-20260925-1628` at
`sha256:8e3107dfc0ba9a62f793833f6873a753ff512edc019f843e89c2a97c03ec64ee`
(recorded in Kustomize). Its mandatory build-time smoke test imported synthetic
OSM data **as UID 1000**, queried a real way plus two geometry points through
`osm3s_query`, and verified preservation of the OSM source timestamp. No Texas
download was included in the image. The first ACR attempt used a caller-relative
`--file Dockerfile` and selected the app Dockerfile; the corrected command above
uses the explicit `infra/overpass/Dockerfile` path with the small regional context.
**Full Texas crop/import on AKS, admission, actual resource use and live
data/cache-rollout checks remain required before declaring deployment ready**.
