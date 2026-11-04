#!/usr/bin/env bash
# After `docker compose up -d --build` (docker-compose.yaml): registers the Palladio Simulation plugin, creates the
# project with the plugin enabled, pushes the paper's files into it (core/platform/push.sh) and checks that
# metrics.fn type-checks (docs/platform.md §1-2). Idempotent: an existing registration or project of the same name
# is reused. Prints the project id (PID= for the other tools of core/platform/).
#
#   core/platform/setup-local.sh
#   BASE=http://localhost:4242 USER_NAME=admin PASSWORD=admin PLUGIN_URL=http://palladio-sim:3022/ \
#     PROJECT_NAME="MiSArch Architecture Optimisation" core/platform/setup-local.sh
set -euo pipefail
P="$(cd "$(dirname "$0")/../.." && pwd)"
BASE="${BASE:-http://localhost:${MDEO_PORT:-4242}}"
export USER_NAME="${USER_NAME:-${ADMIN_USERNAME:-admin}}" PASSWORD="${PASSWORD:-${ADMIN_PASSWORD:-admin}}"
PLUGIN_URL="${PLUGIN_URL:-http://palladio-sim:3022/}"
PROJECT_NAME="${PROJECT_NAME:-MiSArch Architecture Optimisation}"
mkdir -p "$P/build/platform"
JAR="$P/build/platform/setup-local.cookies"
api() {   # <method> <path> [<json body>]: the response body; fails on HTTP >= 400
    local out code
    out=$(curl -sS -b "$JAR" -c "$JAR" -X "$1" -H 'Content-Type: application/json' -H "Origin: $BASE" \
        ${3:+--data "$3"} -w '\n%{http_code}' "$BASE$2")
    code=${out##*$'\n'}; out=${out%$'\n'*}
    [ "$code" -ge 200 ] && [ "$code" -lt 400 ] || { echo "$1 $2: HTTP $code $out" >&2; return 1; }
    printf '%s' "$out"
}
json() { python3 -c "import json,sys; d=json.load(sys.stdin); $1"; }

echo "waiting for the platform at $BASE ..."
for _ in $(seq 120); do
    api POST /api/auth/login "{\"username\":\"$USER_NAME\",\"password\":\"$PASSWORD\"}" >/dev/null 2>&1 && break
    sleep 5
done
api POST /api/auth/login "{\"username\":\"$USER_NAME\",\"password\":\"$PASSWORD\"}" >/dev/null

# the plugin (the backend fetches its manifest from PLUGIN_URL; the service may still be starting)
norm="${PLUGIN_URL%/}/"
plugin=$(api GET /api/plugins | json "print(next((p['id'] for p in (d if isinstance(d, list) else d.get('plugins', [])) if p.get('url') == '$norm'), ''))")
if [ -z "$plugin" ]; then
    for _ in $(seq 60); do
        plugin=$(api POST /api/plugins "{\"url\":\"$norm\"}" 2>/dev/null | json "print(d.get('id') or d.get('plugin', {}).get('id', ''))") && [ -n "$plugin" ] && break
        sleep 5
    done
    [ -n "$plugin" ] || { echo "could not register the plugin at $norm (is the palladio-sim container healthy?)" >&2; exit 1; }
    echo "registered the plugin $norm: $plugin"
else
    echo "plugin $norm: $plugin"
fi

# the project
pid=$(api GET /api/user/projects 2>/dev/null || api GET /api/projects)
pid=$(printf '%s' "$pid" | json "print(next((p['id'] for p in (d if isinstance(d, list) else d.get('projects', [])) if p.get('name') == '''$PROJECT_NAME'''), ''))")
if [ -z "$pid" ]; then
    pid=$(api POST /api/projects "{\"name\":\"$PROJECT_NAME\"}" | json "print(d.get('id') or d.get('project', {}).get('id', ''))")
    echo "created the project \"$PROJECT_NAME\": $pid"
else
    echo "project \"$PROJECT_NAME\": $pid"
fi
api POST "/api/projects/$pid/plugins" "{\"pluginId\":\"$plugin\"}" >/dev/null 2>&1 || true
api GET "/api/projects/$pid/plugins" | grep -q "$plugin" || { echo "the plugin is not enabled in $pid" >&2; exit 1; }

# the files: the paper's two configs and the smoke test (CONFIGS), with every file they reach
export CONFIGS="${CONFIGS:-optimize/domain/today-3obj-5sim.config optimize/domain/perclass-3obj-5sim.config optimize/domain/smoke-3obj-5sim.config}"
"$P/core/platform/push.sh" "$pid" "$BASE"

# metrics.fn type-checks only with the plugin enabled
if d=$(api GET "/api/projects/$pid/file-data/diagnostics?path=/transform/metrics.fn"); then
    n=$(printf '%s' "$d" | json "
v = d.get('data', d) if isinstance(d, dict) else d
v = v.get('diagnostics', v) if isinstance(v, dict) else v
print(len(v) if isinstance(v, list) else repr(v)[:200])")
    echo "diagnostics of /transform/metrics.fn: $n"
    [ "$n" = 0 ] || echo "  expected none: open the project in the workbench and check its plugins" >&2
else
    echo "could not check /transform/metrics.fn (the project needs mdeo's default plugins and Palladio Simulation)" >&2
fi
echo
echo "PID=$pid    # the project, for core/platform/status.mjs, dl.mjs, ... (cases/misarch/platform.json names the paper's)"
echo "workbench: $BASE/  (open optimize/domain/smoke-3obj-5sim.config or today-3obj-5sim.config and press Run)"
