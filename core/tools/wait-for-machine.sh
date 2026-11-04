#!/usr/bin/env bash
# Machine-load protocol: before CPU-heavy
# work, wait while the MiSArch calibration measures (a MEASURING.lock in the repository root, README.md)
# and while less than ~2.5 GB RAM is available. Polls every 60 s, at most
# ARCH_WAIT_MINUTES (default 45). Never creates or deletes a lock.
MO="$(cd "$(dirname "$0")/../.." && pwd)"
MAX="${ARCH_WAIT_MINUTES:-45}"
locked() { [ -e "$MO/MEASURING.lock" ]; }
for i in $(seq 1 "$MAX"); do
    avail=$(free -m | awk '/^Mem:/ {print $7}')
    if ! locked && [ "$avail" -ge 2500 ]; then exit 0; fi
    echo "waiting: lock=$(locked && echo yes || echo no) available=${avail}MB ($i/$MAX)" >&2
    sleep 60
done
echo "machine still busy after $MAX min" >&2
exit 1
