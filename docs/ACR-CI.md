# Publish God's Eye View Images to ACR with GitHub Actions

This guide configures a fork of God's Eye View to build the latest upstream source,
retain the fork's deployment changes, and publish container images to Azure
Container Registry (ACR). GitHub authenticates to Azure through OpenID Connect
(OIDC), without an Azure client secret or registry password.

The workflow is reusable: repository authorization, registry settings, and Azure
identity IDs are Actions variables. It is **disabled until you explicitly select
the repository allowed to publish**.

## Architecture Overview

| Stage           | What happens                                                                                                      |
| --------------- | ----------------------------------------------------------------------------------------------------------------- |
| Source assembly | Check out the fork commit and merge current `bilawalsidhu/gods-eye-view` upstream `main`. Conflicts fail the run. |
| Build           | Run regression tests and build Linux amd64 application and regional-example images without Azure credentials.     |
| Transfer        | Upload tested image data as an artifact for a separate publisher runner.                                          |
| Publish         | Acquire a short-lived OIDC login, push both images, lock their version tags, and retain digest receipts.          |

The build job has only `contents: read`. The publisher has `contents: read` and
`id-token: write`; it never executes the transferred images or upstream build
scripts. Its scripts come from the original fork commit.

The workflow publishes `gods-eye-view` and `overpass-austin` repositories inside
your ACR. The latter is an **optional Austin-only example**, not a global road
service; building it does not download a regional database or deploy it.

## Prerequisites

- A fork containing `.github/workflows/acr-image.yml`, the Dockerfiles, and the
  production-server changes on `main`.
- GitHub CLI authenticated with permission to configure that fork's variables
  and workflows.
- Azure CLI with Bicep, authenticated to the intended subscription.
- An existing ACR using **RBAC Registry Permissions** and accessible from the
  chosen GitHub runner.
- Permission to create a managed identity and federated credential, and assign
  `AcrPush` at the registry.

For registry and cluster creation, see [God's Eye View on AKS](AKS.md).
This guide uses Azure public cloud. An ABAC-enabled registry needs a different,
appropriately scoped repository-writer role; the included Bicep uses `AcrPush`.
Do not change registry authorization modes or grant subscription-wide roles just
to bypass an access error.

## Configuration

Run commands from your checkout's root. Set your own values:

```bash
set -euo pipefail
export GITHUB_REPOSITORY="<owner>/<fork>"
export AZURE_SUBSCRIPTION_ID="<subscription-id>"
export RESOURCE_GROUP="<resource-group-containing-your-registry>"
export ACR_NAME="<registry-name>"
export IDENTITY_NAME="id-gods-eye-view-github"
export DEPLOYMENT_NAME="gods-eye-view-github-identity"

az account set --subscription "$AZURE_SUBSCRIPTION_ID"
GITHUB_REPOSITORY="$(gh repo view "$GITHUB_REPOSITORY" \
  --json nameWithOwner --jq .nameWithOwner)"
export GITHUB_REPOSITORY
ACR_LOGIN_SERVER="$(
  az acr show --name "$ACR_NAME" --query loginServer --output tsv
)"
export ACR_LOGIN_SERVER
mkdir -p .azure
```

The template deploys the identity into the registry's resource group. Identity
names and OIDC subjects are configurable; no operator-specific IDs are embedded.
Keep local parameters and verification records under the Git-ignored `.azure/`.

## Configure the GitHub OIDC Trust

1. Read the fork's OIDC configuration without requesting or printing a token:

   ```bash
   gh api "repos/${GITHUB_REPOSITORY}/actions/oidc/customization/sub" \
     > .azure/github-oidc.json
   ```

2. Derive the exact `main` subject from the default configuration:

   ```bash
   GITHUB_OIDC_SUBJECT="$(
     python3 - <<'PY'
   import json, os
   from pathlib import Path
   config = json.loads(Path(".azure/github-oidc.json").read_text())
   if config.get("use_default") is not True:
       raise SystemExit("Custom OIDC template: inspect its claims and supply the exact main subject")
   if config.get("use_immutable_subject"):
       prefix = config.get("sub_claim_prefix")
       if not prefix:
           raise SystemExit("Immutable subject prefix is missing; do not guess it")
   else:
       prefix = "repo:" + os.environ["GITHUB_REPOSITORY"]
   print(prefix + ":ref:refs/heads/main")
   PY
   )"
   export GITHUB_OIDC_SUBJECT
   ```

   An immutable subject contains repository and owner IDs. A legacy subject uses
   `repo:OWNER/REPOSITORY:ref:refs/heads/main`. They are **not interchangeable**.
   For a custom subject template, review its exact claims instead of running the
   default derivation. Never disable immutable subjects or add wildcard trust to
   make an incorrect credential match.

3. Review the [identity template](../infra/ci/identity.bicep). It creates a
   dedicated user-assigned managed identity, one GitHub federated credential,
   and one registry-scoped `AcrPush` assignment. Issuer and audience are:

   | Setting  | Value                                           |
   | -------- | ----------------------------------------------- |
   | Issuer   | `https://token.actions.githubusercontent.com`   |
   | Audience | `api://AzureADTokenExchange`                    |
   | Subject  | Your verified repository's exact `main` subject |

4. Validate and preview the change before provisioning:

   ```bash
   az deployment group validate \
     --resource-group "$RESOURCE_GROUP" \
     --template-file infra/ci/identity.bicep \
     --parameters identityName="$IDENTITY_NAME" registryName="$ACR_NAME" \
       githubOidcSubject="$GITHUB_OIDC_SUBJECT"

   az deployment group what-if \
     --resource-group "$RESOURCE_GROUP" \
     --template-file infra/ci/identity.bicep \
     --parameters identityName="$IDENTITY_NAME" registryName="$ACR_NAME" \
       githubOidcSubject="$GITHUB_OIDC_SUBJECT"
   ```

5. After reviewing the proposed scope, deploy:

   ```bash
   az deployment group create \
     --resource-group "$RESOURCE_GROUP" \
     --name "$DEPLOYMENT_NAME" \
     --template-file infra/ci/identity.bicep \
     --parameters identityName="$IDENTITY_NAME" registryName="$ACR_NAME" \
       githubOidcSubject="$GITHUB_OIDC_SUBJECT"
   ```

The workflow identity does not receive the provisioning operator's rights.
It has no AKS, subscription-wide, or provider-secret access.

## Set Repository Variables

Read the non-secret identity outputs:

```bash
AZURE_CLIENT_ID="$(az deployment group show \
  --resource-group "$RESOURCE_GROUP" --name "$DEPLOYMENT_NAME" \
  --query properties.outputs.clientId.value --output tsv)"
AZURE_TENANT_ID="$(az deployment group show \
  --resource-group "$RESOURCE_GROUP" --name "$DEPLOYMENT_NAME" \
  --query properties.outputs.tenantId.value --output tsv)"
```

Set these **Actions variables**, not provider secrets:

```bash
gh variable set AZURE_CLIENT_ID --repo "$GITHUB_REPOSITORY" --body "$AZURE_CLIENT_ID"
gh variable set AZURE_TENANT_ID --repo "$GITHUB_REPOSITORY" --body "$AZURE_TENANT_ID"
gh variable set AZURE_SUBSCRIPTION_ID --repo "$GITHUB_REPOSITORY" --body "$AZURE_SUBSCRIPTION_ID"
gh variable set ACR_NAME --repo "$GITHUB_REPOSITORY" --body "$ACR_NAME"
gh variable set ACR_LOGIN_SERVER --repo "$GITHUB_REPOSITORY" --body "$ACR_LOGIN_SERVER"
gh variable set ACR_PUBLISH_REPOSITORY --repo "$GITHUB_REPOSITORY" --body "$GITHUB_REPOSITORY"
```

| Variable                 | Purpose                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------- |
| `AZURE_CLIENT_ID`        | Dedicated managed identity's client ID.                                             |
| `AZURE_TENANT_ID`        | Identity's Microsoft Entra tenant.                                                  |
| `AZURE_SUBSCRIPTION_ID`  | Subscription containing the registry and identity.                                  |
| `ACR_NAME`               | Target registry resource name.                                                      |
| `ACR_LOGIN_SERVER`       | Actual login server returned by Azure, including any generated DNS suffix.          |
| `ACR_PUBLISH_REPOSITORY` | Exact allowed `owner/repository`; empty or mismatched values skip publication jobs. |

Do not place API keys, kubeconfigs, Azure passwords, or registry credentials in
this workflow. API keys are supplied at runtime through Kubernetes Secrets.

## Run and Verify the Pipeline

Enable only this workflow after its files are on your fork's `main`:

```bash
gh workflow enable acr-image.yml --repo "$GITHUB_REPOSITORY"
gh workflow run acr-image.yml --repo "$GITHUB_REPOSITORY" --ref main
gh run list --repo "$GITHUB_REPOSITORY" --workflow acr-image.yml --limit 5
```

Select the resulting run ID:

```bash
export RUN_ID="<run-id>"
gh run watch "$RUN_ID" --repo "$GITHUB_REPOSITORY" --exit-status
ATTEMPT="$(gh api "repos/${GITHUB_REPOSITORY}/actions/runs/${RUN_ID}" --jq .run_attempt)"
gh run download "$RUN_ID" --repo "$GITHUB_REPOSITORY" \
  --name "publication-${RUN_ID}-${ATTEMPT}" \
  --dir ".azure/publication-${RUN_ID}-${ATTEMPT}"
```

Expected result: both `build` and `publish` succeed. The receipt files are
`publication.json` and `publication-overpass.json`, containing both source SHAs,
the image tag, digest, and digest pull reference. Use those digests in your
local AKS overlay; publication does not update the cluster.

## What the Workflow Does

1. Runs on allowed `main` pushes, manual dispatch, and daily at 07:23 UTC.
   GitHub schedules are best-effort and fork schedules can require enabling.
2. Fetches the fixed canonical upstream URL and merges current `main` into the
   fork checkout. It does not push to either repository.
3. Fails on merge conflicts or missing Docker secret exclusions rather than
   silently dropping downstream changes.
4. Tests and builds both amd64 images, then transfers them to an isolated
   publisher with no upstream build code executing there.
5. Validates the configured repository, branch, registry, Azure IDs, source labels,
   and unique run tag before using OIDC.
6. Publishes `run-RUNID-ATTEMPT-DOWNSTREAMSHA-UPSTREAMSHA` tags and locks them against
   writes and deletion. No mutable `latest` tag is published.
7. Keeps image-transfer artifacts for one day and publication receipts for 90
   days. Registry images remain until managed through your retention process.

## Troubleshooting

| Symptom                              | Check                                                                                                                              |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Jobs are skipped                     | `ACR_PUBLISH_REPOSITORY` exactly matches the current repository, and the run is on `main`.                                         |
| Source merge fails                   | Resolve upstream conflicts in a reviewed fork commit; never blindly overwrite the deployment fixes.                                |
| `AADSTS700213`                       | Compare the reported assertion subject with the exact federated credential, including immutable IDs, issuer, audience, and branch. |
| Registry authorization fails         | Verify registry-scoped `AcrPush`, permission mode, and propagation. Do not grant broader subscription roles.                       |
| Registry is network-restricted       | Use an approved runner with network access. Do not disable registry protections as a workaround.                                   |
| A rerun cannot find its artifact/tag | Rerun **all jobs** or dispatch a new run. Publisher-only reruns intentionally reject a prior attempt's artifact/tag.               |
| One image exists after a failed run  | Publication is not atomic across repositories. Inspect the run's unique tags; do not treat a failed run as a verified release.     |

## Security and Production Considerations

| Area           | Recommendation                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Trust boundary | Protect `main`, workflow changes, and Actions variables. Trust only the exact intended repository/branch in Azure.               |
| Supply chain   | Canonical upstream and its dependencies are software inputs, not automatically trusted proof of safety. Review upstream changes. |
| Actions        | Official action commits are pinned. Verify updates against the official action repositories.                                     |
| Permissions    | Keep the builder without OIDC and the publisher without AKS rights. Keep ACR admin credentials disabled.                         |
| Cost           | Daily builds and locked image tags consume runner time and registry storage. Establish a reviewed retention process.             |

## References

- [GitHub OIDC with Azure](https://docs.github.com/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-azure)
- [GitHub OIDC subject configuration API](https://docs.github.com/rest/actions/oidc)
- [Azure managed identity federation](https://learn.microsoft.com/entra/workload-id/workload-identity-federation)
- [Private AKS deployment](AKS.md)
