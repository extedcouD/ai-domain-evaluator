#!/usr/bin/env bash
# Creates or updates the GitHub environment, variables, and secrets required by
# .github/workflows/deployment.yml. Based on the working release-env-workbench
# helper, with secret handling added for the KB Studio deployment.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=env.sh
source "$SCRIPT_DIR/env.sh"

if ! gh auth status --hostname github.com >/dev/null 2>&1; then
  echo "GitHub CLI is not authenticated. Run: gh auth login -h github.com" >&2
  exit 1
fi

echo "Ensuring environment $ENVIRONMENT exists in $REPO..."
if ! gh api "/repos/$REPO/environments/$ENVIRONMENT" >/dev/null 2>&1; then
  gh api --method PUT -H "Accept: application/vnd.github+json" \
    "/repos/$REPO/environments/$ENVIRONMENT" >/dev/null
fi

for key in "${!ACTION_VARS[@]}"; do
  value="${ACTION_VARS[$key]}"
  if gh api --method POST -H "Accept: application/vnd.github+json" \
    "/repos/$REPO/environments/$ENVIRONMENT/variables" \
    -f name="$key" -f value="$value" >/dev/null 2>&1; then
    echo "Created variable $key in $ENVIRONMENT."
  else
    gh api --method PATCH -H "Accept: application/vnd.github+json" \
      "/repos/$REPO/environments/$ENVIRONMENT/variables/$key" \
      -f name="$key" -f value="$value" >/dev/null
    echo "Updated variable $key in $ENVIRONMENT."
  fi
done

for key in "${ACTION_SECRETS[@]}"; do
  : "${!key:?Set $key before running this script}"
  printf '%s' "${!key}" | gh secret set "$key" --repo "$REPO" --env "$ENVIRONMENT"
  echo "Updated secret $key in $ENVIRONMENT."
done

echo "Configured $ENVIRONMENT in $REPO."
