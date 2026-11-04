#!/usr/bin/env bash
# The campaign's images (README.md §1): misarch-kotlin/<svc>:<tag> from misarch-kotlin at <commit>, labelled
# misarch.commit=<commit> (the label run-fourth-pass.sh --check reads).
#
#   timing/build-images.sh <commit> <tag> [<svc>...]     # default: all 17 apps
#
#   timing/build-images.sh d569ad9 cut-20261101                       # main
#   timing/build-images.sh b4f00b2 timing-20261101                    # timing-instrumentation
#   timing/build-images.sh db170f4 mech-20261101 order catalog shipment   # timing-mechanisms
#
# The jars are built in a detached worktree of misarch-kotlin at <commit> (build/misarch-images/wt-<tag>) with its
# tools/build.sh (Gradle; needs a JDK); the images use misarch-kotlin's tools/docker/service.Dockerfile on the base
# image misarch-kotlin/jre-base:dev. All three tags of the paper's campaign ran on base revision 4 (JRE + OpenTelemetry
# agent + the entrypoint of timing-instrumentation, whose profiler hook is off unless MISARCH_PROFILER is set), so the
# base is built from timing-instrumentation's tools whatever <commit> is (BASE_REF). Resumable: a service whose image
# already carries misarch.commit=<commit> is skipped. misarch-kotlin: MISARCH_KOTLIN_REPO, default
# core/tools/checkout.sh misarch-kotlin; a branch missing locally is read as origin/<branch>.
set -euo pipefail
T=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$T/../../.." && pwd)
MK=${MISARCH_KOTLIN_REPO:-$("$REPO/core/tools/checkout.sh" misarch-kotlin)}
COMMIT_ARG=${1:?usage: timing/build-images.sh <commit> <tag> [<svc>...]}; TAG=${2:?usage: timing/build-images.sh <commit> <tag> [<svc>...]}
shift 2
SVCS=("$@")
[ ${#SVCS[@]} -gt 0 ] || SVCS=(address catalog discount inventory invoice media notification order payment return review shipment shoppingcart simulation tax user wishlist)
B=$REPO/build/misarch-images
LOG=$B/progress.log
mkdir -p "$B"
log() { echo "[$(date '+%F %T')] $TAG: $*" | tee -a "$LOG"; }
resolve() { git -C "$MK" rev-parse --verify -q "$1^{commit}" || git -C "$MK" rev-parse --verify -q "origin/$1^{commit}"; }
COMMIT=$(resolve "$COMMIT_ARG") || { echo "misarch-kotlin at $MK has no commit $COMMIT_ARG" >&2; exit 1; }
worktree() {   # <dir> <commit>: a detached worktree of misarch-kotlin at <commit>
  [ -d "$1" ] || git -C "$MK" worktree add --detach "$1" "$2" >/dev/null
  git -C "$1" checkout -q --detach "$2"
}

# ---- the base image, from timing-instrumentation's tools (revision 4)
BASE_REF=${BASE_REF:-timing-instrumentation}
BASE_COMMIT=$(resolve "$BASE_REF") || { echo "misarch-kotlin has no $BASE_REF (BASE_REF)" >&2; exit 1; }
BWT=$B/wt-base
worktree "$BWT" "$BASE_COMMIT"
toml() { grep "^$1" "$BWT/gradle/libs.versions.toml" | sed 's/.*"\(.*\)".*/\1/'; }
OTEL_VERSION=$(toml opentelemetry-javaagent); JAVA_VERSION=$(toml 'java = ')
JRE_IMAGE="eclipse-temurin:${JAVA_VERSION}-jre"
BASE_REV=$(sed -n 's/^BASE_REV=\([0-9]*\).*/\1/p' "$BWT/tools/image.sh")
BASE_LABEL="${JRE_IMAGE}+otel-${OTEL_VERSION}+rev${BASE_REV}"
if [ "$(docker image inspect -f '{{index .Config.Labels "misarch.base"}}' misarch-kotlin/jre-base:dev 2>/dev/null || true)" != "$BASE_LABEL" ]; then
  AGENT=$B/opentelemetry-javaagent-$OTEL_VERSION.jar
  [ -f "$AGENT" ] || { curl -fsSL -o "$AGENT.tmp" \
    "https://repo1.maven.org/maven2/io/opentelemetry/javaagent/opentelemetry-javaagent/$OTEL_VERSION/opentelemetry-javaagent-$OTEL_VERSION.jar" \
    && mv "$AGENT.tmp" "$AGENT"; }
  CTX=$(mktemp -d)
  cp "$AGENT" "$CTX/opentelemetry-javaagent.jar"; cp "$BWT/tools/docker/entrypoint.sh" "$CTX/entrypoint.sh"
  docker build -q --build-arg "JRE_IMAGE=$JRE_IMAGE" --label "misarch.base=$BASE_LABEL" \
    -t misarch-kotlin/jre-base:dev -f "$BWT/tools/docker/base.Dockerfile" "$CTX" >/dev/null
  rm -rf "$CTX"
  log "base image misarch-kotlin/jre-base:dev built ($BASE_LABEL)"
fi

# ---- the services
todo=()
for s in "${SVCS[@]}"; do
  have=$(docker image inspect -f '{{index .Config.Labels "misarch.commit"}}' "misarch-kotlin/$s:$TAG" 2>/dev/null || true)
  [ "$have" = "$COMMIT" ] && { log "$s done already"; continue; }
  todo+=("$s")
done
[ ${#todo[@]} -eq 0 ] && { log "all done"; exit 0; }
WT=$B/wt-$TAG
worktree "$WT" "$COMMIT"
tasks=(); for s in "${todo[@]}"; do tasks+=(":services:$s:bootJar"); done
log "jars ${todo[*]} at $COMMIT"
"$WT/tools/build.sh" "${tasks[@]}" --quiet
for s in "${todo[@]}"; do
  CTX=$(mktemp -d)
  cp "$WT/services/$s/build/libs/app.jar" "$CTX/app.jar"
  docker build -q --label "misarch.commit=$COMMIT" --label "misarch.base.used=$BASE_LABEL" -t "misarch-kotlin/$s:$TAG" \
    -f "$WT/tools/docker/service.Dockerfile" "$CTX" >/dev/null
  rm -rf "$CTX"
  log "$s image built ($(docker image inspect -f '{{.Id}}' "misarch-kotlin/$s:$TAG" | cut -c8-19))"
done
log "all done"
