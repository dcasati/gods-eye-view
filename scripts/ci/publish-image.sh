#!/usr/bin/env bash
set -euo pipefail
bash scripts/ci/validate-publish.sh
for local_image in "$IMAGE_NAME" overpass-austin; do
  [[ "$(docker image inspect "$local_image:ci" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" == "$DOWNSTREAM_SHA" ]]
  [[ "$(docker image inspect "$local_image:ci" --format '{{index .Config.Labels "io.gods-eye-view.upstream.revision"}}')" == "$UPSTREAM_SHA" ]]
done
# Never echo the short-lived token or enable shell tracing.
az acr login --name "$ACR_NAME" --expose-token --query accessToken --output tsv |
  docker login "$ACR_LOGIN_SERVER" \
  --username 00000000-0000-0000-0000-000000000000 --password-stdin
mkdir -p .ci-output
for local_image in "$IMAGE_NAME" overpass-austin; do
  image="$ACR_LOGIN_SERVER/$local_image:$IMAGE_TAG"
  docker tag "$local_image:ci" "$image"
  docker push "$image"
  digest="$(az acr repository show --name "$ACR_NAME" --image "$local_image:$IMAGE_TAG" --query digest --output tsv)"
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]
  az acr repository update --name "$ACR_NAME" --image "$local_image:$IMAGE_TAG" \
    --write-enabled false --delete-enabled false --output none
  receipt='.ci-output/publication.json'
  if [[ "$local_image" == 'overpass-austin' ]]; then
    receipt='.ci-output/publication-overpass.json'
  fi
  export PUBLISHED_IMAGE="$image" PUBLISHED_DIGEST="$digest" PUBLISHED_NAME="$local_image" PUBLICATION_RECEIPT="$receipt"
  node --input-type=module <<'NODE'
import { writeFileSync } from 'node:fs';
const e = process.env;
writeFileSync(e.PUBLICATION_RECEIPT, JSON.stringify({
  image: e.PUBLISHED_IMAGE,
  digest: e.PUBLISHED_DIGEST,
  pullReference: `${e.ACR_LOGIN_SERVER}/${e.PUBLISHED_NAME}@${e.PUBLISHED_DIGEST}`,
  downstream: e.DOWNSTREAM_SHA,
  upstream: e.UPSTREAM_SHA,
  run: `https://github.com/${e.GITHUB_REPOSITORY}/actions/runs/${e.GITHUB_RUN_ID}`,
}, null, 2) + '\n');
NODE
  {
  printf '## Published container\n\n'
  printf -- '- Image: `%s`\n' "$image"
  printf -- '- Digest: `%s`\n' "$digest"
  printf -- '- Downstream SHA: `%s`\n' "$DOWNSTREAM_SHA"
  printf -- '- Upstream SHA: `%s`\n' "$UPSTREAM_SHA"
  printf -- '- Pull: `%s/%s@%s`\n' "$ACR_LOGIN_SERVER" "$local_image" "$digest"
  printf '\nThe unique version tag is locked. No AKS deployment was performed.\n'
  } >> "${GITHUB_STEP_SUMMARY:?}"
done
