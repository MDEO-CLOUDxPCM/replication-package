#!/usr/bin/env bash
# Copies the harness (core/harness) into the worktree: the node scripts into app/arch-harness,
# the Kotlin run test into platform/optimizer's test sources.
set -euo pipefail
P="$(cd "$(dirname "$0")/../.." && pwd)"
WT="${1:-$P/build/mdeo-wt}"
mkdir -p "$WT/app/arch-harness"
cp "$P"/core/harness/*.mjs "$WT/app/arch-harness/"
cp "$P"/core/harness/*.kt "$WT/platform/optimizer/src/test/kotlin/com/mdeo/optimizer/"
