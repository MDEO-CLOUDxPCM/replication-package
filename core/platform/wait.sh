#!/bin/bash
# waits until no execution of the project is submitted/running; logs the states
cd "$(dirname "$0")"
while true; do
  s=$(node status.mjs 2>/dev/null | awk '{print $2}' | sort | uniq -c | tr '\n' ' ')
  echo "$(date +%T) $s" >> wait.log
  case "$s" in *submitted*|*running*|*queued*|*pending*|*initializing*) sleep 20;; *) echo "$s"; break;; esac
done
