using "../../../metamodel/architecture.mm"

// Set one call site's mechanism to `target` (DESIGN.md M1): only if the site allows it and does not
// have it yet. Fails, before any change, otherwise (so callers use `if call`); `previous` is the
// mechanism it had (for the layer-3 repair, DESIGN.md H19).
in site: CallSite
in target: Mechanism
out previous: Mechanism

match {
    site { }
    target { }
    smCurrent: Mechanism { }

    site.allowed -- target

    delete site.mechanism -- smCurrent
    create site.mechanism -- target

    forbid unchanged {
        site.mechanism -- target
    }

    previous = smCurrent
}
