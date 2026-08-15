#!/usr/bin/env bash
# Optional Docker smoke for Redis idle + stop/start recovery.
# Does not restart the API container. Requires a running compose stack and a
# local dashboard login body in REDIS_SMOKE_LOGIN_JSON.
set -euo pipefail
API_URL="${API_URL:-http://localhost:3000}"
LOGIN_JSON="${REDIS_SMOKE_LOGIN_JSON:-}"
if [[ -z "$LOGIN_JSON" ]]; then
  echo "skip: set REDIS_SMOKE_LOGIN_JSON to a non-production dashboard login body"
  exit 0
fi
curl -fsS "$API_URL/health/live" >/dev/null
curl -fsS "$API_URL/health/ready" >/dev/null
code=$(curl -sS -o /tmp/redis-smoke-login.json -w "%{http_code}" -X POST "$API_URL/api/v1/dashboard/auth/login" -H "content-type: application/json" -d "$LOGIN_JSON")
test "$code" = "200" -o "$code" = "429"
sleep 0.1
code=$(curl -sS -o /tmp/redis-smoke-login.json -w "%{http_code}" -X POST "$API_URL/api/v1/dashboard/auth/login" -H "content-type: application/json" -d "$LOGIN_JSON")
test "$code" = "200" -o "$code" = "429"
docker compose stop redis
sleep 1
live=$(curl -sS -o /dev/null -w "%{http_code}" "$API_URL/health/live")
ready=$(curl -sS -o /dev/null -w "%{http_code}" "$API_URL/health/ready")
login=$(curl -sS -o /tmp/redis-smoke-login.json -w "%{http_code}" -X POST "$API_URL/api/v1/dashboard/auth/login" -H "content-type: application/json" -d "$LOGIN_JSON")
test "$live" = "200"
test "$ready" = "503"
test "$login" = "503"
grep -q RATE_LIMITER_UNAVAILABLE /tmp/redis-smoke-login.json
docker compose start redis
for _ in $(seq 1 20); do
  if curl -fsS "$API_URL/health/ready" >/dev/null; then
    break
  fi
  sleep 0.5
done
curl -fsS "$API_URL/health/ready" >/dev/null
code=$(curl -sS -o /tmp/redis-smoke-login.json -w "%{http_code}" -X POST "$API_URL/api/v1/dashboard/auth/login" -H "content-type: application/json" -d "$LOGIN_JSON")
test "$code" = "200" -o "$code" = "429"
echo "redis reconnect smoke ok"
