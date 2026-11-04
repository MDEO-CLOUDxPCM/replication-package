#!/usr/bin/env bash
# Gradle in the harness worktree's platform/: offline (ARCH_GRADLE_OFFLINE=0: online, for the first
# build on a machine), at most 2 workers, a 1.5 GB build JVM, Kotlin compiled in it, no daemon left behind.
set -euo pipefail
P="$(cd "$(dirname "$0")/../.." && pwd)"
WT="${ARCH_WT:-$P/build/mdeo-wt}"
"$P/core/tools/wait-for-machine.sh"
cd "$WT/platform"
OFFLINE=--offline; [ "${ARCH_GRADLE_OFFLINE:-1}" = 0 ] && OFFLINE=
exec ./gradlew $OFFLINE --no-daemon -Dorg.gradle.workers.max=2 -Dorg.gradle.parallel=false \
    -Dorg.gradle.jvmargs=-Xmx1536m -Dkotlin.compiler.execution.strategy=in-process "$@"
