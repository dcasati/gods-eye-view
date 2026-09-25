#!/usr/bin/env bash
set -euo pipefail

build_image() {
  docker build --pull --platform linux/amd64 \
    --label "org.opencontainers.image.source=https://github.com/${GITHUB_REPOSITORY:?}" \
    --label "org.opencontainers.image.revision=${DOWNSTREAM_SHA:?}" \
    --label "io.gods-eye-view.upstream.revision=${UPSTREAM_SHA:?}" \
    --label "io.gods-eye-view.upstream.source=https://github.com/bilawalsidhu/gods-eye-view" \
    --tag "$1:ci" "$2"
}
build_image gods-eye-view .
build_image overpass-austin infra/overpass
mkdir -p .ci-output
docker save gods-eye-view:ci overpass-austin:ci | gzip > .ci-output/image.tar.gz
