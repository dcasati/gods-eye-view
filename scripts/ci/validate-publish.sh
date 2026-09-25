#!/usr/bin/env bash
set -euo pipefail

fail() { echo "::error::$*" >&2; exit 1; }
[[ -n "${PUBLISH_REPOSITORY:-}" &&
   "${GITHUB_REPOSITORY:-}" == "$PUBLISH_REPOSITORY" ]] ||
  fail 'Set ACR_PUBLISH_REPOSITORY to the exact repository allowed to publish.'
[[ "${GITHUB_REF:-}" == 'refs/heads/main' ]] || fail 'Only downstream main may publish.'
case "${GITHUB_EVENT_NAME:-}" in
  push|schedule|workflow_dispatch) ;;
  *) fail 'Unexpected publication event.' ;;
esac
[[ "${ACR_NAME:-}" =~ ^[a-z0-9]{5,50}$ &&
   "${ACR_LOGIN_SERVER:-}" =~ ^${ACR_NAME}(-[a-z0-9]+)?\.azurecr\.io$ &&
   "${IMAGE_NAME:-}" == 'gods-eye-view' ]] || fail 'Unexpected registry or image target.'
validate_uuid() {
  [[ "$2" =~ ^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$ ]] ||
    fail "Set repository variable $1 to a valid Azure UUID."
}
validate_uuid AZURE_CLIENT_ID "${AZURE_CLIENT_ID:-}"
validate_uuid AZURE_TENANT_ID "${AZURE_TENANT_ID:-}"
validate_uuid AZURE_SUBSCRIPTION_ID "${AZURE_SUBSCRIPTION_ID:-}"
[[ "${DOWNSTREAM_SHA:-}" =~ ^[0-9a-f]{40}$ &&
   "${UPSTREAM_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || fail 'Invalid source SHAs.'
[[ "$DOWNSTREAM_SHA" == "${GITHUB_SHA:-}" ]] || fail 'Downstream source does not match this run.'
[[ "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ && "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ ]] ||
  fail 'Invalid run identity.'
expected="run-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-${DOWNSTREAM_SHA:0:12}-${UPSTREAM_SHA:0:12}"
[[ "${IMAGE_TAG:-}" == "$expected" ]] || fail 'Unexpected image tag.'
