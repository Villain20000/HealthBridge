#!/usr/bin/env bash
# End-to-end smoke test against a real API process.
# Proves the compiled build works, not just the tsx test runner.
#
#   bash scripts/smoke-api.sh                          # demo mode (in-memory)
#   SMOKE_MODE=mysql SMOKE_DATABASE_URL=mysql://... \
#     bash scripts/smoke-api.sh                        # real MySQL, migrations at boot
set -euo pipefail
cd "$(dirname "$0")/.."

MODE=${SMOKE_MODE:-demo}

export PORT=3111
export HEALTHBRIDGE_BOOTSTRAP_TOKEN=smoke-bootstrap-token
export HEALTHBRIDGE_STORAGE_DIR=./.verify/objects

if [ "$MODE" = "mysql" ]; then
  : "${SMOKE_DATABASE_URL:?SMOKE_DATABASE_URL must point at an empty mysql:// database}"
  export NODE_ENV=production
  export DATABASE_URL="$SMOKE_DATABASE_URL"
  export HEALTHBRIDGE_KEY_PEPPER=smoke-pepper-at-least-16-chars
else
  export NODE_ENV=development
  unset DATABASE_URL || true
fi
rm -rf .verify
mkdir -p .verify

node apps/api/dist/main.js > .verify/api.log 2>&1 &
API_PID=$!
trap 'kill $API_PID 2>/dev/null || true' EXIT

for _ in $(seq 1 80); do
  if curl -fsS "http://127.0.0.1:$PORT/api/v1/healthz" > .verify/health.json 2>/dev/null; then break; fi
  sleep 0.25
done

python - <<'PY'
import json, os
h = json.load(open(".verify/health.json"))
assert h["status"] == "ok", h
if os.environ.get("SMOKE_MODE") == "mysql":
    assert h["mode"] == "database", h
    assert h["persistence"] == "mysql", h
    assert h["nodeEnv"] == "production", h
else:
    assert h["mode"] == "demo", h
print(f"healthz: mode={h['mode']} persistence={h['persistence']} storage={h['storage']}")
PY

# Unique per run: a re-run against the same database must not trip the slug index.
SLUG="smoke-clinic-$(date +%s)-$$"
curl -fsS -X POST "http://127.0.0.1:$PORT/api/v1/workspaces" \
  -H "x-bootstrap-token: smoke-bootstrap-token" -H 'content-type: application/json' \
  -d "{\"name\":\"Smoke Clinic\",\"slug\":\"$SLUG\"}" > .verify/workspace.json

KEY=$(python -c "import json;print(json.load(open('.verify/workspace.json'))['apiKey']['key'])")
echo "workspace created, key prefix: ${KEY:0:12}"

curl -fsS -X POST "http://127.0.0.1:$PORT/api/v1/assets?filename=patients.csv" \
  -H "x-api-key: $KEY" -H 'content-type: text/csv' \
  --data-binary @scenarios/01-hospital-patient-migration/data/patients.csv > .verify/asset.json

python - <<'PY'
import json
a = json.load(open(".verify/asset.json"))["asset"]
assert a["sourceFormat"] == "csv", a
print(f"asset: {a['id']} format={a['sourceFormat']} domain={a['domain']} bytes={a['sizeBytes']}")
PY

python - <<'PY'
import json
spec = json.load(open("scenarios/01-hospital-patient-migration/mapping/patient.json"))
json.dump({"name": "smoke-mapping", "spec": spec, "targetResourceType": "Patient"},
          open(".verify/mapping-request.json", "w"))
PY

curl -fsS -X POST "http://127.0.0.1:$PORT/api/v1/mappings" \
  -H "x-api-key: $KEY" -H 'content-type: application/json' \
  --data-binary @.verify/mapping-request.json > .verify/mapping.json

ASSET=$(python -c "import json;print(json.load(open('.verify/asset.json'))['asset']['id'])")
MAPPING=$(python -c "import json;print(json.load(open('.verify/mapping.json'))['mapping']['id'])")

curl -fsS -X POST "http://127.0.0.1:$PORT/api/v1/runs" \
  -H "x-api-key: $KEY" -H 'content-type: application/json' -H 'idempotency-key: smoke-1' \
  -d "{\"assetId\":\"$ASSET\",\"mappingId\":\"$MAPPING\"}" > .verify/run.json

RUN=$(python -c "import json;print(json.load(open('.verify/run.json'))['run']['id'])")
echo "run queued: $RUN"

python - <<'PY'
import json, time, urllib.request

run_id = json.load(open(".verify/run.json"))["run"]["id"]
key = json.load(open(".verify/workspace.json"))["apiKey"]["key"]
base = "http://127.0.0.1:3111/api/v1"

def call(path, body=None, headers=None):
    request = urllib.request.Request(base + path,
        data=None if body is None else json.dumps(body).encode(),
        headers={"x-api-key": key, "content-type": "application/json", **(headers or {})},
        method="POST" if body is not None else "GET")
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)

deadline = time.time() + 30
while time.time() < deadline:
    run = call(f"/runs/{run_id}")["run"]
    if run["status"] not in ("queued", "running", "cancelling"):
        break
    time.sleep(0.2)
else:
    raise SystemExit("run did not finish")

assert run["status"] in ("completed", "completed_with_warnings"), run
resources = call(f"/runs/{run_id}/resources")["resources"]
traces = call(f"/runs/{run_id}/traces")
bundle = call(f"/runs/{run_id}/bundle")
assert resources and all(r["resourceType"] == "Patient" for r in resources), resources[:1]
assert traces["count"] > 0
assert bundle["expected"]["outputChecksum"], bundle
audit = call("/audit")["events"]

print(f"run: {run['status']} processed={run['recordsProcessed']} succeeded={run['recordsSucceeded']} failed={run['recordsFailed']}")
print(f"resources: {len(resources)} Patient, first id={resources[0]['id']}")
print(f"traces: {traces['count']}  validation valid={((run.get('validation') or {}).get('isValid'))}")
print(f"bundle checksum: {bundle['expected']['outputChecksum'][:24]}")
print(f"workspace slug: {call('/workspaces/current')['workspace']['slug']}  audit events: {len(audit)}")

asset_id = json.load(open(".verify/asset.json"))["asset"]["id"]
mapping_id = json.load(open(".verify/mapping.json"))["mapping"]["id"]
again = call("/runs", {"assetId": asset_id, "mappingId": mapping_id}, {"idempotency-key": "smoke-1"})
assert again["run"]["id"] == run_id and again["created"] is False, again
print("idempotency: same Idempotency-Key returned the same run (created=false)")

download = urllib.request.Request(f"{base}/assets/{asset_id}/content", headers={"x-api-key": key})
with urllib.request.urlopen(download, timeout=15) as response:
    body = response.read()
    assert response.headers["x-checksum"].startswith("sha256:"), dict(response.headers)
assert body == open("scenarios/01-hospital-patient-migration/data/patients.csv", "rb").read()
print("asset download: bytes identical, checksum header present")
PY

# In database mode the queue is durable, so work that outlives the process must be
# picked up by the next one. Prove it: stop the API, leave a queued run plus its job row
# behind, restart, and wait for it to finish.
if [ "$MODE" = "mysql" ]; then
  WORKSPACE=$(python -c "import json;print(json.load(open('.verify/workspace.json'))['workspace']['id'])")
  STOPPED_RUN=$(python -c "import json;print(json.load(open('.verify/run.json'))['run']['id'])")

  kill "$API_PID" 2>/dev/null || true
  wait "$API_PID" 2>/dev/null || true
  echo "recovery: API stopped"

  SEEDED=$(DATABASE_URL="$DATABASE_URL" node scripts/queue-seed.mjs --from "$STOPPED_RUN" --workspace "$WORKSPACE")
  echo "recovery: seeded queued run $SEEDED with the API down"

  node apps/api/dist/main.js >> .verify/api.log 2>&1 &
  API_PID=$!

  SEEDED="$SEEDED" python - <<'PY'
import json, os, time, urllib.request

run_id = os.environ["SEEDED"]
key = json.load(open(".verify/workspace.json"))["apiKey"]["key"]
base = "http://127.0.0.1:3111/api/v1"

def get(path):
    request = urllib.request.Request(base + path, headers={"x-api-key": key})
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)

# The server may still be booting; treat connection errors as "not yet".
deadline = time.time() + 60
while time.time() < deadline:
    try:
        run = get(f"/runs/{run_id}")["run"]
    except Exception:
        time.sleep(0.3)
        continue
    if run["status"] not in ("queued", "running", "cancelling"):
        break
    time.sleep(0.3)
else:
    raise SystemExit(f"queued run {run_id} never finished after the restart")

assert run["status"] in ("completed", "completed_with_warnings"), run
assert run["recordsSucceeded"] == 3, run
print(f"recovery: run {run_id} resumed from the database after restart -> {run['status']} ({run['recordsSucceeded']} records)")
PY
fi

echo "SMOKE OK"
