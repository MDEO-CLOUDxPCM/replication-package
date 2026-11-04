#!/usr/bin/env bash
# The whole analysis of one pass (RESULTS.md §8): per-window caches, factorial, parts.json (with mechanisms and rate
# sensitivity), latency fit, composition checks, volumes, speed probe. Re-run windows (<pass>_rerun_off*, _rerun_on*,
# _rerun_mech_on*: run-rerun.sh) are listed after the pass's own windows, so their segments replace the disturbed
# ones (the later window of a type wins in parts.py, latency_fit.py and mechanisms.py).
#
#   timing/analysis/analyse_pass.sh [approx4]
set -euo pipefail
cd "$(dirname "$0")"
P=${1:-approx4}
W=../raw/windows
rerun() { (cd "$W" && ls -d "${P}_rerun_$1"* 2>/dev/null | grep -E "^${P}_rerun_$1[0-9]*$" || true) | sort | tr '\n' ',' | sed 's/,$//'; }
join() { local IFS=,; echo "$*"; }
OFF=$(join ${P}_off_w1 ${P}_off_w2 ${P}_off_w3 $(rerun off | tr , ' '))
ON=$(join ${P}_on_w1 ${P}_on_w2 ${P}_on_w3 $(rerun on | tr , ' '))
INSTR=$(join ${P}_mech_on_w2 $(rerun mech_on | tr , ' '))
echo "off: $OFF"; echo "on: $ON"; echo "mechanisms instrumented: $INSTR"
for w in ${ON//,/ } ${P}_fo_w1 ${P}_fo_w2 ${P}_fo_w3 ${INSTR//,/ } ${P}_mech_cc_w2; do
  python3 profile_buckets.py "$w"; python3 counters.py "$w"; done
for w in ${ON//,/ } ${P}_fo_w1 ${P}_fo_w2 ${P}_fo_w3 ${INSTR//,/ } ${P}_mech_cc_w2 ${P}_latency_w1; do
  python3 queries.py "$w"; done
for w in ${ON//,/ } ${P}_mech_on_w2; do python3 envelope.py "$w"; done
python3 factorial.py --fo ${P}_fo_w1,${P}_fo_w2,${P}_fo_w3 --iso ${P}_on_w2
PA=(--off "$OFF" --on "$ON" --atload ${P}_atload_w1)
python3 parts.py "${PA[@]}"
python3 mechanisms.py --off ${P}_mech_off_w1 --on ${P}_mech_on_w1 --instr "$INSTR" \
    --ref ${P}_off_w2,${P}_off_w3 --cc-on ${P}_mech_cc_w1 --cc-instr ${P}_mech_cc_w2
python3 sensitivity.py --mid "$OFF" --low ${P}_mech_on_w1
python3 parts.py "${PA[@]}" --mechanisms ../raw/mechanisms.json --sensitivity ../raw/sensitivity.json
python3 latency_fit.py --windows "$ON"
python3 compose_check.py --latency ${P}_latency_w1 --out ../RESULTS-checks.md --json ../raw/checks.json
ALL=$(cd "$W" && ls -d ${P}_*)
python3 volumes.py $ALL
python3 speed.py $ALL > ../raw/speed.out
