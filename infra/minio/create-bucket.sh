#!/bin/sh
set -eu

mc alias set local http://minio:9000 "$STORAGE_ACCESS_KEY" "$STORAGE_SECRET_KEY"

if mc ls "local/$STORAGE_BUCKET" >/dev/null 2>&1; then
  echo "bucket $STORAGE_BUCKET already exists"
else
  mc mb "local/$STORAGE_BUCKET"
  echo "created bucket $STORAGE_BUCKET"
fi

mc anonymous set none "local/$STORAGE_BUCKET"
echo "anonymous access denied on $STORAGE_BUCKET"
