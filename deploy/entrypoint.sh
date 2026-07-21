#!/bin/sh
# Boot the KB Studio server. Storage is MongoDB (MONGODB_URI); on first boot the server auto-imports the
# YAML seed KB at KB_DIR into the empty store, then Mongo is the source of truth. Idempotent.
set -eu

: "${KB_DIR:=/app/kb}"          # the YAML seed KB baked into the image (imported once, empty-store only)
: "${MONGODB_URI:=mongodb://host.docker.internal:27017}"
: "${KB_DB_NAME:=kb_studio}"
export KB_DIR MONGODB_URI KB_DB_NAME

exec pnpm exec tsx packages/studio/src/server.ts
