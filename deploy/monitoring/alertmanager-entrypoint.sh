#!/bin/sh
# Writes Alertmanager's configuration from the environment, then starts it.
# A heredoc rather than sed, so a password containing / or & survives.
set -eu
[ -n "${SMTP_HOST:-}" ] || { echo "Set SMTP_HOST in production.env to use monitoring." >&2; exit 1; }
[ -n "${MAIL_FROM:-}" ] || { echo "Set MAIL_FROM in production.env to use monitoring." >&2; exit 1; }
[ -n "${ALERT_EMAIL:-}" ] || { echo "Set ALERT_EMAIL in production.env to use monitoring." >&2; exit 1; }
cat > /alertmanager/alertmanager.yml <<CONFIG
global:
  smtp_smarthost: '${SMTP_HOST}:${SMTP_PORT:-587}'
  smtp_from: '${MAIL_FROM}'
  smtp_auth_username: '${SMTP_USER:-}'
  smtp_auth_password: '${SMTP_PASSWORD:-}'
  smtp_require_tls: ${ALERT_SMTP_REQUIRE_TLS:-true}

route:
  receiver: operator
  group_by: ['alertname']
  group_wait: 30s
  group_interval: 5m
  # One reminder a day for something still wrong, not one a minute.
  repeat_interval: 24h

receivers:
  - name: operator
    email_configs:
      - to: '${ALERT_EMAIL}'
        send_resolved: true
CONFIG
exec /bin/alertmanager --config.file=/alertmanager/alertmanager.yml --storage.path=/alertmanager
