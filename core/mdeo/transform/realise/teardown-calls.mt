using "../../metamodel/architecture.mm"

// The removals of the realisation at calls (DESIGN.md B3), after the plan and the removal of
// stale middleware blocks: every structure a call has (`built`) but should no longer have
// (`shape`) is taken apart, innermost first, so that the call is back in place as written before
// the additions build what its shape needs. None of these statements finds a middleware block:
// the call's blocks were keyed by its old shape and are gone. Only needed while some call's
// `built` differs from its `shape` (the callers guard it).

// The cache as built (CallSite.cachedService, DESIGN.md AB33.1): the call's own operation again.
while match {
    tqCall: RealisedCall {
        built == "composedCache"
    }
    tqAction: ExternalCallAction { }
    tqSite: CallSite { }
    tqCached: OperationSignature { }
    tqService: OperationSignature { }
    tqCall.action -- tqAction
    tqCall.site -- tqSite
    tqSite.cachedService -- tqCached
    delete tqAction.calledService -- tqCached
    create tqAction.calledService -- tqService
    delete tqCall.originalService -- tqService
    where tqCall.built != tqCall.shape
} do {
}

// A federation fetch (CallSite.fetchService, DESIGN.md AB43): the field's own operation again.
while match {
    twCall: RealisedCall {
        built == "composed"
    }
    twAction: ExternalCallAction { }
    twSite: CallSite { }
    twFetch: OperationSignature { }
    twService: OperationSignature { }
    twCall.action -- twAction
    twCall.site -- twSite
    twSite.fetchService -- twFetch
    delete twAction.calledService -- twFetch
    create twAction.calledService -- twService
    delete twCall.originalService -- twService
    where twCall.built != twCall.shape
} do {
}

// In the caller's transaction (CallSite.joinedService, DESIGN.md AB37): the step form again.
while match {
    tjCall: RealisedCall {
        built == "joined"
    }
    tjAction: ExternalCallAction { }
    tjSite: CallSite { }
    tjJoined: OperationSignature { }
    tjService: OperationSignature { }
    tjCall.action -- tjAction
    tjCall.site -- tjSite
    tjSite.joinedService -- tjJoined
    delete tjAction.calledService -- tjJoined
    create tjAction.calledService -- tjService
    delete tjCall.originalService -- tjService
    where tjCall.built != tjCall.shape
} do {
}

// The demand of a cache hit.
while match {
    thCall: RealisedCall { }
    thHit: InternalAction { }
    delete thDemand: ParametricResourceDemand { }
    delete thRealised: RealisedDemand { }
    thCall.hit -- thHit
    delete thHit.resourceDemand -- thDemand
    delete thRealised.demand -- thDemand
    where thCall.built != thCall.shape
} do {
}

// A cache branch: the call goes back in its place, the anchor is the call again.
while match {
    tcCall: RealisedCall { }
    tcAction: ExternalCallAction { }
    tcBehaviour: ResourceDemandingBehaviour { }
    tcBefore: AbstractAction { }
    tcAfter: AbstractAction { }
    delete tcBranch: BranchAction { }
    delete tcHitTransition: ProbabilisticBranchTransition { }
    delete tcMissTransition: ProbabilisticBranchTransition { }
    delete tcHitBody: ResourceDemandingBehaviour { }
    delete tcMissBody: ResourceDemandingBehaviour { }
    delete tcHitStart: StartAction { }
    delete tcHitStop: StopAction { }
    delete tcMissStart: StartAction { }
    delete tcMissStop: StopAction { }
    delete tcHit: InternalAction { }
    tcCall.action -- tcAction
    delete tcCall.wrapper -- tcBranch
    delete tcCall.hit -- tcHit
    delete tcBehaviour.steps -- tcBranch
    delete tcBefore.successor -- tcBranch
    delete tcBranch.successor -- tcAfter
    delete tcBranch.branches -- tcHitTransition
    delete tcBranch.branches -- tcMissTransition
    delete tcHitTransition.branchBehaviour -- tcHitBody
    delete tcMissTransition.branchBehaviour -- tcMissBody
    delete tcHitBody.steps -- tcHit
    delete tcHitBody.steps -- tcHitStart
    delete tcHitBody.steps -- tcHitStop
    delete tcMissBody.steps -- tcMissStart
    delete tcMissBody.steps -- tcMissStop
    delete tcMissBody.steps -- tcAction
    delete tcMissStart.successor -- tcAction
    delete tcAction.successor -- tcMissStop
    create tcBehaviour.steps -- tcAction
    create tcBefore.successor -- tcAction
    create tcAction.successor -- tcAfter
    create tcCall.anchor -- tcAction
    where tcCall.built != tcCall.shape
} do {
}

// An asynchronous fork.
while match {
    taCall: RealisedCall { }
    taAction: ExternalCallAction { }
    taBehaviour: ResourceDemandingBehaviour { }
    taBefore: AbstractAction { }
    taAfter: AbstractAction { }
    delete taFork: ForkAction { }
    delete taForked: ForkedBehaviour { }
    delete taStart: StartAction { }
    delete taStop: StopAction { }
    taCall.action -- taAction
    delete taCall.wrapper -- taFork
    delete taBehaviour.steps -- taFork
    delete taBefore.successor -- taFork
    delete taFork.successor -- taAfter
    delete taFork.asynchronousForkedBehaviours -- taForked
    delete taForked.steps -- taStart
    delete taForked.steps -- taStop
    delete taForked.steps -- taAction
    delete taStart.successor -- taAction
    delete taAction.successor -- taStop
    create taBehaviour.steps -- taAction
    create taBefore.successor -- taAction
    create taAction.successor -- taAfter
    where taCall.built != taCall.shape
} do {
}

// The composer's compose CPU or the orchestrator's coordination CPU.
while match {
    tkCall: RealisedCall { }
    tkBehaviour: ResourceDemandingBehaviour { }
    tkBefore: AbstractAction { }
    tkAfter: AbstractAction { }
    delete tkCompose: InternalAction { }
    delete tkDemand: ParametricResourceDemand { }
    delete tkRealised: RealisedDemand { }
    delete tkCall.compose -- tkCompose
    delete tkCompose.resourceDemand -- tkDemand
    delete tkRealised.demand -- tkDemand
    delete tkBehaviour.steps -- tkCompose
    delete tkBefore.successor -- tkCompose
    delete tkCompose.successor -- tkAfter
    create tkBefore.successor -- tkAfter
    where tkCall.built != tkCall.shape
} do {
}

// What follows a moved unit in its branch (a notification after the unit's call, which rule 0
// puts after the call wherever it runs) goes home with it: first into the unit's behaviour (one
// statement per class: the branch's start and stop stay, and not the unit itself: objects of
// different declared classes may be the same), then the unit and its followers back
// as one segment (below).
while match {
    tiCall: RealisedCall { }
    tiMoved: MovedUnit { }
    tiHome: ResourceDemandingBehaviour { }
    tiBranch: ForkedBehaviour { }
    tiUnit: AbstractAction { }
    tiAction: InternalAction { }
    tiMoved.`call` -- tiCall
    tiMoved.behaviour -- tiHome
    tiMoved.unit -- tiUnit
    tiCall.branch -- tiBranch
    delete tiBranch.steps -- tiAction
    create tiHome.steps -- tiAction
    forbid unit {
        tiMoved.unit -- tiAction
    }
    where tiCall.built != tiCall.shape
} do {
}

while match {
    tfCall: RealisedCall { }
    tfMoved: MovedUnit { }
    tfHome: ResourceDemandingBehaviour { }
    tfBranch: ForkedBehaviour { }
    tfUnit: AbstractAction { }
    tfAction: ForkAction { }
    tfMoved.`call` -- tfCall
    tfMoved.behaviour -- tfHome
    tfMoved.unit -- tfUnit
    tfCall.branch -- tfBranch
    delete tfBranch.steps -- tfAction
    create tfHome.steps -- tfAction
    forbid unit {
        tfMoved.unit -- tfAction
    }
    where tfCall.built != tfCall.shape
} do {
}

while match {
    teCall: RealisedCall { }
    teMoved: MovedUnit { }
    teHome: ResourceDemandingBehaviour { }
    teBranch: ForkedBehaviour { }
    teUnit: AbstractAction { }
    teAction: ExternalCallAction { }
    teMoved.`call` -- teCall
    teMoved.behaviour -- teHome
    teMoved.unit -- teUnit
    teCall.branch -- teBranch
    delete teBranch.steps -- teAction
    create teHome.steps -- teAction
    forbid unit {
        teMoved.unit -- teAction
    }
    where teCall.built != teCall.shape
} do {
}

// A moved unit (a composed call's or an orchestrated step's) back in the place of its placeholder
// (DESIGN.md B4.12), the call again through its own role, made by its own caller. The placeholder
// keeps the position whatever happened to the neighbours meanwhile (wrapped or unwrapped, moved
// out themselves, a notification or a group fork removed).
while match {
    tmCall: RealisedCall { }
    tmAction: ExternalCallAction { }
    tmRole: OperationRequiredRole { }
    tmOriginalRole: OperationRequiredRole { }
    tmUnit: AbstractAction { }
    tmHome: ResourceDemandingBehaviour { }
    tmPredecessor: AbstractAction { }
    tmNext: AbstractAction { }
    delete tmMoved: MovedUnit { }
    delete tmBranch: ForkedBehaviour { }
    delete tmStart: StartAction { }
    delete tmStop: StopAction { }
    tmCall.action -- tmAction
    delete tmMoved.`call` -- tmCall
    delete tmMoved.unit -- tmUnit
    delete tmMoved.behaviour -- tmHome
    delete tmHold: InternalAction { }
    delete tmMoved.placeholder -- tmHold
    delete tmCall.branch -- tmBranch
    delete tmBranch.steps -- tmStart
    delete tmBranch.steps -- tmStop
    delete tmStart.successor -- tmUnit
    delete tmUnit.successor -- tmStop
    delete tmBranch.steps -- tmUnit
    delete tmHome.steps -- tmHold
    delete tmPredecessor.successor -- tmHold
    delete tmHold.successor -- tmNext
    create tmHome.steps -- tmUnit
    create tmPredecessor.successor -- tmUnit
    create tmUnit.successor -- tmNext
    delete tmAction.role -- tmRole
    create tmAction.role -- tmOriginalRole
    delete tmCall.originalRole -- tmOriginalRole
    where tmCall.built != tmCall.shape
} do {
}

// The same for a unit with followers: the segment from the unit to its last follower goes
// back in the place of the placeholder.
while match {
    tw2Call: RealisedCall { }
    tw2Action: ExternalCallAction { }
    tw2Role: OperationRequiredRole { }
    tw2OriginalRole: OperationRequiredRole { }
    tw2Unit: AbstractAction { }
    tw2Home: ResourceDemandingBehaviour { }
    tw2Predecessor: AbstractAction { }
    tw2Next: AbstractAction { }
    delete tw2Moved: MovedUnit { }
    delete tw2Branch: ForkedBehaviour { }
    delete tw2Start: StartAction { }
    delete tw2Stop: StopAction { }
    tw2Call.action -- tw2Action
    delete tw2Moved.`call` -- tw2Call
    delete tw2Moved.unit -- tw2Unit
    delete tw2Moved.behaviour -- tw2Home
    delete tw2Hold: InternalAction { }
    delete tw2Moved.placeholder -- tw2Hold
    delete tw2Call.branch -- tw2Branch
    delete tw2Branch.steps -- tw2Start
    delete tw2Branch.steps -- tw2Stop
    tw2Last: AbstractAction { }
    delete tw2Start.successor -- tw2Unit
    delete tw2Last.successor -- tw2Stop
    delete tw2Branch.steps -- tw2Unit
    delete tw2Home.steps -- tw2Hold
    delete tw2Predecessor.successor -- tw2Hold
    delete tw2Hold.successor -- tw2Next
    create tw2Home.steps -- tw2Unit
    create tw2Predecessor.successor -- tw2Unit
    create tw2Last.successor -- tw2Next
    delete tw2Action.role -- tw2Role
    create tw2Action.role -- tw2OriginalRole
    delete tw2Call.originalRole -- tw2OriginalRole
    where tw2Call.built != tw2Call.shape
} do {
}

// The logical caller makes the call again.
while match {
    tcrCall: RealisedCall { }
    tcrCaller: AssemblyContext { }
    tcrLogical: AssemblyContext { }
    tcrCall.logicalCaller -- tcrLogical
    delete tcrCall.caller -- tcrCaller
    create tcrCall.caller -- tcrLogical
    where tcrCall.built != tcrCall.shape
} do {
}

while match {
    tgCall: RealisedCall { }
    tgGroup: ComposedGroup { }
    delete tgCall.group -- tgGroup
    where tgCall.built != tgCall.shape
} do {
}


// A redirect: the call's own role and service again.
while match {
    trCall: RealisedCall {
        built == "redirect"
        shape != "redirect"
    }
    trAction: ExternalCallAction { }
    trRole: OperationRequiredRole { }
    trOriginalRole: OperationRequiredRole { }
    trService: OperationSignature { }
    trOriginalService: OperationSignature { }
    trCall.action -- trAction
    delete trAction.role -- trRole
    create trAction.role -- trOriginalRole
    delete trAction.calledService -- trService
    create trAction.calledService -- trOriginalService
    delete trCall.originalRole -- trOriginalRole
    delete trCall.originalService -- trOriginalService
} do {
}

while match {
    tlCall: RealisedCall { }
    tlRedirect: Redirect { }
    delete tlCall.redirect -- tlRedirect
    where tlCall.built != tlCall.shape
} do {
}

// The provider is the logical one again (a redirect's provider may have been removed with it).
while match {
    tpCall: RealisedCall { }
    tpProvider: AssemblyContext { }
    tpLogical: AssemblyContext { }
    delete tpCall.provider -- tpProvider
    create tpCall.provider -- tpLogical
    tpCall.logicalProvider -- tpLogical
    where tpCall.built != tpCall.shape
} do {
}

while match {
    tnCall: RealisedCall { }
    tnLogical: AssemblyContext { }
    create tnCall.provider -- tnLogical
    tnCall.logicalProvider -- tnLogical
    forbid logical {
        tnCall.provider -- tnLogical
    }
    forbid provided {
        tnProvider: AssemblyContext { }
        tnCall.provider -- tnProvider
    }
} do {
}

// Taken apart: the call is plain until the additions build its shape.
while match {
    tzCall: RealisedCall {
        built != "plain"
        built = "plain"
    }
    where tzCall.built != tzCall.shape
    forbid wrapped {
        tzWrapper: AbstractAction { }
        tzCall.wrapper -- tzWrapper
    }
    forbid composing {
        tzCompose: InternalAction { }
        tzCall.compose -- tzCompose
    }
    forbid moved {
        tzMoved: MovedUnit { }
        tzMoved.`call` -- tzCall
    }
    forbid repointed {
        tzRole: OperationRequiredRole { }
        tzCall.originalRole -- tzRole
    }
    forbid reserviced {
        tzService: OperationSignature { }
        tzCall.originalService -- tzService
    }
} do {
}
