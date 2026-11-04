#!/usr/bin/env bash
# Carry the data baseline forward to new images' migrations instead of reloading it (load_baseline.py writes the
# columns those migrations drop). The snapshot was taken at misarch-kotlin 201e2e7 (the relational port: order
# V2__relational_children, wishlist V2__wishlist_product_variants, discount V1_3__atomic_coupon_usages); main has the
# squashed migrations (all 15 database services start from one V1_1__create_relations.sql), so the databases are
# converted first (conversion/README.md).
#
#   timing/data/migrate-baseline.sh [<image tag>]     default cut-20261101 (all 17 apps = main)
#
# 0. conversion (only the service databases run; STACK.lock as T3): conversion/convert.py converts every
#    <svc>_baseline template that still has the old migrations of a squashed service on a copy, verifies it (schema =
#    an empty database migrated with the new V1_1, Flyway's history row, Flyway validate) and swaps it in; the live
#    database becomes a copy, so that the apps' Flyway accepts it at start. Nothing to do if the images are not
#    squashed or the snapshot is converted already.
# 1. stack up, mode off, on the images (Flyway migrates the live databases at app start)
# 2. reset.sh --no-verify: back to the snapshot (its counts are the old tables')
# 3. harness/migrations.py apply: the images' missing migrations on the restored data (SQL from the running images)
# 4. VACUUM ANALYZE in every service database (the migrations rewrite tables)
# 5. reset.sh snapshot (new <svc>_baseline templates, baseline_counts.json, generator files), convert.py record
#    (baseline_migrations.json: the snapshot's migrations, read by run-fourth-pass.sh), then reset.sh verify
# 6. stack down
# About 15-25 min. Not during a measurement (refuses while MEASURING.lock exists).
set -euo pipefail
D=$(cd "$(dirname "$0")" && pwd)
T=$(dirname "$D")
ROOT=$(cd "$T/../../.." && pwd)   # the repository root: the locks live there
TAG=${1:-cut-20261101}
SVCS="address catalog discount inventory invoice notification order payment return review shipment shoppingcart tax user wishlist"
PY=$T/calibration/.venv/bin/python
[ -e "$ROOT/MEASURING.lock" ] && { echo "MEASURING.lock exists - not migrating the baseline now" >&2; exit 3; }
if [ -f "$ROOT/STACK.lock" ] && ! grep -q '^T3 ' "$ROOT/STACK.lock"; then
  echo "STACK.lock held by someone else: $(cat "$ROOT/STACK.lock")" >&2; exit 3; fi
[ -f "$ROOT/STACK.lock" ] || ( set -o noclobber; echo "T3 baseline migration to :$TAG $(date '+%F %T') $$" > "$ROOT/STACK.lock" ) \
  || { echo "STACK.lock appeared meanwhile: $(cat "$ROOT/STACK.lock")" >&2; exit 3; }
echo $$ > "$D/.migrating.pid"   # run-fourth-pass.sh waits while this process lives
trap '"$T/timing-up.sh" down 2>&1 | tail -2; rm -f "$D/.migrating.pid"' EXIT
CONV_SVCS=$(cd "$D/conversion" && for s in */old; do echo "${s%/old}"; done)
for s in $CONV_SVCS; do docker start "misarch-kotlin-$s-db-1" >/dev/null; done
for s in $CONV_SVCS; do
  for i in $(seq 60); do docker exec "misarch-kotlin-$s-db-1" pg_isready -U postgres -q && break; sleep 2; done
done
python3 "$D/conversion/convert.py" convert --images "$TAG"
"$T/timing-up.sh" up --mode off --images "timing=$TAG" --purpose "baseline migration to :$TAG"
bash "$D/reset.sh" reset --no-verify
$PY "$T/harness/migrations.py" apply
$PY "$T/harness/migrations.py" check
for s in $SVCS; do
  docker exec -i "misarch-kotlin-$s-db-1" psql -q -X -U postgres -d "$s" -v ON_ERROR_STOP=1 -c "VACUUM ANALYZE" \
    && echo "$s: vacuum analyze ok"
done
bash "$D/reset.sh" snapshot
python3 "$D/conversion/convert.py" record
bash "$D/reset.sh" verify
echo "baseline migrated to :$TAG and snapshotted ($(date))"
