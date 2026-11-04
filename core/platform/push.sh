#!/usr/bin/env bash
# Puts the paper's runs into an mdeo project through its git endpoint (docs/platform.md): the configs
# (default: optimize/domain/today-3obj-5sim.config and perclass-3obj-5sim.config) and every file they reach
# (core/platform/closure.py: metamodels, the realised seeds, transformations, metrics.fn), nothing else. The
# project then holds exactly these files and the platform's own project.mdeo; any other file is removed. After the
# push, a fresh clone is compared byte by byte with the staged files.
#
#   USER_NAME=... PASSWORD=... core/platform/push.sh <project id> [<base url, default http://localhost:8080>]
#   CONFIGS="optimize/domain/a.config ..."   other configs (project paths)
#
# The files come from the staged project of the case ARCH_CASE (default misarch; core/tools/stage_project.py).
# The clone is build/platform/project-git-<project id> (PUSH_DIR for another directory); the credentials are passed
# per command and never written into it.
set -euo pipefail
P="$(cd "$(dirname "$0")/../.." && pwd)"
id="$1"; base="${2:-http://localhost:8080}"
: "${USER_NAME:?USER_NAME (the platform user) not set}" "${PASSWORD:?PASSWORD not set}"
CONFIGS="${CONFIGS:-optimize/domain/today-3obj-5sim.config optimize/domain/perclass-3obj-5sim.config}"
dir="${PUSH_DIR:-$P/build/platform/project-git-$id}"
url="$base/git/$id.git"
auth="http.extraHeader=Authorization: Basic $(printf '%s:%s' "$USER_NAME" "$PASSWORD" | base64 -w0)"
git_() { git -c "$auth" "$@"; }
. "$P/core/tools/stage.sh"

# shellcheck disable=SC2086
files=$(cd "$PROJ" && python3 "$P/core/platform/closure.py" $CONFIGS)
if [ -d "$dir/.git" ]; then git_ -C "$dir" pull -q --ff-only; else git_ clone -q "$url" "$dir"; fi
cd "$dir"
other=$(git ls-files | grep -vxF -e project.mdeo -f <(echo "$files") || true)
if [ -n "$other" ]; then
    echo "removing $(echo "$other" | wc -l) files that the configs do not reach:"; echo "$other" | sed 's/^/  /'
    echo "$other" | xargs git rm -q --
fi
while read -r f; do mkdir -p "$(dirname "$f")"; cp "$PROJ/$f" "$f"; done <<< "$files"
echo "$files" | xargs git add --
if git diff --cached --quiet; then
    echo "nothing to push"
else
    git -c user.name=mdeo -c user.email=mdeo@localhost commit -qm "Files of $(echo $CONFIGS | xargs -n1 basename | tr '\n' ' ')from architecture-optimization $(git -C "$P" rev-parse --short HEAD)"
    git_ push -q origin HEAD
    git log --oneline -1
fi

# the check: a fresh clone holds exactly the staged files (and project.mdeo), byte for byte
check="$(mktemp -d)"; trap 'rm -rf "$check"' EXIT
git_ clone -q "$url" "$check/p"
diff <(cd "$check/p" && git ls-files | grep -vx project.mdeo | sort) <(echo "$files" | sort) \
    || { echo "the project's files differ from the configs' closure"; exit 1; }
while read -r f; do cmp -s "$check/p/$f" "$PROJ/$f" || { echo "differs from the staged file: $f"; exit 1; }; done <<< "$files"
echo "checked: $(echo "$files" | wc -l) files identical to the staged project ($(git -C "$check/p" rev-parse --short HEAD))"
