#!/bin/sh
# Creates the asset bucket and locks it down. Idempotent: safe to run on every
# `docker compose up`, and a no-op once the bucket exists.
set -eu

mc alias set local http://minio:9000 "$STORAGE_ACCESS_KEY" "$STORAGE_SECRET_KEY"

if mc ls "local/$STORAGE_BUCKET" >/dev/null 2>&1; then
  echo "bucket $STORAGE_BUCKET already exists"
else
  mc mb "local/$STORAGE_BUCKET"
  echo "created bucket $STORAGE_BUCKET"
fi

# Assets are served through the platform, which checks project permissions
# first. The bucket itself must never be anonymously readable.
mc anonymous set none "local/$STORAGE_BUCKET"
echo "anonymous access denied on $STORAGE_BUCKET"
