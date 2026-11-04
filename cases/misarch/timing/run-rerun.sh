#!/usr/bin/env bash
# Re-run of the pass's disturbed segments (host-side slow episodes, README.md §4.2, RESULTS.md): the same
# flow as run-fourth-pass.sh (preflight, images *-20261101, scheduled-job guard, bursts, data reset, counters, stack
# down at the end) on the plans of plans/rerun_plans.py (plans/rerun4/approx3/):
#   approx4_rerun_off      products, products.anon (off_w1), address.createUserAddress (off_w3)
#   approx4_rerun_off2     product (off_w1: its baseline and a third of its steady in the 10:00 episode)
#   approx4_rerun_on       user.updateUser, adminUpdateProduct, catalog.updateProductVariant, registration,
#                          createShoppingcartItem, createOrder, placeOrder (on_w2)
#   approx4_rerun_mech_on  wishlistView.hot/.cold, discount.createDiscount/.updateDiscount (mech_on_w2; --with-mech)
# Run it in your own terminal (tmux/screen), NOT from a Claude session (vmdev-agent.service's cgroup).
#
#   timing/run-rerun.sh [--with-mech]             # run (resumes: windows with a window.json are skipped)
#   timing/run-rerun.sh [--with-mech] --dry-run   # schedule and estimate only
#   timing/run-rerun.sh --check                   # preflight only
#
# The approx4_* windows of the pass stay as they are; the analysis lists a re-run window last in --off / --on, so its
# types replace the disturbed ones (parts.py: the later window of a type wins).
set -euo pipefail
T="$(cd "$(dirname "$0")" && pwd)"
mech=0
args=()
for x in "$@"; do
  case "$x" in
    --with-mech) mech=1 ;;
    *) args+=("$x") ;;
  esac
done
python3 "$T/plans/rerun_plans.py" --out "$T/plans/rerun4"
# only the blocks that still have a window without window.json (no stack start for finished blocks)
blocks=$(python3 - "$T" "$mech" <<'PYEOF'
import json, os, sys
t, mech = sys.argv[1], sys.argv[2] == "1"
key = {"2": "2", "3": "3", "6": "6on"}
todo = []
for w in json.load(open(os.path.join(t, "plans/rerun4/approx3/manifest.json")))["windows"]:
    b = key[str(w["block"])]
    if (b != "6on" or mech) and b not in todo and \
            not os.path.exists(os.path.join(t, "raw/windows", f"approx4_{w['name']}", "window.json")):
        todo.append(b)
print(",".join(todo))
PYEOF
)
if [ -z "$blocks" ]; then echo "every re-run window is done (raw/windows/approx4_rerun_*)"; exit 0; fi
echo "re-run blocks with open windows: $blocks"
BLOCKS="$blocks" PLANS="$T/plans/rerun4" exec "$T/run-fourth-pass.sh" "${args[@]}"
