#!/usr/bin/env bash
# Timing campaign (README.md §4): blocks 1-7 through measure.py windows (MEASURING.lock protocol) with per-segment
# hooks (pg_stat_statements reset/dump, asprof start/stop per app container, spans via harness/spans.py, cgroup totals
# via cpumon, data volume). Logic in harness/campaign.py; one window = harness/window.py.
#
#   run_campaign.sh --dry-run [--variant approx4]  schedule and estimated durations
#   run_campaign.sh [--variant approx4] [--blocks 2,7,6,3,4b,5] [--plans DIR] [--timing-tag TAG]
#                   [--reset CMD | --no-reset]
#   run_campaign.sh --detach [same options]    run unattended: setsid nohup, no TTY, stdin /dev/null; all output
#                                              to raw/campaign-<date>.out (plus raw/campaign.log); prints the pid
#   run_campaign.sh --smoke [--types product,createShoppingcartItem] [--steady 60] [--smoke-modes off,on]
#
# The stack is brought up per block by timing-up.sh (STACK.lock); take it down afterwards with `timing-up.sh down`.
set -euo pipefail
T=$(cd "$(dirname "$0")" && pwd)
PY=$T/calibration/.venv/bin/python
if [ "${1:-}" = "--detach" ]; then
  shift
  mkdir -p "$T/raw"
  OUT="$T/raw/campaign-$(date +%Y%m%d-%H%M%S).out"
  setsid nohup "$PY" -u "$T/harness/campaign.py" "$@" > "$OUT" 2>&1 < /dev/null &
  echo "campaign detached: pid $! (session leader), output $OUT, log $T/raw/campaign.log"
  exit 0
fi
exec "$PY" -u "$T/harness/campaign.py" "$@"
