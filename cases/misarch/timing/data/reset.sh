#!/usr/bin/env bash
# Data baseline of the timing campaign: snapshot and per-window reset (README.md).
#
#   reset.sh snapshot   after load_baseline.py: CREATE DATABASE <svc>_baseline TEMPLATE <svc> in each of the 15 service
#                       Postgres containers (the apps' connections are cut for a moment), copy the generator files
#                       (seed state, setup.json, pools.json, pools-ext.json) to baseline/, write baseline_counts.json
#   reset.sh            restore the baseline (stack up, apps stay up; never during a window):
#                       1. per service, one after the other (parallel CREATE DATABASE crashed 5 of 15 Postgres
#                          servers once - backends got SIGQUIT, exit code 2; sequential takes < 1 s per database): CREATE DATABASE <svc>_new TEMPLATE <svc>_baseline (file copy) ->
#                          DROP DATABASE <svc> WITH (FORCE) -> RENAME <svc>_new TO <svc>; the apps' R2DBC pools
#                          reconnect to the restored database
#                       2. Keycloak: delete every user except the pool (gatling, buyer*, fbuyer*) (kc_clean.py)
#                       3. the generators' files back to the baseline's (state.json, setup.json, pools.json, pools-ext.json)
#                       4. Redis: trim acknowledged stream entries; pg_stat_statements again if the stack runs --mode on
#                       5. check: every app answers, row counts = baseline_counts.json (--no-verify skips the counts)
#   reset.sh verify     only step 5
#
# Not reset: RustFS objects (uploadMedia adds a few per window; no measured request lists or reads media), Keycloak's
# in-memory sessions, the JVMs' state. Requires STACK.lock to be held by the caller and no MEASURING.lock.
set -euo pipefail
D=$(cd "$(dirname "$0")" && pwd)
T=$(dirname "$D")
ROOT=$(cd "$T/../../.." && pwd)   # the repository root (T = cases/misarch/timing); the locks live there
K=${MISARCH_KOTLIN_REPO:-$("$ROOT/core/tools/checkout.sh" misarch-kotlin)}
CAL=$T/calibration
PY=$CAL/.venv/bin/python
B=$D/baseline
SVCS="address catalog discount inventory invoice notification order payment return review shipment shoppingcart tax user wishlist"
FILES="$CAL/results-kotlin/seed/state.json:seed-state.json $T/state/setup.json:setup.json $CAL/results-kotlin/pools.json:pools.json $T/state/pools-ext.json:pools-ext.json"
cmd=${1:-reset}; VERIFY=1
[ "${2:-}" = "--no-verify" ] && VERIFY=0

pg() { docker exec -i "misarch-kotlin-$1-db-1" psql -q -X -U postgres -d postgres -v ON_ERROR_STOP=1 -tA; }

[ -f "$ROOT/MEASURING.lock" ] && { echo "MEASURING.lock exists - not touching the stack" >&2; exit 3; }

restarts() {   # "<app>=<restart count> ..." of the 17 apps
  for c in $(docker ps --format '{{.Names}}' | grep -E '^misarch-kotlin-[a-z]+-1$'); do
    echo -n "$c=$(docker inspect -f '{{.RestartCount}}' "$c") "; done
}

fix_restarted() {   # an app that restarted during the reset (e.g. payment halts on an unhandled DB error, as the
  # NestJS original does) left its -dapr/-ecs sidecars in the old network namespace: recreate them
  local before=" $1" now c svc CF
  now=$(restarts)
  for c in $now; do
    if ! echo "$before" | grep -q " $c"; then
      svc=${c%%=*}; svc=${svc#misarch-kotlin-}; svc=${svc%-1}
      echo "app $svc restarted during the reset: recreating $svc-dapr $svc-ecs"
      CF=$(python3 -c "import json;print(json.load(open('$T/raw/state/stack-mode.json'))['composeFile'])")
      ( cd "$K/deploy/compose" && set -a && . "$CAL/results-kotlin/stack.env" && set +a \
        && DAPR_CONFIG=$(grep -q '"mode": "on"' "$T/raw/state/stack-mode.json" && echo dapr-config.yaml || echo dapr-config-notrace.yaml) \
           COMPOSE_FILE=$CF docker compose up -d --no-deps --force-recreate "$svc-dapr" "$svc-ecs" \
        && ./set_limits.sh k8s >/dev/null )
      verify || true
    fi
  done
}

heal() {   # every app's R2DBC pool still holds connections to the dropped database: 24 concurrent GET /health
  # (ConnectionFactoryHealthIndicator validates a pooled connection; size 10) per round replace them before any load
  # reaches the app (payment halts the JVM on an unhandled DB error, as the original's NestJS code does). Until 2 clean
  # rounds per app. Only these 8 apps' /health checks the database (the others answer an empty or constant 200);
  # the others are healed by verify's GraphQL rounds.
  local c
  for c in $(docker ps --format '{{.Names}}' | grep -E '^misarch-kotlin-[a-z]+-1$' | grep -E 'kotlin-(address|catalog|discount|notification|return|shipment|tax|user)-1$'); do
    ( clean=0; bad=0
      for r in $(seq 1 30); do
        n=$(docker exec "$c" sh -c 'for i in $(seq 24); do (wget -qO- http://localhost:8080/health 2>/dev/null | grep -q "\"UP\"" || echo x) & done; wait' | grep -c x || true)
        bad=$((bad + n)); if [ "$n" = 0 ]; then clean=$((clean + 1)); else clean=0; fi
        [ "$clean" -ge 2 ] && break; sleep 1
      done
      [ "$bad" -gt 0 ] && echo "  $c: $bad failed health checks while the pool reconnected" ) &
  done
  wait
}

verify() {
  local t0=$SECONDS bad=0 s
  heal
  # every app reconnects: one query through the gateway per service family (anonymous + admin token)
  CAL="$CAL" $PY - <<'EOF' || bad=1
import asyncio, os, sys
sys.path.insert(0, os.path.join(os.environ["CAL"], "scripts"))
import mclient
Q = ["{ products(first: 1) { totalCount } }", "{ categories(first: 1) { totalCount } }",
     "{ shipmentMethods(first: 1) { totalCount } }", "{ taxRates(first: 1) { totalCount } }",
     "{ users(first: 1) { totalCount } }", "{ currentUser { id addresses { totalCount } paymentInformations { totalCount } "
     "orders(first: 1) { totalCount } wishlists { totalCount } notifications(first: 1) { totalCount } "
     "shoppingcart { shoppingcartItems { totalCount } } reviews { totalCount } } }",
     "{ productItems(first: 1) { totalCount } }",
     "{ currentUser { coupons(first: 1) { totalCount } discountUsages(first: 1) { totalCount } "
     "orders(first: 2) { nodes { id invoice { id } shipments { totalCount } } } } }"]
async def main():
    async with mclient.new_session(limit=8) as s:
        tok = await mclient.user_token(s, "gatling")
        # 16 concurrent copies of each query per round touch every pooled connection (R2DBC pool size 10), so the
        # connections to the dropped databases are replaced now and not in the next window; 3 clean rounds in a row
        async def one(q):
            try:
                d, err, _, _ = await mclient.gql(s, q, None, tok, raise_errors=False)
                # Order.invoice (non-null) of gatling's PENDING history order fails: it has no invoice, as in the real
                # saga; the invoice app answered from its database, so it is reconnected (any message text)
                err = [e for e in err or [] if (e.get("path") or [None])[-1] != "invoice"
                       and "not found" not in str(e.get("message", ""))]
                return f"{q[:40]}: {str(err)[:120]}" if err else None
            except Exception as e:
                return f"{q[:40]}: {e}"
        clean, nerr = 0, 0
        for i in range(90):
            errs = [e for e in await asyncio.gather(*(one(q) for q in Q for _ in range(16))) if e]
            nerr += len(errs)
            clean = 0 if errs else clean + 1
            if clean >= 3:
                print(f"apps answer ({i + 1} rounds, {nerr} failed requests while the pools reconnected)"); return 0
            await asyncio.sleep(1)
        print("apps still failing:", errs[:3]); return 1
sys.exit(asyncio.run(main()))
EOF
  if [ "$VERIFY" = 1 ]; then
    $PY "$D/check_baseline.py" --no-checks --compare "$D/baseline_counts.json" || bad=1
  fi
  echo "verify: $((SECONDS - t0)) s"
  return $bad
}

case "$cmd" in
  snapshot)
    t0=$SECONDS
    for s in $SVCS; do
      ( pg "$s" <<EOF
ALTER DATABASE "$s" ALLOW_CONNECTIONS false;
SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE datname = '$s' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS "${s}_baseline";
CREATE DATABASE "${s}_baseline" TEMPLATE "$s" STRATEGY FILE_COPY;
ALTER DATABASE "$s" ALLOW_CONNECTIONS true;
ALTER DATABASE "${s}_baseline" ALLOW_CONNECTIONS false;
EOF
        echo "$s snapshot ok" )
    done
    mkdir -p "$B"
    for f in $FILES; do cp "${f%%:*}" "$B/${f##*:}"; done
    $PY "$D/check_baseline.py" --no-checks --counts "$D/baseline_counts.json"
    echo "snapshot: $((SECONDS - t0)) s; sizes:"
    for s in $SVCS; do echo "  $s $(echo "SELECT pg_size_pretty(pg_database_size('${s}_baseline'))" | pg "$s")"; done
    ;;
  reset)
    t0=$SECONDS
    restarts_before=$(restarts)
    for s in $SVCS; do
      ( pg "$s" <<EOF
DROP DATABASE IF EXISTS "${s}_new";
CREATE DATABASE "${s}_new" TEMPLATE "${s}_baseline" STRATEGY FILE_COPY;
DROP DATABASE "$s" WITH (FORCE);
ALTER DATABASE "${s}_new" RENAME TO "$s";
EOF
      ) || { echo "restore of $s failed" >&2; exit 1; }
    done
    echo "databases restored: $((SECONDS - t0)) s"
    MISARCH_STACK=kotlin $PY "$D/kc_clean.py" | tail -1
    for f in $FILES; do cp "$B/${f##*:}" "${f%%:*}"; done
    MISARCH_STACK=kotlin $PY "$CAL/scripts/redisq.py" trim >/dev/null 2>&1 || true
    if docker exec misarch-kotlin-order-db-1 psql -U postgres -tAc "SHOW shared_preload_libraries" | grep -q pg_stat_statements; then
      $PY "$T/harness/stackctl.py" ext >/dev/null && echo "pg_stat_statements re-created (--mode on)"
    fi
    echo "restore: $((SECONDS - t0)) s"
    rc=0; verify || rc=$?
    fix_restarted "$restarts_before"
    echo "reset total: $((SECONDS - t0)) s"
    exit $rc
    ;;
  verify) verify ;;
  *) sed -n '2,22p' "$0"; exit 2 ;;
esac
