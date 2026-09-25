# Latest upstream → tested image → ACR

The downstream workflow [acr-image.yml](../.github/workflows/acr-image.yml)
publishes **only** these two repositories:

- `acrmiracaldova.azurecr.io/gods-eye-view` — production application.
- `acrmiracaldova.azurecr.io/overpass-austin` — regional roads backend,
  built from the dedicated `infra/overpass` context.

It runs on every
downstream `main` push, manually, and daily at 07:23 UTC. GitHub schedules are
best-effort and can be delayed; fork schedules must be explicitly enabled.
It does **not** deploy to AKS or need any cluster permissions.

## Source and credential boundaries

1. Check out the exact downstream commit for this run, including its Dockerfile,
   production server, and downstream fixes.
2. Fetch `main` from the fixed canonical URL
   `https://github.com/bilawalsidhu/gods-eye-view.git` and perform a normal Git
   merge into the downstream working tree. The latest source means the upstream
   SHA observed at fetch time. Nothing is pushed to either source repository.
3. Conflicts deliberately **fail** the run, rather than overwriting downstream
   fixes. Resolve the canonical upstream merge in a reviewed downstream change
   and merge it to `main`, then rerun. Do not resolve by blindly taking upstream.
4. Install locked dependencies, run production-server, CI, regional Overpass,
   proxy, and traffic/navigation regression tests, and build both Linux amd64
   containers. The application Dockerfile performs the production build. Docker
   secret exclusions must remain present in `.dockerignore`. The Overpass image
   uses its dedicated context allowlist, with no provider credentials or regional
   OSM database built into the image; database import is a separate runtime task.
   Its Dockerfile self-test imports synthetic XML and checks an actual road query
   and source timestamp as UID 1000, then removes the test database.
   Both images are rebuilt on every run, including changes under `infra/overpass`,
   so they share one tested source snapshot.
5. Transfer the images as a same-run artifact to a fresh publisher runner.
   Only the publisher has OIDC permission; it checks out the original downstream
   commit for its publication scripts, not the merged upstream scripts. It
   loads the images as data and never runs them, npm, or upstream build scripts.
6. Validate repository, branch, event, Azure variable UUIDs, registry, image,
   source labels and unique tag before publication. Acquire short-lived Azure
   credentials, push both images, and lock their unique tags against writes and
   deletion.

This intentionally trusts canonical upstream application/dependency code as a
software supply-chain input. It does not prove that new upstream code is benign.
Review upstream changes and restrict/protect downstream `main` and workflow
changes. Build runners never receive Azure credentials or OIDC permission.
No provider API keys, dotenv values, or Kubernetes credentials belong in this
workflow's secrets, variables, build arguments, artifacts, or image. Provider
configuration is supplied only at runtime, as documented in [AKS.md](AKS.md).
The publisher has only `contents: read` and `id-token: write`; all other jobs have
no write permissions. There are no PR publication triggers.

## One-time Azure and GitHub setup

An Azure administrator provisions the dedicated user-assigned managed identity
`id-gev-github-caldova` using [identity.bicep](../infra/ci/identity.bicep).
The template creates only the identity, its GitHub federated identity credential,
and registry-scoped `AcrPush` assignment; it does not deploy the application or
grant cluster rights. The provisioning operator needs permission to create the
identity/federation and assign a role at the registry. These provisioning rights
are not granted to the workflow identity.

The credential has these exact settings:

| Field    | Required value                                   |
| -------- | ------------------------------------------------ |
| Issuer   | `https://token.actions.githubusercontent.com`    |
| Audience | `api://AzureADTokenExchange`                     |
| Subject  | `repo:dcasati/gods-eye-view:ref:refs/heads/main` |

Use this exact subject, not a wildcard and not an upstream or PR subject. No
client secret or registry admin password is needed. Keep the ACR admin account
disabled. The workflow does not use an environment subject.

The template assigns **AcrPush** at this existing registry's resource scope
only (not resource group or subscription scope). After reviewing deployment
validation and what-if output, an administrator signed in to the intended
subscription runs:

```bash
az deployment group create \
  --resource-group rg-mira-caldova \
  --template-file infra/ci/identity.bicep \
  --name gev-github-identity
```

The registry must use the RBAC registry permission mode that supports `AcrPush`.
If it uses RBAC + ABAC repository permissions, stop and arrange the appropriate
repository-scoped writer role with the administrator; do not grant broad
subscription permissions to work around authentication failures. The workflow
also requires registry network access from GitHub-hosted runners.

Configure three **repository Actions variables**, not provider secrets, directly
from the deployment outputs `clientId`, `tenantId`, and `subscriptionId`:

```bash
gh variable set AZURE_CLIENT_ID --repo dcasati/gods-eye-view --body "$(
  az deployment group show --resource-group rg-mira-caldova \
    --name gev-github-identity --query properties.outputs.clientId.value --output tsv
)"
gh variable set AZURE_TENANT_ID --repo dcasati/gods-eye-view --body "$(
  az deployment group show --resource-group rg-mira-caldova \
    --name gev-github-identity --query properties.outputs.tenantId.value --output tsv
)"
gh variable set AZURE_SUBSCRIPTION_ID --repo dcasati/gods-eye-view --body "$(
  az deployment group show --resource-group rg-mira-caldova \
    --name gev-github-identity --query properties.outputs.subscriptionId.value --output tsv
)"
```

After the workflow and downstream container changes are committed on fork `main`,
enable Actions in the fork if GitHub has disabled them, then:

```bash
gh workflow enable acr-image.yml --repo dcasati/gods-eye-view
gh workflow run acr-image.yml --repo dcasati/gods-eye-view --ref main
gh run list --repo dcasati/gods-eye-view --workflow acr-image.yml --limit 5
gh run watch '<run-id>' --repo dcasati/gods-eye-view --exit-status
gh run download '<run-id>' --repo dcasati/gods-eye-view \
  --name 'publication-<run-id>-<attempt>' --dir ./publication-receipt
```

Enable only `acr-image.yml`; do not bulk-enable unrelated inherited workflows.
New workflow files may not appear in the fork's Actions API until the commit is
present on its default branch, `main`.

Official action commits are pinned. Updating them requires verifying the commit
against each official action repository, not merely accepting a mutable tag.
Repository permissions should restrict who can change Actions variables and
merge workflow or publication-script changes.

## Image identity and failures

Version tags use `run-<run-id>-<attempt>-<downstream-short-sha>-<upstream-short-sha>`.
Each retry gets a new tag. A successful run locks its tag; no mutable `latest`
tag is published. The labels `org.opencontainers.image.revision` and
`io.gods-eye-view.upstream.revision` record the full downstream and upstream SHAs.
Workflow concurrency prevents overlapping publication runs (GitHub can replace
older pending runs with newer ones).

The Actions summary and the 90-day `publication-<run-id>-<attempt>` artifact record
both SHAs, the immutable digest, the image tag, and a digest pull reference.
The artifact contains `publication.json` for the application and
`publication-overpass.json` for the regional backend. Both use the same unique
tag but have independent digests. Use each digest for a separately authorized
deployment. Image transfer artifacts expire after one day; the images stay in
ACR. Publication is not atomic across repositories: if one push succeeds but the
second push, tag locking, or receipt creation fails, the workflow fails even
though an image may exist:
inspect that run's unique tag before using it. Fix the permission/transient error
and rerun; never assume a failed run published a verified release.

Local script checks (fixtures stay under the project and are removed):

```bash
bash -n scripts/ci/*.sh
node --test src/tooling/acr*.test.mjs
```
