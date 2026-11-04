using "../../metamodel/architecture.mm"

// The home as a decision (DESIGN.md AB38, AB41), before the plan: every call of a Home (Home.calls) runs to the
// chosen option, whatever its mechanism. A call's applied option is RealisedCall.home (the written one at first).
// While it is not the chosen one, the call is taken apart (../realise.mt: the pseudo shape `retarget` removes its
// blocks and its structure), put back to the written option, then re-targeted to the chosen one: its provider
// (logical and current), a derived role to the option's assembly, the signature of the same name on the option's
// interface, and the call site's stepService, joinedService and providerSchema. The plan then gives the call the
// shape its mechanism needs against the new target (async, sync step, in-transaction, orchestrated step, a
// gateway's plain call), so the home and the mechanism are two independent decisions. A function of the decisions
// only: a change between two alternatives passes through the written option in the same run.

// A Home's call without an applied option: the written one (the call as written).
for match {
    hiCall: RealisedCall { }
    hiAction: ExternalCallAction { }
    hiHome: Home { }
    hiWritten: HomeOption { }
    hiCall.action -- hiAction
    hiHome.calls -- hiAction
    hiHome.written -- hiWritten
    forbid applied {
        hiOption: HomeOption { }
        hiCall.home -- hiOption
    }
    forbid appliedWritten {
        hiCall.home -- hiWritten
    }
    create hiCall.home -- hiWritten
} do {
}

// A Home's call whose applied option is not the chosen one: taken apart first.
for match {
    hmCall: RealisedCall {
        shape != "retarget"
        shape = "retarget"
    }
    hmAction: ExternalCallAction { }
    hmHome: Home { }
    hmApplied: HomeOption { }
    hmChosen: HomeOption { }
    hmCall.action -- hmAction
    hmHome.calls -- hmAction
    hmCall.home -- hmApplied
    hmHome.home -- hmChosen
    forbid current {
        hmCall.home -- hmChosen
    }
} do {
}
