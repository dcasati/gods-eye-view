#!/usr/bin/env bash
set -euo pipefail

if [[ -n "$(git status --porcelain)" ]]; then
  echo "::error::Source assembly requires a clean downstream checkout." >&2
  exit 1
fi
downstream="$(git rev-parse HEAD)"
git fetch --no-tags https://github.com/bilawalsidhu/gods-eye-view.git \
  +refs/heads/main:refs/remotes/upstream-ci/main
upstream="$(git rev-parse refs/remotes/upstream-ci/main)"
if ! git -c user.name='ACR source assembly' -c user.email='ci@users.noreply.github.com' \
  merge --no-commit --no-ff "$upstream"; then
  echo "::error::Latest upstream conflicts with downstream patches. Resolve on downstream main; no image will be published." >&2
  git diff --name-only --diff-filter=U >&2
  git merge --abort
  exit 1
fi

# A future merge must not accidentally remove the secret exclusions.
for exclusion in '**/.env' '**/.env.*' '**/ENVIRONMENT' '**/*.pem' '**/*.key'; do
  if ! grep -Fqx "$exclusion" .dockerignore; then
    echo "::error::Required Docker secret exclusion is missing: $exclusion" >&2
    exit 1
  fi
done
[[ "${GITHUB_RUN_ID:?}" =~ ^[0-9]+$ && "${GITHUB_RUN_ATTEMPT:?}" =~ ^[0-9]+$ ]]
tag="run-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${downstream:0:12}-${upstream:0:12}"
printf 'downstream=%s\nupstream=%s\ntag=%s\n' "$downstream" "$upstream" "$tag" >> "${GITHUB_OUTPUT:?}"
printf 'Assembled downstream %s with upstream %s\n' "$downstream" "$upstream"
