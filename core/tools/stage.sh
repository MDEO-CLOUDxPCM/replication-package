# Sourced by the entry points that work on the MDEO project (P: the repository root): PROJ is the staged
# project root of the case ARCH_CASE (default misarch; core/tools/stage_project.py), staged now unless ARCH_PROJECT
# names one already (a caller staged it). Exported as ARCH_PROJECT, so that the tools this one calls work on the
# same root without staging again.
if [ -n "${ARCH_PROJECT:-}" ]; then
    PROJ="$ARCH_PROJECT"
else
    PROJ="$(python3 "$P/core/tools/stage_project.py" --case "${ARCH_CASE:-misarch}")"
fi
export ARCH_PROJECT="$PROJ"
