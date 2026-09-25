# Entra-Protected Public Access on AKS

This optional profile adds **oauth2-proxy, not Istio**, in front of the existing
[private AKS deployment](AKS.md). The application, regional road services, provider
Secrets and CI publisher are unchanged. Public access is an explicit, gated step,
not a consequence of applying the profile.

## Architecture

```text
Browser -- HTTPS:443 --> Azure Load Balancer (L4)
                              |
                    oauth2-proxy (TLS + Entra session)
                              |
                    gods-eye-view ClusterIP:80
                              |
                    private Austin/Calgary services

oauth2-proxy -- authorization code + PKCE S256 --> tenant-specific Entra issuer
             -- projected AKS token -----------> federated client authentication
```

The proxy uses `entra-id` in oauth2-proxy **v7.15.2**. The federated identity
credential authenticates the application during code redemption: there is no
Entra client password. Cookie encryption and the TLS private key still belong in
separate Kubernetes Secrets. Tenant/client IDs, issuer, callback and upstream are
nonsecret ConfigMap data.

This is a **direct reverse proxy**: the upstream is the real application
ClusterIP, never `static://200`. The latter belongs to external-authorization
designs such as the [reference article](https://azureglobalblackbelts.com/2026/07/29/secretless-entra-authentication-on-aks/).
See the official [Entra provider](https://oauth2-proxy.github.io/oauth2-proxy/configuration/providers/ms_entra_id/)
and [configuration](https://oauth2-proxy.github.io/oauth2-proxy/configuration/overview/) documentation.

## Prerequisites

- The existing private application is healthy, with immutable image pins.
- Azure CLI, kubectl, Python 3, Node 24, OpenSSL and permission to create a
  dedicated Entra app/service principal/federated credential.
- AKS OIDC issuer and Workload Identity already enabled. Verify these first;
  enabling them on a shared cluster is a separate, reviewed change.
- A trusted certificate for an exact HTTPS hostname, or permission to reserve a
  dedicated Standard static public IP and obtain a certificate for its Azure DNS
  label. IP allocation incurs charges but does not itself route application traffic.
- The AKS control-plane identity can manage the IP. Placing it in the existing
  node resource group normally avoids additional role assignments. Do not grant
  permissions to the OAuth login app or reuse the CI publisher identity.
- A real tenant user for final interactive sign-in. A 302 redirect proves neither
  successful code redemption nor successful authenticated application behavior.

## Configuration

All deployed names and IDs, image digests and operational evidence stay in
ignored `.azure/` files, never these shared manifests. These scripts expect a
dedicated application namespace; existing Ingress/Gateway routes cause activation
to stop for review.

| Setting | Purpose |
| --- | --- |
| `context`, `subscription`, `resourceGroup`, `cluster` | Explicit existing deployment target; checked against live Azure/Kubernetes metadata |
| `namespace` | Namespace containing the private app and independent proxy |
| `tenantId`, `clientId` | Dedicated single-tenant app; never `common` or `organizations` |
| `origin` | Exact `https://hostname`, standard port 443, no trailing slash |
| `image` | Official `quay.io/oauth2-proxy/oauth2-proxy:v7.15.2@sha256:<verified-digest>` |
| `assignmentRequired` | `true`: explicitly assigned users/groups only; `false`: directory users including invited guests, subject to tenant consent/Conditional Access |
| `publicIPName`, `publicIPResourceGroup` | Dedicated Standard static IP with an Azure-assigned DNS hostname, used by the activation script |

The default profile requests only `openid`, uses the immutable `sub` claim as its
identity identifier, and needs no Graph permissions or email-suffix trust.
`email_domains = ["*"]` is **not** multi-tenant authorization: the exact issuer and
allowed tenant still gate tokens. Do not enable group-overage Graph access unless
you deliberately adopt a group-based authorization policy.

## 1. Reserve the Address and Establish the Callback

Skip IP creation if you already have an appropriate dedicated static IP. Confirm
quota, DNS-label availability and existing resource ownership first. Never reuse
the cluster outbound IP.

```bash
export KUBE_CONTEXT="<existing-context>"
export AZURE_SUBSCRIPTION_ID="<subscription-id>"
export RESOURCE_GROUP="<cluster-resource-group>"
export CLUSTER_NAME="<cluster-name>"
export NAMESPACE="gods-eye-view"
export LOCATION="<cluster-region>"
export IP_RESOURCE_GROUP="<aks-node-resource-group>"
export PUBLIC_IP_NAME="<dedicated-ip-name>"
export DNS_LABEL="<available-azure-dns-label>"

az account set --subscription "$AZURE_SUBSCRIPTION_ID"
az account show --query '{subscription:id,tenant:tenantId}' -o json
az aks show -g "$RESOURCE_GROUP" -n "$CLUSTER_NAME" \
  --query '{oidc:oidcIssuerProfile,workloadIdentity:securityProfile.workloadIdentity}' -o json
az deployment group what-if -g "$IP_RESOURCE_GROUP" \
  --template-file infra/aks/auth/public-ip.bicep \
  --parameters location="$LOCATION" publicIPName="$PUBLIC_IP_NAME" dnsLabel="$DNS_LABEL"
# After reviewing the preview: one IP only, no changes to existing resources.
az deployment group create -g "$IP_RESOURCE_GROUP" \
  --template-file infra/aks/auth/public-ip.bicep \
  --parameters location="$LOCATION" publicIPName="$PUBLIC_IP_NAME" dnsLabel="$DNS_LABEL"
export HOSTNAME="$(az network public-ip show -g "$IP_RESOURCE_GROUP" \
  -n "$PUBLIC_IP_NAME" --query dnsSettings.fqdn -o tsv)"
export ORIGIN="https://$HOSTNAME"
export TENANT_ID="$(az account show --query tenantId -o tsv)"
export AKS_ISSUER="$(az aks show -g "$RESOURCE_GROUP" -n "$CLUSTER_NAME" \
  --query oidcIssuerProfile.issuerUrl -o tsv)"
```

An owned custom hostname/certificate is also suitable for the manifests. The
automated activation command intentionally verifies the IP's Azure DNS hostname;
custom DNS requires adapting that check to prove DNS ownership and resolution,
not bypassing TLS verification.

## 2. Register a Separate Secretless Entra Application

Create once; record the returned client ID privately. On resume, inspect the
existing app instead of creating duplicates or resetting credentials.

```bash
export CLIENT_ID="$(az ad app create --display-name gods-eye-view-oauth2-proxy \
  --sign-in-audience AzureADMyOrg \
  --web-redirect-uris "$ORIGIN/oauth2/callback" --query appId -o tsv)"
az ad sp create --id "$CLIENT_ID" --query '{id:id,appId:appId}' -o json
python3 - <<'PY' | az ad app federated-credential create \
  --id "$CLIENT_ID" --parameters @/dev/stdin
import json,os
print(json.dumps({
    "name": "gods-eye-view-auth",
    "issuer": os.environ["AKS_ISSUER"],
    "subject": "system:serviceaccount:" + os.environ["NAMESPACE"] + ":gods-eye-view-auth",
    "audiences": ["api://AzureADTokenExchange"]
}))
PY
```

Do not run `az ad app credential reset`, grant Azure roles, add Graph permissions,
enable implicit grants, or configure wildcard callbacks. If choosing assigned-only
access, set the enterprise application's **Assignment required** to Yes and assign
the intended users/groups before testing. Reflect that choice in
`assignmentRequired`; the gate checks it against live Entra metadata.

Create `.azure/auth/settings.json` using the configuration table (all fields
except the public IP fields are required for preparation). Verify the release's
registry digest through an authenticated/TLS-verified registry request; keep the
deployment-specific digest only in that ignored file. Then prepare:

```json
{
  "context": "<existing-context>",
  "subscription": "<subscription-id>",
  "resourceGroup": "<cluster-resource-group>",
  "cluster": "<cluster-name>",
  "namespace": "gods-eye-view",
  "tenantId": "<tenant-id>",
  "clientId": "<dedicated-auth-client-id>",
  "origin": "https://<reserved-dns-hostname>",
  "image": "quay.io/oauth2-proxy/oauth2-proxy:v7.15.2@sha256:<verified-digest>",
  "assignmentRequired": false,
  "publicIPName": "<dedicated-ip-name>",
  "publicIPResourceGroup": "<aks-node-resource-group>"
}
```

```bash
node scripts/aks-auth.mjs prepare .azure/auth/settings.json
kubectl --context "$KUBE_CONTEXT" apply --dry-run=server -k .azure/auth
```

The `infra/aks/auth` Kustomization contains **only auth resources**, not an
application base or regional overlay. Apply it independently of
`infra/aks/calgary`/`regional` to avoid overwriting provider routing or live image
pins. Both resulting Services are private by default.

## 3. Obtain Trusted TLS Without Exposing the App

If a matching certificate already exists, proceed to step 4. Otherwise, the
optional `infra/aks/auth-acme` responder supports
[HTTP-01](https://letsencrypt.org/docs/challenge-types/) for Azure-managed DNS.
It is **not an ingress controller**: it serves exactly one public challenge
token, rejects all other paths/methods, and has no upstream, provider settings,
application server, service-account token or private key.

The responder uses the existing pinned application image only for its Node
runtime, with an overridden command and explicit port. Its source is mounted
from a ConfigMap; application files are never served.

```bash
node scripts/aks-acme-prepare.mjs .azure/auth/settings.json .azure/auth-acme
kubectl --context "$KUBE_CONTEXT" apply --dry-run=server -k .azure/auth-acme
kubectl --context "$KUBE_CONTEXT" apply -k .azure/auth-acme
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" rollout status deployment/gods-eye-view-acme
# First verify through a private port-forward: / and /api/runtime-config.js -> 404.
# Only this token-only responder may receive temporary port-80 exposure.
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" patch svc gods-eye-view-acme \
  --type=merge -p '{"spec":{"type":"LoadBalancer","externalTrafficPolicy":"Local"}}'
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" get svc gods-eye-view-acme
curl --fail-with-body "http://$HOSTNAME/.well-known/acme-challenge/not-a-token"
# The deliberate invalid-token request must return 404, not application content.
```

Install Certbot in a private virtual environment or use an existing trusted
installation. Review the CA terms before registering an account; supply an
operator contact address, or explicitly opt out with
`--register-unsafely-without-email`. Keep account keys/logs under a permission-700
ignored directory. Do not paste private keys into the shell or chat.

```bash
export AKS_AUTH_SETTINGS="$PWD/.azure/auth/settings.json"
export ACME_CONTACT="<operator-email>"
certbot certonly --non-interactive --manual --preferred-challenges http \
  --manual-auth-hook "node $PWD/scripts/aks-acme-hook.mjs" \
  --manual-cleanup-hook "node $PWD/scripts/aks-acme-hook.mjs cleanup" \
  --agree-tos --email "$ACME_CONTACT" --test-cert --cert-name gev-auth-staging \
  -d "$HOSTNAME" --config-dir "$PWD/.azure/auth/acme-staging" \
  --work-dir "$PWD/.azure/auth/acme-staging-work" \
  --logs-dir "$PWD/.azure/auth/acme-staging-logs"
```

After staging succeeds, repeat **without `--test-cert`**, using `gev-auth` and
separate `acme`, `acme-work`, `acme-logs` directories. Never install a staging
certificate on the authentication edge. Public CA rate limits/CAA policies can
change for shared Azure DNS suffixes; if issuance fails, keep the app private and
use an owned domain or existing certificate instead.

Close the temporary route immediately after issuance (including on failure):

```bash
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" delete svc gods-eye-view-acme
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" scale deployment gods-eye-view-acme --replicas=0
```

Wait for Azure to detach the IP from that Service before activating the proxy.
The activation gate rejects an IP still attached to another route.

## 4. Deploy the Proxy Privately

Generate the cookie Secret **once**, through stdin. Neither it nor a TLS private
key belongs in shell arguments, source, build artifacts or a ConfigMap:

```bash
python3 - <<'PY' | kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" create -f -
import base64,json,secrets
print(json.dumps({
    "apiVersion":"v1", "kind":"Secret",
    "metadata":{"name":"gods-eye-view-auth-cookie"}, "type":"Opaque",
    "stringData":{"cookie-secret":base64.urlsafe_b64encode(secrets.token_bytes(32)).decode()}
}))
PY
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" create secret tls gods-eye-view-auth-tls \
  --cert=.azure/auth/acme/live/gev-auth/fullchain.pem \
  --key=.azure/auth/acme/live/gev-auth/privkey.pem
kubectl --context "$KUBE_CONTEXT" apply -k .azure/auth
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" rollout status deployment/gods-eye-view-auth
node scripts/aks-auth.mjs verify .azure/auth/settings.json
```

The gate checks the actual AKS context, Entra audience, exact callback, federation
issuer/subject/audience, absence of passwords/extra permissions, assignment policy,
Workload Identity projection, live ConfigMaps/deployment and readiness. It then
port-forwards only to loopback and verifies **publicly trusted** TLS with the real
hostname, tenant-specific redirects, PKCE S256, nonce, secure HttpOnly host-only
cookies, anonymous/forged cookie/header rejection, API/method/websocket rejection,
invalid callbacks and external post-login redirects. It never prints cookies or
tokens. App assets, runtime configuration and application probes require auth too.

`api_routes` means **authenticated APIs return 401 instead of an HTML redirect**;
it is not a skip-auth rule. `/oauth2/ping` and `/oauth2/ready` reveal only proxy
health and never forward to the app. Azure Load Balancer is L4, so
`reverse_proxy=false`: untrusted forwarded headers cannot choose the issuer or
callback. Access/ID tokens and basic-auth credentials are not injected upstream.

## 5. Activate, Then Verify Real Sign-In

```bash
node scripts/aks-auth.mjs activate .azure/auth/settings.json
node scripts/aks-auth.mjs verify-public .azure/auth/settings.json
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" get svc
```

Activation reruns private checks, confirms the dedicated IP/DNS, checks for
concurrent config changes and changes **only** `gods-eye-view-auth` to
`LoadBalancer`. It exposes port 443, not HTTP. Failed public negative checks
return the Service to ClusterIP. Reapplying the original auth overlay also
returns the Service to its private desired state; use this intentionally, not
as an unreviewed public update.

Open the HTTPS origin and complete Entra sign-in with the intended user. Confirm:

1. Successful code redemption, the application page/assets and
   `/api/runtime-config.js` load only after authentication.
2. Calgary/Austin roads and TomTom overlays still work; existing providers, voice
   token APIs and any applicable websocket behavior work in the authenticated
   session. Current AIS transport uses server-side websockets and browser HTTP
   APIs; do not invent a browser AIS websocket success criterion.
3. Sign-out/expired session denies API access; another browser without a cookie
   cannot load app content. Test an unallowed tenant/user without weakening policy.
4. No direct app/road `LoadBalancer`, `NodePort`, `externalIPs`, Ingress or Gateway
   route exists. Cluster-wide custom routing infrastructure needs its own audit.

**Do not label real sign-in verified from readiness or negative tests alone.**
The proxy is the public boundary; Kubernetes administrators and in-cluster
workloads may still reach the private application. NetworkPolicy only enforces
isolation when the existing cluster networking actually supports it. This profile
adds a same-namespace proxy-to-app allow rule compatible with the private base's
deny policy, but does not enable or replace shared networking.

## Renewal, Rollback and Cleanup

Certificates must be renewed before expiry. This profile does **not** silently
install a cluster-wide certificate controller or an unattended renewal job.
Schedule an operational renewal window well before expiry (for example 30 days).
For this manual workflow: roll back to private, recreate the token-only responder,
run Certbot renewal with the same hooks/settings/account, close the port-80
Service, update the TLS Secret via a stdin manifest and restart only the proxy.
Then rerun private verification and activation. This incurs a deliberate
authentication-edge maintenance window, not unauthenticated application access.

```bash
node scripts/aks-auth.mjs rollback .azure/auth/settings.json
# After issuing/renewing, update Secret without printing its contents:
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" create secret tls gods-eye-view-auth-tls \
  --cert=.azure/auth/acme/live/gev-auth/fullchain.pem \
  --key=.azure/auth/acme/live/gev-auth/privkey.pem --dry-run=client -o json |
  kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" apply --server-side -f -
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" rollout restart deployment/gods-eye-view-auth
```

Cookie-key rotation invalidates sessions; update only the cookie Secret through a
secure stdin workflow and restart proxy pods. Do not touch provider Secrets.
After rollback, confirm Azure has removed the former public listener; private
operator access remains available through the existing app port-forward.

For permanent cleanup, first roll back, then explicitly remove only the auth and
ACME resources, dedicated app registration/federation and dedicated IP. Verify
resource ownership before deletion. Never delete the application namespace,
regional PVCs, provider Secrets, shared cluster networking or CI identity.

## Local Regression Checks

```bash
node --test src/tooling/aksAuth.test.mjs src/tooling/deploymentDocs.test.mjs
```

The optional integration test needs `OAUTH2_PROXY_BIN` pointing to the official
checksum-verified v7.15.2 binary and `PROXY_TEST_TENANT` set to the selected tenant.
It runs on loopback with an explicitly trusted temporary test certificate, real
Entra discovery, a nonredeemable test token and an instrumented upstream. It
proves negative requests never reach that upstream; it does not simulate or
claim a real user's sign-in.
