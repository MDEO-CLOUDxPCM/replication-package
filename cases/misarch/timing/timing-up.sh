#!/usr/bin/env bash
# Bring the misarch-kotlin stack up for the timing campaign (README.md §2.3), with or without the timing switches.
#
#   timing-up.sh up [--mode off|on] [--images cut|timing[=TAG]|mech[=TAG]|dev] [--sampler R] [--purpose TEXT]
#                   [--share-t2] [--copies on|off] [--cache on|off] [--ttl S] [--shared-cache on|off] [--caller-cache TARGETS|off]
#   timing-up.sh mech --copies on|off --cache on|off [--ttl S] [--shared-cache on|off] [--caller-cache TARGETS|off]
#                     [--recreate-order]
#                              block 6: set the mechanism switches on the running `--images mech` stack (recreates
#                              order, catalog, shipment and their sidecars only if a switch changes)
#   timing-up.sh down          stop the stack (containers and volumes kept; never -v) and release STACK.lock
#   timing-up.sh ext           CREATE EXTENSION pg_stat_statements once per database (done by `up --mode on`)
#   timing-up.sh reset         pg_stat_statements_reset() on every Postgres
#   timing-up.sh status        what is running (override on/off, sampler, preload, Dapr tracing, image)
#   timing-up.sh compose-file  print the COMPOSE_FILE `up` would use (same options)
#
# --mode off  exactly today's stack: no override, Dapr tracing off (the "off" totals, block 2)
# --mode on   + timing/docker-compose.timing.yaml (OTLP spans with TIMING_SAMPLER_ARG, data-fetcher spans,
#             MISARCH_TIMING_SPANS, async-profiler mount, /timing results dir, pg_stat_statements) + TRACING=1
# --images    cut (default): misarch-kotlin main's production build, misarch-kotlin/<svc>:$TIMING_CUT_TAG for the 17 apps
#             (default cut-20261101 = main d569ad9; the same as timing=cut-20261101);
#             timing[=TAG]: misarch-kotlin/<svc>:TAG for the 17 apps (default TAG timing-20261101, the instrumentation build);
#             mech[=TAG]: block 6 - today's topology, the timing images (TIMING_IMAGES_TAG, default timing-20261101)
#             with catalog, shipment, order -> misarch-kotlin/<svc>:TAG (default mech-20261101, branch
#             timing-mechanisms), plus docker-compose.mechanisms.yaml (switches, default off = today's cut);
#             dev: whatever misarch-kotlin/<svc>:dev is (not pinned - avoid for measurements)
# --sampler   OTEL_TRACES_SAMPLER_ARG for --mode on (default 0.1; 1.0 for the low-rate and latency blocks).
#             Changing it recreates the apps (JVM restart, warm-up needed).
#
# Stack lock: `up` creates STACK.lock in the repository root with noclobber
# ("T3 <purpose> <start> <pid>[ shareable-with-T2]"; TIMING_LOCK_TAG replaces "T3", or a lock already held under that
# tag is used) and refuses if someone else holds it; `down` removes it if it is ours.
# Mechanism switches (--images mech): --copies on = MISARCH_LOCAL_COPIES=true in order, --cache on =
# MISARCH_ENTITY_CACHE_TYPES Order (shipment) / ProductVariant (catalog), --ttl = MISARCH_ENTITY_CACHE_TTL_SECONDS
# (default 60), --shared-cache on = MISARCH_ENTITY_CACHE_SHARED_TYPES ProductVariant in catalog (one entry per key for
# all users; README.md §4.1), --caller-cache shipment,discount,inventory = MISARCH_CALLER_CACHE_TARGETS in order (caller-side
# cache of createOrder's invocations, TTL = --ttl; README.md §4.1). Stored in raw/state/mech-switches.env; read at JVM start, so a change recreates those containers.
# Heaps are pinned from calibration/results-kotlin/stack.env (as in the calibration runs).
set -euo pipefail
T=$(cd "$(dirname "$0")" && pwd)
# machine-specific settings (TIMING_ASPROF_DIR, MISARCH_KOTLIN_REPO, ...), not in git: timing/local.env.example
[ -f "$T/local.env" ] && { set -a; . "$T/local.env"; set +a; }
export TIMING_OUT=${TIMING_OUT:-$T/raw/_asprof}   # profiler output dir, also needed to interpolate the compose files on down
C=$T/calibration
REPO=$(cd "$T/../../.." && pwd)   # the repository root (T = cases/misarch/timing); the locks live there
K=${MISARCH_KOTLIN_REPO:-$("$REPO/core/tools/checkout.sh" misarch-kotlin)}/deploy/compose
LOCK=$REPO/STACK.lock
STATE=${TIMING_RAW:-$T/raw}/state
PY=python3
mkdir -p "$STATE"

cmd=${1:-}; shift || true
MODE=off; IMAGES=cut; SAMPLER=0.1; PURPOSE="timing campaign"; SHARE=""; COPIES=""; CACHE=""; TTL=""; SHARED=""; CALLER=""
LOCKTAG=${TIMING_LOCK_TAG:-T3}; RECREATE_ORDER=0
SWITCHES=$STATE/mech-switches.env
MECH_APPS="order catalog shipment"
while [ $# -gt 0 ]; do
  case "$1" in
    --mode) MODE=$2; shift 2 ;;
    --images) IMAGES=$2; shift 2 ;;
    --sampler) SAMPLER=$2; shift 2 ;;
    --purpose) PURPOSE=$2; shift 2 ;;
    --share-t2) SHARE=" shareable-with-T2"; shift ;;
    --copies) COPIES=$2; shift 2 ;;
    --cache) CACHE=$2; shift 2 ;;
    --ttl) TTL=$2; shift 2 ;;
    --shared-cache) SHARED=$2; shift 2 ;;
    --caller-cache) CALLER=$2; shift 2 ;;
    --recreate-order) RECREATE_ORDER=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done

compose_file() {
  local topo=docker-compose.yaml pins="" timing="$T/docker-compose.timing.yaml" mech=""
  [ "$IMAGES" = cut ] && IMAGES="timing=${TIMING_CUT_TAG:-cut-20261101}"   # main's production build (run-fourth-pass.sh CUT_TAG)
  case "$IMAGES" in
    dev) pins="" ;;
    mech|mech=*)
      local mtag=${IMAGES#mech}; mtag=${mtag#=}; mtag=${mtag:-mech-20261101}
      local ttag=${TIMING_IMAGES_TAG:-timing-20261101} img
      pins=$STATE/images-$mtag.yaml
      { echo "# generated by timing-up.sh: block 6 - apps :$ttag, catalog/shipment/order :$mtag"; echo "services:"
        for s in address catalog discount inventory invoice media notification order payment return review shipment \
                 shoppingcart simulation tax user wishlist; do
          case " $MECH_APPS " in *" $s "*) img=misarch-kotlin/$s:$mtag ;; *) img=misarch-kotlin/$s:$ttag ;; esac
          docker image inspect "$img" >/dev/null 2>&1 || { echo "missing image $img" >&2; exit 1; }
          echo "  $s:"; echo "    image: $img"; done; } > "$pins"
      mech="$T/docker-compose.mechanisms.yaml" ;;
    timing|timing=*)
      local tag=${IMAGES#timing}; tag=${tag#=}; tag=${tag:-timing-20261101}
      pins=$STATE/images-$tag.yaml
      { echo "# generated by timing-up.sh: misarch-kotlin apps -> :$tag"; echo "services:"
        for s in address catalog discount inventory invoice media notification order payment return review shipment \
                 shoppingcart simulation tax user wishlist; do
          echo "  $s:"; echo "    image: misarch-kotlin/$s:$tag"; done; } > "$pins"
      for s in address catalog discount inventory invoice media notification order payment return review shipment \
               shoppingcart simulation tax user wishlist; do
        docker image inspect "misarch-kotlin/$s:$tag" >/dev/null 2>&1 || { echo "missing image misarch-kotlin/$s:$tag" >&2; exit 1; }
      done ;;
    *) echo "unknown --images $IMAGES" >&2; exit 2 ;;
  esac
  local f=$topo
  [ -n "$pins" ] && f="$f:$pins"
  [ "$MODE" = on ] && f="$f:$timing"
  [ -n "$mech" ] && f="$f:$mech"
  echo "$f"
}

take_lock() {
  if [ -f "$LOCK" ]; then
    if grep -q "^$LOCKTAG " "$LOCK"; then echo "STACK.lock already ours: $(cat "$LOCK")"; return 0; fi
    echo "STACK.lock held by someone else: $(cat "$LOCK")" >&2; exit 3
  fi
  if docker ps --format '{{.Names}}' | grep -q '^misarch-gateway-1$'; then
    echo "the original MiSArch stack is running" >&2; exit 3; fi
  ( set -o noclobber; echo "$LOCKTAG $PURPOSE $(date '+%F %T') $$$SHARE" > "$LOCK" ) 2>/dev/null \
    || { echo "STACK.lock appeared meanwhile: $(cat "$LOCK")" >&2; exit 3; }
  echo "STACK.lock taken: $(cat "$LOCK")"
}

release_lock() {
  if [ -f "$LOCK" ] && grep -q "^$LOCKTAG " "$LOCK"; then rm -f "$LOCK"; echo "STACK.lock released"; fi
}

# mechanism switches -> raw/state/mech-switches.env (only the given ones change; the rest keep their value, else off)
write_switches() {
  local c=false cc="" sc="" ttl=60 csh="" occ=""
  if [ -f "$SWITCHES" ]; then
    # shellcheck disable=SC1090
    . "$SWITCHES"; c=${MECH_LOCAL_COPIES:-false}; cc=${MECH_CATALOG_CACHE_TYPES:-}; sc=${MECH_SHIPMENT_CACHE_TYPES:-}
    ttl=${MECH_CACHE_TTL_S:-60}; csh=${MECH_CATALOG_CACHE_SHARED_TYPES:-}
    occ=${MECH_ORDER_CALLER_CACHE_TARGETS:-}
  fi
  case "$COPIES" in on) c=true ;; off) c=false ;; "") ;; *) echo "--copies on|off" >&2; exit 2 ;; esac
  case "$CACHE" in on) cc=ProductVariant; sc=Order ;; off) cc=""; sc="" ;; "") ;; *) echo "--cache on|off" >&2; exit 2 ;; esac
  case "$SHARED" in on) csh=ProductVariant ;; off) csh="" ;; "") ;; *) echo "--shared-cache on|off" >&2; exit 2 ;; esac
  case "$CALLER" in off) occ="" ;; "") ;; *) occ=$CALLER ;; esac
  [ -n "$TTL" ] && ttl=$TTL
  printf 'export MECH_LOCAL_COPIES=%s\nexport MECH_CATALOG_CACHE_TYPES=%s\nexport MECH_SHIPMENT_CACHE_TYPES=%s\nexport MECH_CACHE_TTL_S=%s\nexport MECH_CATALOG_CACHE_SHARED_TYPES=%s\nexport MECH_ORDER_CALLER_CACHE_TARGETS=%s\n' \
    "$c" "$cc" "$sc" "$ttl" "$csh" "$occ" > "$SWITCHES"
  # shellcheck disable=SC1090
  . "$SWITCHES"
  echo "mechanism switches: local copies=$MECH_LOCAL_COPIES, cache catalog=[$MECH_CATALOG_CACHE_TYPES] shipment=[$MECH_SHIPMENT_CACHE_TYPES], ttl=${MECH_CACHE_TTL_S}s, shared=[$MECH_CATALOG_CACHE_SHARED_TYPES], caller cache=[$MECH_ORDER_CALLER_CACHE_TARGETS]"
}

# the switches the running containers were started with, one line
running_switches() {
  local s out=""
  for s in $MECH_APPS; do
    out="$out $s:$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "misarch-kotlin-$s-1" 2>/dev/null \
      | grep -E '^MISARCH_(LOCAL_COPIES|ENTITY_CACHE_TYPES|ENTITY_CACHE_TTL_SECONDS|ENTITY_CACHE_SHARED_TYPES|CALLER_CACHE_TARGETS)=' | sort | tr '\n' ',')"
  done
  echo "$out"
}

wait_healthy() {   # the given compose services (apps have a health check)
  local i n
  for i in $(seq 1 120); do
    n=$(cd "$K" && COMPOSE_FILE=${CF:-docker-compose.yaml} docker compose ps --format '{{.Service}} {{.State}} {{.Health}}' "$@" | awk '$2!="running" || ($3!="" && $3!="healthy")' | wc -l)
    [ "$n" = 0 ] && return 0; sleep 5
  done
  echo "not healthy after 10 min: $*" >&2; return 1
}

case "$cmd" in
  compose-file) compose_file ;;
  up)
    [ "$MODE" = on ] || [ "$MODE" = off ] || { echo "--mode on|off" >&2; exit 2; }
    free=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
    [ "$free" -ge 15 ] || { echo "only ${free} GB free on / (< 15)" >&2; exit 4; }
    CF=$(compose_file)
    take_lock
    case "$IMAGES" in mech*) write_switches ;; esac
    # shellcheck disable=SC1091
    . "$C/results-kotlin/stack.env"
    mkdir -p "$T/raw/_asprof"; chmod 777 "$T/raw/_asprof"
    export TIMING_SAMPLER_ARG=$SAMPLER TIMING_OUT=$T/raw/_asprof
    if [ "$MODE" = on ]; then export TRACING=1; else export TRACING=0; fi
    echo "up: mode=$MODE images=$IMAGES sampler=$SAMPLER COMPOSE_FILE=$CF"
    (cd "$K" && COMPOSE_FILE=$CF ./up.sh)
    (cd "$K" && ./set_limits.sh k8s >/dev/null) && echo "k8s CPU limits applied"
    if [ "$MODE" = on ]; then
      for i in $(seq 1 30); do $PY "$T/harness/stackctl.py" ext > "$STATE/ext.json" 2>&1 && break; sleep 5; done
      grep -c '"ok"' "$STATE/ext.json" | xargs echo "pg_stat_statements created/present in databases:"
    fi
    echo "{\"mode\": \"$MODE\", \"images\": \"$IMAGES\", \"sampler\": \"$SAMPLER\", \"composeFile\": \"$CF\", \"t\": $(date +%s)}" > "$STATE/stack-mode.json"
    $PY "$T/harness/stackctl.py" status ;;
  down)
    CF=$(cat "$STATE/stack-mode.json" 2>/dev/null | $PY -c 'import json,sys; print(json.load(sys.stdin)["composeFile"])' 2>/dev/null || echo docker-compose.yaml)
    (cd "$K" && COMPOSE_FILE=$CF docker compose stop)
    release_lock ;;
  mech)
    MS=$STATE/stack-mode.json
    [ -f "$MS" ] && grep -q '"images": "mech' "$MS" || { echo "no --images mech stack (up --images mech first)" >&2; exit 2; }
    [ -f "$LOCK" ] && grep -q "^$LOCKTAG " "$LOCK" || { echo "STACK.lock is not ours ($LOCKTAG)" >&2; exit 3; }
    CF=$($PY -c 'import json,sys; print(json.load(open(sys.argv[1]))["composeFile"])' "$MS")
    MODE=$($PY -c 'import json,sys; print(json.load(open(sys.argv[1]))["mode"])' "$MS")
    SAMPLER=$($PY -c 'import json,sys; print(json.load(open(sys.argv[1]))["sampler"])' "$MS")
    before=$(running_switches)
    write_switches
    # shellcheck disable=SC1091
    . "$C/results-kotlin/stack.env"
    export TIMING_SAMPLER_ARG=$SAMPLER TIMING_OUT=$T/raw/_asprof
    if [ "$MODE" = on ]; then export DAPR_CONFIG=dapr-config.yaml; else export DAPR_CONFIG=dapr-config-notrace.yaml; fi
    svcs=""; for s in $MECH_APPS; do svcs="$svcs $s $s-dapr $s-ecs"; done
    # compose recreates exactly the services whose resolved config changed (here: only the three apps' env)
    (cd "$K" && COMPOSE_FILE=$CF docker compose up -d --no-deps $svcs)
    after=$(running_switches)
    if [ "$before" != "$after" ]; then
      # the sidecars share the app's network namespace: recreate them with the new app container
      (cd "$K" && COMPOSE_FILE=$CF docker compose up -d --no-deps --force-recreate $(for s in $MECH_APPS; do echo "$s-dapr $s-ecs"; done))
      wait_healthy $MECH_APPS
      (cd "$K" && ./set_limits.sh k8s >/dev/null) && echo "k8s CPU limits applied"
      echo "recreated $MECH_APPS:$after"
    elif [ "$RECREATE_ORDER" = 1 ]; then
      # after a data reset: order's database is the baseline snapshot (no V3); a fresh start lets Flyway apply V3
      (cd "$K" && COMPOSE_FILE=$CF docker compose up -d --no-deps --force-recreate order order-dapr order-ecs)
      wait_healthy order
      (cd "$K" && ./set_limits.sh k8s >/dev/null) && echo "k8s CPU limits applied"
      echo "recreated order (Flyway after the reset):$after"
    else
      echo "switches unchanged:$after"
    fi
    $PY - "$MS" "$SWITCHES" <<'PYEOF'
import json, sys
m = json.load(open(sys.argv[1]))
m["mech"] = dict(l.replace("export ", "").strip().split("=", 1) for l in open(sys.argv[2]) if "=" in l)
json.dump(m, open(sys.argv[1], "w"))
PYEOF
    ;;
  ext) $PY "$T/harness/stackctl.py" ext ;;
  reset) $PY "$T/harness/stackctl.py" reset ;;
  status) $PY "$T/harness/stackctl.py" status; echo "mechanism env:$(running_switches)"
          [ -f "$LOCK" ] && echo "STACK.lock: $(cat "$LOCK")" || echo "no STACK.lock" ;;
  *) sed -n '2,25p' "$0"; exit 2 ;;
esac
