#!/usr/bin/env bash
# Inputs for scripts/github-actions/worker.sh.
#
# Export the values for the environment being configured, then run:
#   ENVIRONMENT=main bash scripts/github-actions/worker.sh
#   ENVIRONMENT=release-staging bash scripts/github-actions/worker.sh
#
# Required GitHub Actions variables (safe to store as variables):
#   KB_HOST, KB_DB_NAME, KB_ADMINS, MONGODB_URI, OAUTH_CLIENT_ID
# Required GitHub Actions secrets:
#   SSH_PRIVATE_KEY, HOST, USER, OAUTH_CLIENT_SECRET, OAUTH_COOKIE_SECRET

set -euo pipefail

REPO_OWNER="${REPO_OWNER:-ONDC-Official}"
REPO="${REPO:-${REPO_OWNER}/automation-kb-studio}"
ENVIRONMENT="${ENVIRONMENT:-main}"

# Supply environment-specific values before running worker.sh. KB_DB_NAME has the
# same safe default as deploy/docker-compose.yml.
: "${KB_HOST:?Set KB_HOST to the public hostname for this environment}"
: "${OAUTH_CLIENT_ID:?Set OAUTH_CLIENT_ID to the GitHub OAuth App client ID}"
KB_DB_NAME="${KB_DB_NAME:-kb_studio}"
KB_ADMINS="${KB_ADMINS:-extedcoud@gmail.com}"
MONGODB_URI="${MONGODB_URI:-mongodb://mongo:27017}"

declare -A ACTION_VARS=(
  [KB_HOST]="$KB_HOST"
  [KB_DB_NAME]="$KB_DB_NAME"
  [KB_ADMINS]="$KB_ADMINS"
  [MONGODB_URI]="$MONGODB_URI"
  [OAUTH_CLIENT_ID]="$OAUTH_CLIENT_ID"
)

# These inputs are intentionally GitHub Actions secrets, not variables. They are
# checked in worker.sh immediately before they are uploaded.
ACTION_SECRETS=(
  SSH_PRIVATE_KEY
  HOST
  USER
  OAUTH_CLIENT_SECRET
  OAUTH_COOKIE_SECRET
)
