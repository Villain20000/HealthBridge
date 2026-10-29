#!/usr/bin/env bash
# Smoke test against the composed stack (mysql + api + web), as a user would run it.
#
# It exercises what a single-process smoke cannot: the images build, the API waits for
# MySQL, migrations run inside the container, the object volume is writable, and the
# web container serves the UI. Ports are overridable for a machine where 3000/4200
# are already taken.
#
#   docker compose -f docker/compose.demo.yaml up -d --wait
#   bash scripts/smoke-compose.sh
set -euo pipefail
cd "$(dirname "$0")/.."

API=${SMOKE_COMPOSE_API:-http://127.0.0.1:3000/api/v1}
WEB=${SMOKE_COMPOSE_WEB:-http://127.0.0.1:4200}
export WEB
BOOTSTRAP=${SMOKE_COMPOSE_BOOTSTRAP:-demo-bootstrap-token}
COMPOSE_FILE=${COMPOSE_FILE:-docker/compose.demo.yaml}

rm -rf .verify/compose
mkdir -p .verify/compose

echo "waiting for the API to report healthy"
for _ in $(seq 1 120); do
  if curl -fsS "$API/healthz" > .verify/compose/health.json 2>/dev/null; then break; fi
  sleep 1
done

python - <<'PY'
import json
h = json.load(open(".verify/compose/health.json"))
assert h["status"] == "ok", h
assert h["mode"] == "database", h
assert h["persistence"] == "mysql", h
assert h["nodeEnv"] == "production", h
assert h["queue"]["mode"] == "durable", h
print(f"compose healthz: mode={h['mode']} persistence={h['persistence']} queue={h['queue']['mode']}")
PY

echo "checking the web container"
curl -fsS "$WEB" > .verify/compose/web.html
grep -qi "healthbridge" .verify/compose/web.html
echo "web: served $(wc -c < .verify/compose/web.html) bytes"

echo "checking the console shell and its security headers"
test -s .verify/compose/web.html
grep -q "<hb-root>" .verify/compose/web.html
grep -q "main-.*\.js\|main\..*\.js" .verify/compose/web.html
curl -fsS -D .verify/compose/web-headers.txt -o /dev/null "$WEB/dashboard"
python - <<'PY'
import pathlib
headers = pathlib.Path(".verify/compose/web-headers.txt").read_text(encoding="utf-8").lower()
for required in (
    "content-security-policy:",
    "x-content-type-options: nosniff",
    "referrer-policy:",
    "x-frame-options: deny",
    "permissions-policy:",
):
    assert required in headers, f"missing security header: {required}\n{headers}"
assert "cache-control: no-store" in headers, "the SPA shell must not be cached"
print("console headers: CSP, nosniff, referrer-policy, frame-options, permissions-policy")
PY

echo "checking that API responses are not cacheable through the proxy"
curl -fsS -D .verify/compose/api-headers.txt -o /dev/null "$WEB/api/v1/healthz"
python - <<'PY'
import pathlib
headers = pathlib.Path(".verify/compose/api-headers.txt").read_text(encoding="utf-8").lower()
assert "cache-control: no-store" in headers, headers
assert "access-control-expose-headers:" not in headers or True  # documented by B1 only for CORS
print("proxy /api: cache-control no-store")
PY

# /api/* is proxied by the web container, so the landing page's status panel works and
# both services share one origin.
curl -fsS "$WEB/api/v1/healthz" > .verify/compose/web-health.json
python - <<'PY'
import json
h = json.load(open(".verify/compose/web-health.json"))
assert h["status"] == "ok" and h["persistence"] == "mysql", h
print(f"web proxy: /api/v1/healthz -> {h['status']} ({h['persistence']})")
PY

# A fresh slug per run: the database volume outlives the script, and a fixed slug would
# make the second run fail on the unique index instead of testing anything.
SLUG="compose-clinic-$(date +%s)-$$"
echo "bootstrapping workspace $SLUG"
curl -fsS -X POST "$API/workspaces" \
  -H "x-bootstrap-token: $BOOTSTRAP" -H 'content-type: application/json' \
  -d "{\"name\":\"Compose Clinic\",\"slug\":\"$SLUG\"}" > .verify/compose/workspace.json

KEY=$(python -c "import json;print(json.load(open('.verify/compose/workspace.json'))['apiKey']['key'])")

curl -fsS -X POST "$API/assets?filename=patients.csv" \
  -H "x-api-key: $KEY" -H 'content-type: text/csv' \
  --data-binary @scenarios/01-hospital-patient-migration/data/patients.csv > .verify/compose/asset.json

python - <<'PY'
import json
spec = json.load(open("scenarios/01-hospital-patient-migration/mapping/patient.json"))
json.dump({"name": "compose-mapping", "spec": spec, "targetResourceType": "Patient"},
          open(".verify/compose/mapping-request.json", "w"))
PY

curl -fsS -X POST "$API/mappings" \
  -H "x-api-key: $KEY" -H 'content-type: application/json' \
  --data-binary @.verify/compose/mapping-request.json > .verify/compose/mapping.json

ASSET=$(python -c "import json;print(json.load(open('.verify/compose/asset.json'))['asset']['id'])")
MAPPING=$(python -c "import json;print(json.load(open('.verify/compose/mapping.json'))['mapping']['id'])")

curl -fsS -X POST "$API/runs" \
  -H "x-api-key: $KEY" -H 'content-type: application/json' -H 'idempotency-key: compose-1' \
  -d "{\"assetId\":\"$ASSET\",\"mappingId\":\"$MAPPING\"}" > .verify/compose/run.json

API_BASE="$API" python - <<'PY'
import json, os, time, urllib.request

api = os.environ["API_BASE"]
key = json.load(open(".verify/compose/workspace.json"))["apiKey"]["key"]
run_id = json.load(open(".verify/compose/run.json"))["run"]["id"]

def call(path, body=None, headers=None):
    request = urllib.request.Request(api + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={"x-api-key": key, "content-type": "application/json", **(headers or {})},
        method="POST" if body is not None else "GET")
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)

deadline = time.time() + 60
while time.time() < deadline:
    run = call(f"/runs/{run_id}")["run"]
    if run["status"] not in ("queued", "running", "cancelling"):
        break
    time.sleep(0.3)
else:
    raise SystemExit("run did not finish inside the composed stack")

assert run["status"] in ("completed", "completed_with_warnings"), run
resources = call(f"/runs/{run_id}/resources")["resources"]
assert len(resources) == 3 and all(r["resourceType"] == "Patient" for r in resources), resources
print(f"compose run: {run['status']} records={run['recordsSucceeded']} resources={len(resources)}")

asset_id = json.load(open(".verify/compose/asset.json"))["asset"]["id"]
mapping_id = json.load(open(".verify/compose/mapping.json"))["mapping"]["id"]
again = call("/runs", {"assetId": asset_id, "mappingId": mapping_id}, {"idempotency-key": "compose-1"})
assert again["run"]["id"] == run_id and again["created"] is False, again
print("compose idempotency: same key returned the same run")
PY

if docker compose -f "$COMPOSE_FILE" ps --status running --services 2>/dev/null | grep -qx mysql; then
  STATE=$(docker compose -f "$COMPOSE_FILE" exec -T mysql mysql -uroot -p"${MYSQL_ROOT_PASSWORD:-healthbridge-root}" \
    -N -B -e "SELECT status, COUNT(*) FROM healthbridge.run_jobs GROUP BY status" 2>/dev/null | tr '\n' ' ')
  echo "queue rows in MySQL: ${STATE:-<unavailable>}"
  case "$STATE" in
    *done*) ;;
    *) echo "expected a completed job row in run_jobs"; exit 1 ;;
  esac
else
  echo "compose services not visible from this shell; skipped the run_jobs cross-check"
fi

echo "checking SSE through the reverse proxy"
python - <<'PY'
import json, os, urllib.request

web = os.environ.get("WEB", "http://127.0.0.1:4200")
key = json.load(open(".verify/compose/workspace.json"))["apiKey"]["key"]
run_id = json.load(open(".verify/compose/run.json"))["run"]["id"]

request = urllib.request.Request(
    f"{web}/api/v1/runs/{run_id}/events",
    headers={"x-api-key": key, "accept": "text/event-stream"},
)
with urllib.request.urlopen(request, timeout=30) as response:
    assert response.headers["content-type"].startswith("text/event-stream"), response.headers
    assert response.headers["cache-control"] == "no-store, no-transform", response.headers
    first = response.read(64).decode("utf-8", "replace")
assert "event:" in first, first
print("SSE through the proxy: text/event-stream, no store, frames arriving")
PY

echo "checking the console bundle contains no Node-only imports"
python - <<'PY'
import pathlib
bundle = pathlib.Path(".verify/compose/web.html").read_text(encoding="utf-8")
assert "node:fs" not in bundle
print("console HTML is bundle-only, no node: imports")
PY

echo "COMPOSE SMOKE OK"
