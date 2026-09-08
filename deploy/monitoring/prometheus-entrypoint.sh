#!/bin/sh
# Fills in where the platform listens and writes the scrape token to a file
# only this container can read, then starts Prometheus.
set -eu
[ -n "${METRICS_TOKEN:-}" ] || { echo "Set METRICS_TOKEN in production.env to use monitoring." >&2; exit 1; }
sed "s/__EDGE_GATEWAY__/${EDGE_GATEWAY:-172.31.250.1}/g" /etc/prometheus/prometheus.yml > /prometheus/prometheus.yml
umask 077
printf '%s' "${METRICS_TOKEN}" > /prometheus/metrics-token
exec /bin/prometheus \
  --config.file=/prometheus/prometheus.yml \
  --storage.tsdb.path=/prometheus/data \
  --storage.tsdb.retention.time="${PROMETHEUS_RETENTION:-30d}" \
  --web.listen-address=0.0.0.0:9090
