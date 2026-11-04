#!/usr/bin/env bash
# Synthetic test of convert.py on ONE throwaway postgres:16 container (never the stack, never the real snapshot):
# per service (all 15) a database at the snapshot's schema (misarch-kotlin main 201e2e7 = the first migrations of
# <svc>/old, applied by the Flyway CLI), a few rows written with that schema (seed/<svc>.sql), a <svc>_baseline
# template as reset.sh snapshot makes it; then convert.py against the new migrations of a misarch-kotlin ref, the
# checks of check/<svc>.sql on the converted data, a second run (no-op), two failure cases (data the conversion
# rejects, an unknown history: nothing may change), the earlier squashed state (<svc>/squashed/ -> restyle.sql) and
# record / needs-migration.
#
#   conversion/test/run.sh <misarch-kotlin checkout> <ref with the squashed migrations>
set -euo pipefail
H=$(cd "$(dirname "$0")/.." && pwd)
ROOT=$(cd "$H/../../../../.." && pwd)
REPO=${1:?misarch-kotlin checkout}; REF=${2:?ref}
FLYWAY_IMAGE=${FLYWAY_IMAGE:-flyway/flyway:13.10.0}
C=convtest-pg
SVCS="address catalog discount inventory invoice notification order payment return review shipment shoppingcart tax user wishlist"
N=15
# the snapshot's versions (main 201e2e7)
declare -A SNAP=([invoice]=2 [order]=2 [review]=2 [shoppingcart]=1 [wishlist]=2 [inventory]=2 [payment]=2
                 [address]=1.3 [catalog]=1.6 [discount]=1.3 [notification]=1.2 [return]=1.2 [shipment]=1.7 [tax]=1.1 [user]=1.2)
[ -e "$ROOT/MEASURING.lock" ] && { echo "MEASURING.lock exists - not now" >&2; exit 3; }
docker image inspect "$FLYWAY_IMAGE" >/dev/null || { echo "docker pull $FLYWAY_IMAGE first" >&2; exit 2; }
TMP=$(mktemp -d)
cleanup() { docker rm -f $C >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
docker run --rm -d --name $C -e POSTGRES_PASSWORD=postgres postgres:16 >/dev/null
for i in $(seq 60); do docker exec $C pg_isready -U postgres -q 2>/dev/null && break; sleep 1; done; sleep 2
psqlc() { docker exec -i $C psql -q -X -U postgres -v ON_ERROR_STOP=1 -tA "$@"; }
CONV() { python3 "$H/convert.py" "$@" --db-container $C --repo "$REPO" --ref "$REF"; }
ok() { echo "  ok: $*"; }
die() { echo "  FAILED: $*" >&2; exit 1; }

snapshot_db() {   # <svc> [extra sql] [migration dir] [target] [seed file]: the snapshot-state database, rows, template
  local s=$1 dir=${3:-$H/$1/old} target=${4:-${SNAP[$1]}} seed=${5:-$H/test/seed/$1.sql}
  psqlc -d postgres -c "SET client_min_messages = warning" -c "DROP DATABASE IF EXISTS \"${s}_baseline\"" -c "DROP DATABASE IF EXISTS \"$s\" WITH (FORCE)" -c "CREATE DATABASE \"$s\""
  docker run --rm --network container:$C -v "$dir":/flyway/sql:ro "$FLYWAY_IMAGE" -q \
    -url=jdbc:postgresql://localhost:5432/$s -user=postgres -password=postgres -locations=filesystem:/flyway/sql \
    -target="$target" migrate >/dev/null
  psqlc -d "$s" < "$seed"
  [ -n "${2:-}" ] && psqlc -d "$s" -c "$2"
  psqlc -d postgres -c "CREATE DATABASE \"${s}_baseline\" TEMPLATE \"$s\" STRATEGY FILE_COPY" \
    -c "ALTER DATABASE \"${s}_baseline\" ALLOW_CONNECTIONS false"
}
hist() { psqlc -d "$1" -c "SELECT string_agg(version || ':' || script || ':' || checksum, ' ' ORDER BY installed_rank) FROM flyway_schema_history"; }

echo "== snapshot-state databases (versions ${SNAP[*]})"
for s in $SVCS; do snapshot_db "$s"; done
CONV status | tee "$TMP/status"
[ "$(grep -c ': old$' "$TMP/status")" = $N ] && ok "all $N old" || die "status"

echo "== failure 1: an invoice whose address snapshot has no UUID _id (the conversion's V3 pre-check)"
psqlc -d postgres -c "DROP DATABASE invoice_baseline"
snapshot_db invoice "INSERT INTO invoices VALUES (gen_random_uuid(), gen_random_uuid(), now(), 'c', '{\"_id\": \"x\"}', '{\"_id\": \"x\"}', NULL)"
h0=$(hist invoice)
if CONV convert --services invoice; then die "accepted"; fi
[ "$(hist invoice)" = "$h0" ] && ok "live database unchanged" || die "live changed"
CONV status --services invoice | grep -q ': old$' && ok "template unchanged" || die "template changed"
psqlc -d postgres -c "SELECT datname FROM pg_database WHERE datname LIKE 'invoice_%'" | grep -qv '^invoice_baseline$' && die "leftover database" || ok "no leftover databases"
snapshot_db invoice

echo "== failure 2: an unknown history (a changed checksum)"
psqlc -d postgres -c "DROP DATABASE shoppingcart_baseline"
snapshot_db shoppingcart "UPDATE flyway_schema_history SET checksum = checksum + 1"
if CONV convert --services shoppingcart; then die "accepted"; fi
{ CONV status --services shoppingcart || true; } | grep -q ': unknown' && ok "reported unknown, unchanged" || die "not unknown"
snapshot_db shoppingcart

echo "== conversion"
CONV convert | tee "$TMP/convert"
[ "$(grep -c ': converted (' "$TMP/convert")" = $N ] && ok "$N converted" || die "convert"
for s in $SVCS; do
  [ "$(psqlc -d postgres -c "SELECT datallowconn FROM pg_database WHERE datname = '${s}_baseline'")" = f ] || die "$s template allows connections"
  [ "$(hist "$s")" = "1.1:V1_1__create_relations.sql:$(python3 -I -c "import sys; sys.path.insert(0, '$H/../../harness'); import migrations; print(migrations.flyway_checksum(sys.stdin.read()))" < <(git -C "$REPO" show "$REF:services/$s/src/main/resources/db/migration/V1_1__create_relations.sql"))" ] || die "$s history"
  psqlc -d "$s" < "$H/test/check/$s.sql" || die "$s: data checks"; ok "$s: data checks"
done

echo "== second run: nothing to do"
CONV convert | tee "$TMP/again"
[ "$(grep -c ': converted$' "$TMP/again")" = $N ] && ok "$N already converted" || die "second run"

echo "== the earlier squashed V1_1 of invoice and wishlist (restyle.sql)"
for s in invoice wishlist; do
  psqlc -d postgres -c "DROP DATABASE ${s}_baseline"
  snapshot_db "$s" "" "$H/$s/squashed" 1.1 "$H/test/seed/$s-squashed.sql"
done
CONV convert --services invoice,wishlist | tee "$TMP/restyle"
[ "$(grep -c ': converted (no old migrations + restyle.sql' "$TMP/restyle")" = 2 ] && ok "2 restyled" || die "restyle"
for s in invoice wishlist; do psqlc -d "$s" < "$H/test/check/$s-squashed.sql" || die "$s: restyle data checks"; ok "$s: restyle data checks"; done

echo "== record / needs-migration"
echo '{}' > "$TMP/counts.json"
CONV_NO_REPO() { python3 "$H/convert.py" "$@" --db-container $C; }
CONV_NO_REPO record "$TMP/rec.json" --services "${SVCS// /,}" --counts "$TMP/counts.json" >/dev/null
CONV needs-migration --services "${SVCS// /,}" --record "$TMP/rec.json" --counts "$TMP/counts.json" && ok "up to date with $REF" || die "needs-migration"
if python3 "$H/convert.py" needs-migration --repo "$REPO" --ref 786f33c --services "${SVCS// /,}" --record "$TMP/rec.json" \
   --counts "$TMP/counts.json"; then die "786f33c accepted"; else ok "differs from 786f33c (old set)"; fi
echo '{"x": 1}' > "$TMP/counts.json"
if CONV needs-migration --services "${SVCS// /,}" --record "$TMP/rec.json" --counts "$TMP/counts.json"; then die "stale record accepted"; else ok "stale record ignored"; fi
echo "all ok"
