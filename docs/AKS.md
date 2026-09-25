# God's Eye View on AKS with Private Access

This guide deploys God's Eye View to Azure Kubernetes Service (AKS). The application
uses a `ClusterIP` service and is accessed through `kubectl port-forward`, without
an application ingress, public load balancer, or public hostname.

You can create a cluster and Azure Container Registry (ACR), or use existing
resources. Resource names, image digests, and cluster credentials stay in your
local configuration rather than in the shared manifests.

## Architecture Overview

| Component                  | Purpose                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| Production application     | Node.js serves the built browser application and same-origin provider APIs.                               |
| Kubernetes Secret          | Holds provider API keys at runtime, never at image build time.                                            |
| ConfigMap                  | Holds non-sensitive application and provider settings.                                                    |
| Persistent cache           | Retains provider responses when the application pod is replaced.                                          |
| Optional regional Overpass | Provides a bounded, roads-only OpenStreetMap snapshot. The included example covers Austin, not the world. |
| AKS kubelet identity       | Pulls images from ACR using `AcrPull`, without a registry password.                                       |

The [GitHub Actions pipeline](ACR-CI.md) can build and publish images separately.
It does not deploy to AKS or receive cluster credentials.

## Prerequisites

- An Azure subscription with quota for the selected region and VM size.
- Azure CLI, `kubectl`, Git, Python 3.9 or later, and Bash.
- Permission to create resources and assign roles for a new cluster, or
  appropriate access to an existing cluster and registry.
- An amd64 Linux node pool and the Azure Disk CSI `managed-csi` storage class.
- A checkout containing the Dockerfiles and manifests in this repository.

Run commands from the repository root. These examples target Azure public cloud
and an ACR using **RBAC Registry Permissions**, not ABAC repository permissions.
No Istio, ingress controller, or Helm installation is needed.

> Creating a cluster incurs charges for nodes, storage, and associated Azure
> resources. The configuration below is a starting point for a small deployment,
> not an availability or cost guarantee.

## Configuration

Set these values before running the commands. Replace values in angle brackets;
the other names are application defaults that you can change.

```bash
set -euo pipefail
export AZURE_SUBSCRIPTION_ID="<subscription-id>"
export LOCATION="eastus2"
export RESOURCE_GROUP="rg-gods-eye-view"
export CLUSTER_NAME="aks-gods-eye-view"
export ACR_NAME="<globally-unique-registry-name>"
export NAMESPACE="gods-eye-view"
export NODE_VM_SIZE="Standard_D4s_v5"
export ADMIN_IP_CIDR="<your-workstation-public-ip>/32"
export USE_AUSTIN_EXAMPLE="false"
export AKS_OVERLAY_DIR=".azure/aks"
```

| Variable                            | Purpose                                                            |
| ----------------------------------- | ------------------------------------------------------------------ |
| `AZURE_SUBSCRIPTION_ID`, `LOCATION` | Subscription and supported Azure region.                           |
| `RESOURCE_GROUP`                    | Resource group used by this walkthrough.                           |
| `CLUSTER_NAME`                      | New or existing AKS cluster.                                       |
| `ACR_NAME`                          | Registry name: globally unique, 5–50 lowercase letters and digits. |
| `NAMESPACE`                         | Dedicated application namespace, not a shared workload namespace.  |
| `NODE_VM_SIZE`                      | Available amd64 VM size with adequate CPU and memory.              |
| `ADMIN_IP_CIDR`                     | Public egress IP allowed to reach a newly created AKS API server.  |
| `USE_AUSTIN_EXAMPLE`                | Explicitly opt into the additional Austin database and workload.   |
| `AKS_OVERLAY_DIR`                   | Untracked deployment configuration beneath `.azure/`.              |

## Create the Registry and AKS Cluster

Skip this section when using existing resources. Do not run these commands merely
to adapt a shared cluster to the example.

1. Authenticate and select the subscription:

   ```bash
   az login
   az account set --subscription "$AZURE_SUBSCRIPTION_ID"
   az account show --query '{name:name,id:id}' --output table
   ```

2. Create the resource group and registry:

   ```bash
   az group create --name "$RESOURCE_GROUP" --location "$LOCATION"
   az acr create \
     --resource-group "$RESOURCE_GROUP" \
     --name "$ACR_NAME" \
     --sku Basic \
     --role-assignment-mode rbac \
     --admin-enabled false

   ACR_ID="$(az acr show --name "$ACR_NAME" --query id --output tsv)"
   ```

3. Create a two-node cluster with managed identity and Azure CNI Overlay powered
   by Cilium. Cilium enforces the included NetworkPolicies:

   ```bash
   az aks create \
     --resource-group "$RESOURCE_GROUP" \
     --name "$CLUSTER_NAME" \
     --location "$LOCATION" \
     --node-count 2 \
     --node-vm-size "$NODE_VM_SIZE" \
     --enable-managed-identity \
     --network-plugin azure \
     --network-plugin-mode overlay \
     --network-dataplane cilium \
     --api-server-authorized-ip-ranges "$ADMIN_IP_CIDR" \
     --attach-acr "$ACR_ID" \
     --generate-ssh-keys
   ```

   `--attach-acr` grants the kubelet identity registry-scoped `AcrPull`. It
   requires role-assignment permission. ABAC-enabled registries need the
   appropriate repository-reader role instead; do not change an existing
   registry's permission mode to work around an authorization error.

   The application remains private. The AKS API server is a separate endpoint:
   this example restricts its public access to your specified IP. Use a private
   AKS cluster when your workstation has the required private network and DNS
   access. AKS can also create public outbound networking resources; those are
   not application ingress.

## Connect to a New or Existing Cluster

For existing resources, set the configuration variables to their actual values
and confirm the kubelet already has permission to pull from your registry.
Do not change another workload's networking or identity settings.

```bash
az account set --subscription "$AZURE_SUBSCRIPTION_ID"
mkdir -p .azure
export KUBECONFIG="${PWD}/.azure/cluster.config"
az aks get-credentials \
  --resource-group "$RESOURCE_GROUP" \
  --name "$CLUSTER_NAME" \
  --file "$KUBECONFIG" \
  --overwrite-existing
export KUBE_CONTEXT="$CLUSTER_NAME"
ACR_LOGIN_SERVER="$(
  az acr show --name "$ACR_NAME" --query loginServer --output tsv
)"
export ACR_LOGIN_SERVER

kubectl --context "$KUBE_CONTEXT" get nodes
kubectl --context "$KUBE_CONTEXT" get storageclass managed-csi
```

If you already use another kubeconfig or a renamed context, retain that
`KUBECONFIG` and set `KUBE_CONTEXT` accordingly instead of downloading credentials.
`.azure/` is Git-ignored. Never commit or share its kubeconfig or local settings.

## Build the Container Images

The recommended repeatable path is [Publish Images to ACR with GitHub Actions](ACR-CI.md).
Use the application digest from its publication receipt as `APP_IMAGE_DIGEST`.
If using the Austin example, also set `REGIONAL_IMAGE_DIGEST` from that receipt.

Alternatively, build remotely in ACR without a local Docker daemon:

```bash
TAG="local-$(git rev-parse --short=12 HEAD)-$(date -u +%Y%m%dT%H%M%SZ)"
az acr build \
  --registry "$ACR_NAME" --platform linux/amd64 \
  --file Dockerfile --image "gods-eye-view:${TAG}" .
APP_IMAGE_DIGEST="$(
  az acr repository show --name "$ACR_NAME" \
    --image "gods-eye-view:${TAG}" --query digest --output tsv
)"
export APP_IMAGE_DIGEST

if [ "$USE_AUSTIN_EXAMPLE" = "true" ]; then
  az acr build \
    --registry "$ACR_NAME" --platform linux/amd64 \
    --file infra/overpass/Dockerfile \
    --image "overpass-austin:${TAG}" infra/overpass
  REGIONAL_IMAGE_DIGEST="$(
    az acr repository show --name "$ACR_NAME" \
      --image "overpass-austin:${TAG}" --query digest --output tsv
  )"
  export REGIONAL_IMAGE_DIGEST
fi
```

Build from a reviewed checkout. Keep credential files outside it: Docker uses
`.dockerignore`, not `.gitignore`, to filter uploads. Never pass provider keys as
build arguments. Both images are credential-free; the regional image does not
contain a downloaded OSM database.

## Create Your Local Deployment Configuration

The base at `infra/aks` deploys only the application and its cache. The alternative
base at `infra/aks/regional` also deploys the Austin example. Neither contains an
operator's registry or a published deployment digest.

The following creates an untracked Kustomize overlay using your selected namespace
and verified image digests. JSON is valid YAML and is accepted by Kustomize.

```python
import json
import os
from pathlib import Path
import re

env = os.environ
regional = env["USE_AUSTIN_EXAMPLE"]
if regional not in ("true", "false"):
    raise SystemExit("USE_AUSTIN_EXAMPLE must be true or false")
directory = Path(env["AKS_OVERLAY_DIR"])
if not directory.resolve().is_relative_to(Path(".azure").resolve()):
    raise SystemExit("Keep local configuration beneath .azure/")
namespace = env["NAMESPACE"]
if len(namespace) > 63 or not re.fullmatch(r"[a-z0-9](?:[-a-z0-9]*[a-z0-9])?", namespace):
    raise SystemExit("Invalid Kubernetes namespace")
images = []
for name, variable in [
    ("gods-eye-view", "APP_IMAGE_DIGEST"),
] + ([("overpass-austin", "REGIONAL_IMAGE_DIGEST")] if regional == "true" else []):
    digest = env[variable]
    if not re.fullmatch(r"sha256:[a-f0-9]{64}", digest):
        raise SystemExit(f"{variable} must be a verified digest")
    images.append({"name": name, "newName": f"{env['ACR_LOGIN_SERVER']}/{name}", "digest": digest})
base = Path("infra/aks/regional" if regional == "true" else "infra/aks")
overlay = {
    "apiVersion": "kustomize.config.k8s.io/v1beta1",
    "kind": "Kustomization",
    "namespace": namespace,
    "resources": [os.path.relpath(base.resolve(), directory.resolve())],
    "images": images,
}
directory.mkdir(parents=True, exist_ok=True)
(directory / "kustomization.yaml").write_text(json.dumps(overlay, indent=2) + "\n")
print(f"Created {directory / 'kustomization.yaml'}")
```

Run that block with Python 3, or save it locally and execute it. It writes only
deployment configuration, not credentials. Regenerating it replaces the overlay;
preserve any custom patches you have added.

Review `infra/aks/base/configmap.yaml`. Put overrides in a ConfigMap patch in your
local overlay, not in the shared base. For example, to select an operator-managed
**full-planet** Overpass endpoint, add this Kustomize patch:

```yaml
patches:
  - target:
      kind: ConfigMap
      name: gods-eye-view-config
    patch: |-
      apiVersion: v1
      kind: ConfigMap
      metadata:
        name: gods-eye-view-config
      data:
        OVERPASS_UPSTREAMS_JSON: '["https://overpass.example.org/api/interpreter"]'
```

Replace the example URL with a real, authorized endpoint. Regional extracts must
not be placed in the full-planet list.

## Deploy the Application

Do not apply the shared base directly: its image tags intentionally say
`PLACEHOLDER`. Render and validate your overlay first.

```bash
kubectl --context "$KUBE_CONTEXT" kustomize "$AKS_OVERLAY_DIR"
```

For a new namespace, create it before server-side validation of namespaced
resources. This is a metadata-only operation and does not touch Secrets:

```bash
kubectl --context "$KUBE_CONTEXT" create namespace "$NAMESPACE" \
  --dry-run=client -o yaml |
  kubectl --context "$KUBE_CONTEXT" apply -f -
kubectl --context "$KUBE_CONTEXT" apply --dry-run=server -k "$AKS_OVERLAY_DIR"
kubectl --context "$KUBE_CONTEXT" apply -k "$AKS_OVERLAY_DIR"
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" \
  rollout status deployment/gods-eye-view --timeout=300s
```

The app supports keyless startup. The manifests never create or replace an empty
Secret over existing credentials. Single-replica `Recreate` updates introduce
brief downtime and can disconnect an existing port-forward.

If you selected the Austin example, wait separately for its initial import:

```bash
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" \
  logs deployment/overpass-austin -c import --follow
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" \
  rollout status deployment/overpass-austin --timeout=7200s
```

## Add Provider API Keys

| Secret key                   | Feature                                                             |
| ---------------------------- | ------------------------------------------------------------------- |
| `CESIUM_ION_TOKEN`           | Cesium terrain and imagery assets, including supported Bing assets. |
| `GOOGLE_MAPS_API_KEY`        | Browser map and 3D tile features.                                   |
| `GOOGLE_MAPS_SERVER_API_KEY` | Server-side Google Places and Street View.                          |
| `OPENAI_API_KEY`             | Voice and HUD summaries.                                            |
| `AISSTREAM_API_KEY`          | Live vessel feed.                                                   |
| `FIRMS_MAP_KEY`              | NASA FIRMS fire observations.                                       |
| `TOMTOM_API_KEY`             | Live traffic flow, separate from OSM road geometry.                 |

See `.env.example` for additional provider credentials. Non-secret settings
belong in `gods-eye-view-config`, not in the Secret.

Create the Secret **only if it does not already exist**:

```bash
EXISTING_SECRET="$(
  kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" \
    get secret gods-eye-view-secrets --ignore-not-found -o name
)"
if [ -z "$EXISTING_SECRET" ]; then
  kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" \
    create secret generic gods-eye-view-secrets
fi
```

For example, set `PROVIDER_KEY=CESIUM_ION_TOKEN` and run the following in an
interactive terminal. It prompts without echo, sends the value through stdin,
and merges only that key, preserving the other credentials:

```bash
export PROVIDER_KEY="CESIUM_ION_TOKEN"
python3 - <<'PY'
import getpass, json, os, subprocess, warnings
warnings.simplefilter("error", getpass.GetPassWarning)
name = os.environ["PROVIDER_KEY"]
allowed = {
    "CESIUM_ION_TOKEN", "GOOGLE_MAPS_API_KEY", "GOOGLE_MAPS_SERVER_API_KEY",
    "OPENAI_API_KEY", "AISSTREAM_API_KEY", "FIRMS_MAP_KEY", "TOMTOM_API_KEY",
    "OPENSKY_CLIENT_ID", "OPENSKY_CLIENT_SECRET", "OPENSKY_USERNAME",
    "OPENSKY_PASSWORD", "LL2_API_TOKEN", "TFL_APP_KEY",
}
if name not in allowed:
    raise SystemExit("Choose a supported credential name")
value = getpass.getpass(f"{name} (hidden): ").strip()
if not value:
    raise SystemExit("Empty value; nothing changed")
result = subprocess.run([
    "kubectl", "--context", os.environ["KUBE_CONTEXT"],
    "-n", os.environ["NAMESPACE"], "patch", "secret", "gods-eye-view-secrets",
    "--type=merge", "--patch-file=/dev/stdin",
], input=json.dumps({"stringData": {name: value}}), text=True, capture_output=True)
if result.returncode:
    raise SystemExit("Secret update failed; credential-bearing output suppressed")
print(f"Updated {name}; other credentials preserved")
PY

kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" \
  rollout restart deployment/gods-eye-view
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" \
  rollout status deployment/gods-eye-view --timeout=300s
```

Never put values in Git, command arguments, screenshots, or chat. Kubernetes
Secret base64 encoding is not encryption; protect namespace RBAC and use your
organization's encryption and secret-management controls.

Cesium and the **browser** Google key necessarily reach the browser through
`/api/runtime-config.js`. Restrict their scopes and allowed origins. Server-only
keys, including AISStream, FIRMS, and TomTom, are not returned in that script.

## Access and Verify the Deployment

Keep this command running in a dedicated terminal:

```bash
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" \
  port-forward --address 127.0.0.1 service/gods-eye-view 4173:80
```

Open **http://127.0.0.1:4173**. In another terminal:

```bash
curl --fail http://127.0.0.1:4173/healthz
curl --fail http://127.0.0.1:4173/readyz
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" get pods,pvc
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" get services,ingress
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" top pods
```

Expected results: ready pods, bound PVCs, `ClusterIP` services, and no application
Ingress. The health endpoints verify the process, not every external provider.
Restart the port-forward after pod replacements.

## Regional Roads and Traffic Coverage

Street Traffic combines **OSM road geometry** with optional **TomTom traffic
flow**. A working TomTom key cannot replace missing OSM roads. TomTom supports
Canada, including traffic data around Calgary, but road requests can still fail
when public Overpass mirrors refuse or time out.

The optional Austin example covers latitude **29.9–30.7** and longitude
**-98.2–-97.2**. It downloads a public Geofabrik Texas extract, crops complete
ways, imports highway ways and their referenced nodes, and verifies downtown
roads before activating an immutable snapshot. It does **not** cover Calgary.
For another region, use an appropriate road source; changing only the
ConfigMap bounds does not expand the database. The current example's importer
and startup checks are Austin-specific and must be adapted together.

Only fully contained, supported highway-bbox queries use the regional service.
Outside, boundary, admin, and unfamiliar queries stay on global sources.
Regional failures fall back to global mirrors; no regional empty response is
presented as authoritative data for another city.

The database PVC is 64Gi; the application cache PVC is 8Gi (Azure may bill a
larger minimum disk tier). The regional init and server each request 1 CPU /
2Gi and limit 2 CPU / 6Gi; they run sequentially. Import duration depends on
download speed and disk performance. `/healthz` on the regional service reports
the source OSM timestamp and snapshot metadata, not a claim of real-time updates.

Refresh is a **manual snapshot import**, not planet replication. Keep old snapshots
for rollback. Review `infra/aks/overpass-refresh.yaml`, substitute your verified
regional image digest, and create a refresh Job only after scaling the regional
Deployment to zero and waiting for its pod to terminate. Restore one replica
afterward, even if the refresh fails. Never remove the PVC or current snapshot
as a troubleshooting shortcut.

## Troubleshooting

| Symptom                    | Check                                                                                                                                                                                                                                  |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ImagePullBackOff`         | Digest exists, registry is reachable, and kubelet has the correct pull role. Allow RBAC propagation; do not enable registry passwords as a shortcut.                                                                                   |
| `Pending` PVC              | `managed-csi`, node capacity, disk quota, and attachment events. `WaitForFirstConsumer` is normal until a pod is scheduled.                                                                                                            |
| Street Traffic unavailable | Inspect the road source separately from TomTom. Three attempts are allowed per destination; failures stay visible during retry. A request/body deadline is 95 seconds. Move to a new area or toggle the layer after fixing the source. |
| Regional init failed       | Inspect import logs and the named staging directory. An unfinished-import marker prevents repeated downloads from filling the disk. Diagnose before removing only that marker.                                                         |
| Data disappears on restart | Check the app cache PVC mount. A repeated road query on a replacement pod should report `x-overpass-cache: DISK`, not depend on its old memory cache.                                                                                  |
| No network isolation       | Check the existing cluster's policy engine. A NetworkPolicy object alone does not mean it is enforced. Do not modify a shared cluster's CNI without a separate plan.                                                                   |

## Security and Production Considerations

| Area               | Recommendation                                                                                                                                           |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Access             | Keep the service private and port-forward bound to loopback. Restrict AKS API access and use appropriate Entra/RBAC controls.                            |
| Credentials        | Keep provider keys in Secrets and CI identity IDs in Actions variables. No provider keys belong in image builds.                                         |
| Containers         | Non-root UID/GID 1000, read-only root, dropped capabilities, restricted pod security, no service-account token.                                          |
| Network policy     | The app denies ordinary incoming pod traffic. Cilium enforces it on the new-cluster path; existing clusters must be checked.                             |
| Availability       | One app replica with `Recreate` is not HA. Back up persistent data and plan downtime for updates.                                                        |
| Resources          | App requests 250m CPU / 512Mi, limits 2 CPU / 2Gi. Adjust from measurements, not browser rendering load.                                                 |
| Freshness and cost | Cached responses can be stale. Check source timestamps, refresh regional snapshots, set provider-side quotas, and monitor storage/image retention costs. |

## Cleanup

Delete the namespace **only if it is dedicated to this deployment**. This removes
Secrets, workloads, and PVCs; backing disks may be deleted by the reclaim policy.

```bash
kubectl --context "$KUBE_CONTEXT" delete namespace "$NAMESPACE"
```

Delete the cluster or registry only if you created them exclusively for this
exercise and have reviewed the impact:

```bash
az aks delete --resource-group "$RESOURCE_GROUP" --name "$CLUSTER_NAME"
az acr delete --resource-group "$RESOURCE_GROUP" --name "$ACR_NAME"
```

## References

- [Azure CNI powered by Cilium](https://learn.microsoft.com/azure/aks/azure-cni-powered-by-cilium)
- [Integrate AKS with ACR](https://learn.microsoft.com/azure/aks/cluster-container-registry-integration)
- [AKS API server authorized IP ranges](https://learn.microsoft.com/azure/aks/api-server-authorized-ip-ranges)
- [TomTom traffic market coverage](https://docs.tomtom.com/traffic-api/documentation/tomtom-maps/v1/product-information/market-coverage)
- [Publishing images with GitHub Actions](ACR-CI.md)
