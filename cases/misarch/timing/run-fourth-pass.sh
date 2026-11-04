#!/usr/bin/env bash
# The timing campaign (README.md §4, §7) on misarch-kotlin's main (images *-20261101; a baseline that predates main's
# migrations is converted and migrated first): windows approx4_* on the plans of plans/approx3/, with the domain's
# scheduled jobs excluded by construction (payment's checks every quarter hour: no firing in an idle, pre, warm or
# steady phase; a zero-load hold before a phase that would get one, calibration/scripts/cronjobs.py); blocks 2, 7, 6,
# 3, 4b, 5, about 10 h. Run it in your own terminal, ideally inside tmux/screen, NOT from a Claude session: processes started by
# Claude live in vmdev-agent.service's cgroup and are killed when that service restarts.
#
#   timing/run-fourth-pass.sh            # run (resumes: windows with a window.json are skipped)
#   timing/run-fourth-pass.sh --dry-run  # schedule and estimate only
#   timing/run-fourth-pass.sh --check    # preflight only
#
# Code: everything builds on misarch-kotlin's current `main` (MISARCH_KOTLIN_REPO, default the submodule misarch-kotlin/,
# else ../misarch-kotlin; a branch missing locally is read as origin/<branch>, as in a submodule). The
# preflight checks every image's label misarch.commit: CUT_TAG = main itself (all 17 apps, the production build; blocks
# 2 and 7, mode off), TIMING_TAG = branch timing-instrumentation (the instrumented build: spans, counters; all 17 apps;
# blocks 3, 4b, 5), MECH_TAG = branch timing-mechanisms (catalog/shipment/order; block 6, with TIMING_TAG for the other
# apps); both branches must contain main (linear on it). Images: timing/build-images.sh <commit> <tag> [<svc>...].
# No speed gate (README.md §4.2): windows run when they are due; the regime is not probed or waited for.
# Envelope vs work (README.md §6): nothing extra to run; blocks 3, 4b and 6on
# record asprof + spans + counters, which analysis/envelope.py (embedded by parts.py as `envelope`) needs. --check
# verifies that.
# Output: timing/raw/campaign-<date>.out (plus timing/raw/campaign.log); windows in timing/raw/windows/approx4_*.
# Afterwards the stack is taken down (volumes kept).
set -euo pipefail
P="$(cd "$(dirname "$0")/.." && pwd)"   # the case's root (cases/misarch): the paths below are timing/...
LOCKDIR="$(cd "$P/../.." && pwd)"   # the locks live in the repository root (README.md)
BLOCKS="${BLOCKS:-2,7,6,3,4b,5}"
CUT_TAG="${CUT_TAG:-cut-20261101}"
TIMING_TAG="${TIMING_TAG:-timing-20261101}"
MECH_TAG="${MECH_TAG:-mech-20261101}"
MK="${MISARCH_KOTLIN_REPO:-$("$LOCKDIR/core/tools/checkout.sh" misarch-kotlin)}"
SVCS="address catalog discount inventory invoice media notification order payment return review shipment shoppingcart simulation tax user wishlist"
ARGS=(--variant approx4 --blocks "$BLOCKS" --off-images "timing=$CUT_TAG" --timing-tag "$TIMING_TAG" --mech-tag "$MECH_TAG")
if [ -n "${PLANS:-}" ]; then ARGS+=(--plans "$PLANS"); fi   # another plan set, e.g. run-rerun.sh's plans/rerun4
cd "$P"
[ -f timing/local.env ] && { set -a; . timing/local.env; set +a; }   # machine-specific settings (local.env.example)

if [ "${1:-}" = "--dry-run" ]; then exec timing/run_campaign.sh --dry-run "${ARGS[@]}"; fi

# a baseline migration started elsewhere (e.g. by hand): wait for it, then check its result like any other baseline
MIG_PID=timing/data/.migrating.pid
while [ -f "$MIG_PID" ] && kill -0 "$(cat "$MIG_PID")" 2>/dev/null; do
  echo "waiting for the running baseline migration ($(date +%T))"; sleep 30; done
# ---- preflight
fail=0
err() { echo "PREFLIGHT: $*" >&2; fail=1; }
[ -e "$LOCKDIR/MEASURING.lock" ] && err "MEASURING.lock exists: $(cat "$LOCKDIR/MEASURING.lock")"
if [ -e "$LOCKDIR/STACK.lock" ] && ! grep -q '^T3 ' "$LOCKDIR/STACK.lock"; then
  err "STACK.lock held by someone else: $(cat "$LOCKDIR/STACK.lock")"; fi
pgrep -f "timing/harness/campaign.py" >/dev/null && err "a campaign is already running: $(pgrep -af timing/harness/campaign.py)"
free_gb=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
[ "$free_gb" -lt 15 ] && err "only ${free_gb} GB free on / (need 15, as timing-up.sh; a pass writes ~0.4 GB of windows)"
# every image is built from misarch-kotlin's current main (CUT_TAG) or from a branch linear on it (TIMING_TAG, MECH_TAG)
branch() { git -C "$MK" rev-parse --verify -q "$1^{commit}" || git -C "$MK" rev-parse --verify -q "origin/$1^{commit}"; }
main=$(branch main) || err "no misarch-kotlin repository with a main branch at $MK"
inst=$(branch timing-instrumentation) || err "misarch-kotlin has no branch timing-instrumentation"
mech=$(branch timing-mechanisms) || err "misarch-kotlin has no branch timing-mechanisms"
for br in timing-instrumentation:$inst timing-mechanisms:$mech; do
  git -C "$MK" merge-base --is-ancestor "$main" "${br#*:}" 2>/dev/null || err "${br%%:*} does not contain main ${main:0:7}: rebase it onto main"
  [ -z "$(git -C "$MK" rev-list --merges "$main".."${br#*:}" 2>/dev/null)" ] || err "${br%%:*} has merge commits (must be linear on main)"
done
check_tag() {   # <tag> <commit> <svc>...: every image exists and carries label misarch.commit = <commit>
  local tag=$1 want=$2 s have bad=""; shift 2
  for s in "$@"; do
    have=$(docker image inspect -f '{{index .Config.Labels "misarch.commit"}}' "misarch-kotlin/$s:$tag" 2>/dev/null || echo missing)
    [ "$have" = "missing" ] && { bad="$bad $s(missing)"; continue; }
    [ -n "$have" ] && [ "$(git -C "$MK" rev-parse --verify -q "$have^{commit}" 2>/dev/null)" = "$want" ] || bad="$bad $s(${have:0:7})"
  done
  [ -z "$bad" ] || err ":$tag must be built from ${want:0:7} - not:$bad (timing/build-images.sh ${want:0:7} $tag <svc>...)"
}
[ "$fail" = 0 ] && { check_tag "$CUT_TAG" "$main" $SVCS; check_tag "$TIMING_TAG" "$inst" $SVCS
                     check_tag "$MECH_TAG" "$mech" order catalog shipment; }
[ -f timing/plans/approx3/manifest.json ] || err "no plans: python3 timing/plans/gen_plans.py approx3 --rates timing/plans/rates.json"
[ -f timing/plans/approx3/bursts.json ] || err "no burst table: timing/plans/burst_table.py"
[ -n "${TIMING_ASPROF_DIR:-}" ] && [ -x "$TIMING_ASPROF_DIR/bin/asprof" ] || err "TIMING_ASPROF_DIR (async-profiler 4.2.1) not set or not found: copy timing/local.env.example to timing/local.env"
[ -f timing/data/baseline_counts.json ] || err "no data baseline (timing/data/README.md)"
# the snapshot must hold main's migrations: exactly (data/baseline_migrations.json, written by migrate-baseline.sh after
# its snapshot) or, without that record, main's table names (order, invoice, review, inventory, wishlist) and per
# service at least as many applied migrations as main has files, and no squashed service (its conversion is only
# recorded there) - otherwise the run migrates it first (data/migrate-baseline.sh, ~20 min; it also converts the
# databases of the squashed services, data/conversion/README.md)
baseline_schema_ok() { python3 timing/data/conversion/convert.py needs-migration --repo "$MK" --ref "$main"; }
migrate=0
baseline_schema_ok || migrate=1
# the snapshot must be the profile profile.json loads at its top level (full profile, data/README.md)
python3 - <<'PYEOF' || err "baseline_counts.json is not the loaded profile (timing/data/profile.json top level)"
import json, sys
p = json.load(open("timing/data/profile.json")); b = json.load(open("timing/data/baseline_counts.json"))
ok = b["catalog"]["productentity"] >= p["products"]["count"] and b["user"]["userentity"] >= p["users"]["count"]
print(f"baseline: {b['catalog']['productentity']} products, {b['user']['userentity']} users, "
      f"{b['order'].get('orderentity', b['order'].get('orders'))} orders (profile {p['products']['count']} / {p['users']['count']})")
sys.exit(0 if ok else 1)
PYEOF
# envelope (README.md §6): the analysis imports, and block 3 still profiles with spans (asprof + spans + counters)
python3 - <<'PYEOF' || err "envelope analysis not ready (timing/analysis/envelope.py; block 3 needs --profile --spans)"
import sys
sys.path.insert(0, "timing/analysis"); sys.path.insert(0, "timing/harness")
import envelope  # noqa: F401
import campaign
assert {"--profile", "--spans"} <= set(campaign.BLOCKS["3"][4]), campaign.BLOCKS["3"]
PYEOF
# the analyses and the scheduled-job guard read the domain model: extracted from the same main as the images, and
# the guard has crons to keep out (payment's checks)
python3 - "$main" <<'PYEOF' || err "domain model or scheduled-job guard not ready (cases/misarch/domain/misarch-domain.json at main, cronjobs.py)"
import json, sys
sys.path.insert(0, "timing/harness"); sys.path.insert(0, "timing/calibration/scripts")
import campaign, cronjobs  # noqa: F401
d = json.load(open("domain/misarch-domain.json"))["meta"]["commit"]
c = campaign.scheduled_crons()
print(f"domain at {d[:7]}; scheduled jobs kept out of the measured phases: {c}")
sys.exit(0 if d == sys.argv[1] and c else 1)
PYEOF
# the snapshot must hold every migration of the images; checked by campaign.py on the first stack up
# (migrations.py baseline): a missing one stops the pass before its first window
[ "$fail" = 0 ] || exit 1
echo "preflight ok: misarch-kotlin main ${main:0:7}: :$CUT_TAG (off) = main, :$TIMING_TAG (on) = ${inst:0:7}, :$MECH_TAG (block 6) = ${mech:0:7}; ${free_gb} GB free"
[ "$migrate" = 1 ] && echo "data baseline predates main's schema: the run migrates it first (data/migrate-baseline.sh :$CUT_TAG)"
[ "${1:-}" = "--check" ] && exit 0

out="timing/raw/campaign-$(date +%Y%m%d-%H%M%S).out"
mkdir -p timing/raw
echo "fourth pass: blocks $BLOCKS, output $out (started $(date))"
if [ "$migrate" = 1 ]; then
  echo "migrating the data baseline to :$CUT_TAG ($(date))" | tee -a "$out"
  timing/data/migrate-baseline.sh "$CUT_TAG" 2>&1 | tee -a "$out"
  baseline_schema_ok 2>&1 | tee -a "$out" \
    || { echo "baseline migration did not produce main's schema - stopping" | tee -a "$out"; exit 1; }
fi
rc=0
timing/run_campaign.sh "${ARGS[@]}" 2>&1 | tee "$out" || rc=$?
echo "campaign exit $rc ($(date))" | tee -a "$out"
timing/timing-up.sh down 2>&1 | tail -2 | tee -a "$out"
exit "$rc"
