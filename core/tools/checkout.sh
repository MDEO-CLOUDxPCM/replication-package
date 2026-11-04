#!/usr/bin/env bash
# Prints where a repository this one builds on is checked out: the submodule <name>/ at the top of this repository
# when it is checked out (not empty), else the checkout ../<name> beside it.
#   core/tools/checkout.sh misarch-kotlin|palladio-sim-service|mdeo-cloud
set -euo pipefail
P="$(cd "$(dirname "$0")/../.." && pwd)"
n=${1:?usage: core/tools/checkout.sh <name>}
if [ -d "$P/$n" ] && [ -n "$(ls -A "$P/$n")" ]; then echo "$P/$n"; else echo "$(dirname "$P")/$n"; fi
