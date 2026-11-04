#!/usr/bin/env bash
# Prepares the detached mdeo-cloud worktree of the headless harness (build/mdeo-wt), without
# touching the main checkout's working tree: node_modules links (third-party packages from the
# main checkout, @mdeo/* from the worktree), the TypeScript package build (tsconfig.build.json,
# emits to packages/*/dist), the harness files and the optimizer test classes.
#   [MDEO=/path/to/mdeo-cloud] core/harness/setup-worktree.sh
# The mdeo-cloud checkout: MDEO, else core/tools/checkout.sh mdeo-cloud if that is a git checkout, else
# build/mdeo-cloud. Where it does not exist yet, mdeo-cloud's release MDEO_TAG (default v0.2.12, the release whose
# images the platform runs, docker-compose.yaml) is cloned there and its npm packages installed (npm ci).
set -euo pipefail
P="$(cd "$(dirname "$0")/../.." && pwd)"
if [ -z "${MDEO:-}" ]; then
    MDEO="$("$P/core/tools/checkout.sh" mdeo-cloud)"
    git -C "$MDEO" rev-parse --git-dir >/dev/null 2>&1 || MDEO="$P/build/mdeo-cloud"
fi
WT="${ARCH_WT:-$P/build/mdeo-wt}"
"$P/core/tools/wait-for-machine.sh"
if [ ! -e "$MDEO" ]; then
    git clone -q --depth 1 --branch "${MDEO_TAG:-v0.2.12}" https://github.com/mde-optimiser/mdeo-cloud.git "$MDEO"
    (cd "$MDEO/app" && npm ci --no-audit --no-fund)
    export ARCH_GRADLE_OFFLINE=0   # the first Gradle build downloads the platform's dependencies
fi
if [ ! -d "$WT" ]; then
    mkdir -p "$(dirname "$WT")"
    git -C "$MDEO" worktree add "$WT" HEAD --detach
fi
if [ ! -d "$WT/app/node_modules" ]; then
    mkdir "$WT/app/node_modules"
    for e in "$MDEO"/app/node_modules/* "$MDEO"/app/node_modules/.bin; do
        n=$(basename "$e"); [ "$n" = "@mdeo" ] && continue
        ln -s "$e" "$WT/app/node_modules/$n"
    done
    mkdir "$WT/app/node_modules/@mdeo"
    for p in "$WT"/app/packages/*; do ln -s "../../packages/$(basename "$p")" "$WT/app/node_modules/@mdeo/$(basename "$p")"; done
fi
(cd "$WT/app" && npx tsc -b tsconfig.build.json)
"$P/core/harness/install-harness.sh" "$WT"
"$P/core/harness/gradle.sh" :optimizer:testClasses -q
echo "worktree ready: $WT"
