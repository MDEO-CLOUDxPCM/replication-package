using "../../metamodel/architecture.mm"

// The additions of the realisation at call sites (DESIGN.md B3): every call whose structure
// (`built`) is plain gets what its shape needs. Redirect: re-pointed in place. Composed: right
// after the composer's call, in a branch of a synchronous fork per composer call, with the
// compose CPU before it. Cache (and composedCache): a probabilistic branch, hit = CPU on the
// caller (the composer), miss = the call; with CallSite.hitRatio the site's own ratio; at a site
// whose cache is the provider's (CallSite.cachedService, as built) the composed call goes to the
// provider's cached operation instead, no branch (DESIGN.md AB33); at a site with a federation fetch
// (CallSite.fetchService) a plain composed call goes to the provider's fetch operation (AB43). Async: an
// asynchronous fork around the call.

// ═══ Redirect ═════════════════════════════════════════════════════════════════════════
while match {
    brCall: RealisedCall {
        shape == "redirect"
        built == "plain"
        built = "redirect"
    }
    brAction: ExternalCallAction { }
    brRedirect: Redirect { }
    brCaller: AssemblyContext { }
    brProvider: AssemblyContext { }
    brTarget: AssemblyContext { }
    brService: OperationSignature { }
    brOldService: OperationSignature { }
    brInterface: OperationInterface { }
    brOldRole: OperationRequiredRole { }
    brKnown: RealisedRole { }
    brRole: OperationRequiredRole { }
    brCall.action -- brAction
    brRedirect.`call` -- brAction
    brRedirect.provider -- brTarget
    brRedirect.service -- brService
    brInterface.signatures -- brService
    brCall.caller -- brCaller
    brKnown.source -- brCaller
    brKnown.target -- brTarget
    brKnown.role -- brRole
    brRole.requiredInterface -- brInterface
    delete brAction.role -- brOldRole
    create brAction.role -- brRole
    delete brAction.calledService -- brOldService
    create brAction.calledService -- brService
    create brCall.originalRole -- brOldRole
    create brCall.originalService -- brOldService
    delete brCall.provider -- brProvider
    create brCall.provider -- brTarget
    create brCall.redirect -- brRedirect
} do {
}

// ═══ Composed ═════════════════════════════════════════════════════════════════════════
// The group of a composer call: a synchronous fork right after it. `while`: several composed
// calls may follow one composer call.
while match {
    bgRoot: Realisation { }
    bgCall: RealisedCall {
        built == "plain"
    }
    bgSite: CallSite { }
    bgAfter: ExternalCallAction { }
    bgNext: AbstractAction { }
    bgBehaviour: ResourceDemandingBehaviour { }
    bgCall.site -- bgSite
    bgSite.composer -- bgAfter
    bgBehaviour.steps -- bgAfter
    delete bgAfter.successor -- bgNext
    where bgCall.shape == "composed" || bgCall.shape == "composedCache"
    forbid grouped {
        bgExisting: ComposedGroup { }
        bgExisting.after -- bgAfter
    }
    create bgGroup: ComposedGroup { }
    create bgFork: ForkAction {
        entityName = "compose"
    }
    create bgPoint: SynchronisationPoint { }
    create bgRoot.groups -- bgGroup
    create bgGroup.after -- bgAfter
    create bgGroup.fork -- bgFork
    create bgFork.synchronisingBehaviours -- bgPoint
    create bgBehaviour.steps -- bgFork
    create bgAfter.successor -- bgFork
    create bgFork.successor -- bgNext
} do {
}

// The composed call's unit leaves its SEFF for a branch of the group, an empty placeholder keeps
// its place (MovedUnit, DESIGN.md B4.12); the composer makes the call. `while`: units of one SEFF
// may follow each other.
while match {
    bmRoot: Realisation { }
    bmCall: RealisedCall {
        built == "plain"
        built = bmCall.shape
    }
    bmAction: ExternalCallAction { }
    bmSite: CallSite { }
    bmAfter: ExternalCallAction { }
    bmGroup: ComposedGroup { }
    bmFork: ForkAction { }
    bmPoint: SynchronisationPoint { }
    bmUnit: AbstractAction { }
    bmSeff: ResourceDemandingSEFF { }
    bmBefore: AbstractAction { }
    bmNext: AbstractAction { }
    bmCaller: AssemblyContext { }
    bmComposer: AssemblyContext { }
    bmProvider: AssemblyContext { }
    bmComposerCall: RealisedCall { }
    bmRole: OperationRequiredRole { }
    bmInterface: OperationInterface { }
    bmKnown: RealisedRole { }
    bmNewRole: OperationRequiredRole { }
    bmCall.action -- bmAction
    bmCall.site -- bmSite
    bmSite.composer -- bmAfter
    bmGroup.after -- bmAfter
    bmGroup.fork -- bmFork
    bmFork.synchronisingBehaviours -- bmPoint
    bmCall.unit -- bmUnit
    bmCall.seff -- bmSeff
    bmCall.logicalProvider -- bmProvider
    bmComposerCall.action -- bmAfter
    bmComposerCall.caller -- bmComposer
    bmAction.role -- bmRole
    bmRole.requiredInterface -- bmInterface
    bmKnown.source -- bmComposer
    bmKnown.target -- bmProvider
    bmKnown.role -- bmNewRole
    bmNewRole.requiredInterface -- bmInterface
    where bmCall.shape == "composed" || bmCall.shape == "composedCache"
    delete bmSeff.steps -- bmUnit
    delete bmBefore.successor -- bmUnit
    delete bmUnit.successor -- bmNext
    create bmHold: InternalAction {
        entityName = "moved"
    }
    create bmSeff.steps -- bmHold
    create bmBefore.successor -- bmHold
    create bmHold.successor -- bmNext
    create bmMoved: MovedUnit { }
    create bmRoot.units -- bmMoved
    create bmMoved.unit -- bmUnit
    create bmMoved.behaviour -- bmSeff
    create bmMoved.placeholder -- bmHold
    create bmMoved.`call` -- bmCall
    create bmBranch: ForkedBehaviour { }
    create bmStart: StartAction { }
    create bmStop: StopAction { }
    create bmPoint.synchronousForkedBehaviours -- bmBranch
    create bmBranch.steps -- bmStart
    create bmBranch.steps -- bmUnit
    create bmBranch.steps -- bmStop
    create bmStart.successor -- bmUnit
    create bmUnit.successor -- bmStop
    create bmCall.branch -- bmBranch
    create bmCall.group -- bmGroup
    delete bmAction.role -- bmRole
    create bmAction.role -- bmNewRole
    create bmCall.originalRole -- bmRole
    delete bmCall.caller -- bmCaller
    create bmCall.caller -- bmComposer
} do {
}

// The compose CPU right before the call, on the composer's container.
while match {
    bcRoot: Realisation { }
    bcDecisions: ArchitectureDecisions { }
    bcCall: RealisedCall { }
    bcAction: ExternalCallAction { }
    bcSite: CallSite { }
    bcMechanism: ComposedCall {
        composeCpuMs > 0.0
    }
    bcBehaviour: ResourceDemandingBehaviour { }
    bcBefore: AbstractAction { }
    bcComposer: AssemblyContext { }
    bcContext: AllocationContext { }
    bcContainer: ResourceContainer { }
    bcRates: RealisedContainer { }
    bcCall.action -- bcAction
    bcCall.site -- bcSite
    bcSite.mechanism -- bcMechanism
    bcCall.caller -- bcComposer
    bcContext.assemblyContext -- bcComposer
    bcContext.resourceContainer -- bcContainer
    bcRates.container -- bcContainer
    bcBehaviour.steps -- bcAction
    delete bcBefore.successor -- bcAction
    where bcCall.built == "composed" || bcCall.built == "composedCache"
    forbid composing {
        bcExisting: InternalAction { }
        bcCall.compose -- bcExisting
    }
    create bcCompose: InternalAction {
        entityName = "compose"
    }
    create bcDemand: ParametricResourceDemand {
        specification = "Exp(1.0 / ((" + (bcMechanism.composeCpuMs / bcDecisions.msPerTimeUnit) + ") * (" + bcRates.cpuRate + ")))"
        requiredResource = ProcessingResourceType.CPU
    }
    create bcRealised: RealisedDemand {
        ms = bcMechanism.composeCpuMs
        kind = "CPU"
        rate = bcRates.cpuRate
    }
    create bcBehaviour.steps -- bcCompose
    create bcBefore.successor -- bcCompose
    create bcCompose.successor -- bcAction
    create bcCompose.resourceDemand -- bcDemand
    create bcRoot.demands -- bcRealised
    create bcRealised.demand -- bcDemand
    create bcRealised.owner -- bcComposer
    create bcCall.compose -- bcCompose
} do {
}

// ═══ Cache branches ═══════════════════════════════════════════════════════════════════
while match {
    bhCall: RealisedCall {
        shape == "cache"
        built == "plain"
        built = "cache"
    }
    bhAction: ExternalCallAction { }
    bhSite: CallSite { }
    bhMechanism: CachedCall { }
    bhBehaviour: ResourceDemandingBehaviour { }
    bhBefore: AbstractAction { }
    bhAfter: AbstractAction { }
    bhCall.action -- bhAction
    bhCall.site -- bhSite
    bhSite.mechanism -- bhMechanism
    where bhSite.hitRatio == null
    delete bhBehaviour.steps -- bhAction
    delete bhBefore.successor -- bhAction
    delete bhAction.successor -- bhAfter
    delete bhCall.anchor -- bhAction
    create bhBranch: BranchAction {
        entityName = "cache"
    }
    create bhHitTransition: ProbabilisticBranchTransition {
        entityName = "hit"
        branchProbability = bhMechanism.hitRatio
    }
    create bhMissTransition: ProbabilisticBranchTransition {
        entityName = "miss"
        branchProbability = 1.0 - bhMechanism.hitRatio
    }
    create bhHitBody: ResourceDemandingBehaviour { }
    create bhMissBody: ResourceDemandingBehaviour { }
    create bhHitStart: StartAction { }
    create bhHit: InternalAction {
        entityName = "cacheHit"
    }
    create bhHitStop: StopAction { }
    create bhMissStart: StartAction { }
    create bhMissStop: StopAction { }
    create bhBehaviour.steps -- bhBranch
    create bhBefore.successor -- bhBranch
    create bhBranch.successor -- bhAfter
    create bhBranch.branches -- bhHitTransition
    create bhBranch.branches -- bhMissTransition
    create bhHitTransition.branchBehaviour -- bhHitBody
    create bhMissTransition.branchBehaviour -- bhMissBody
    create bhHitBody.steps -- bhHitStart
    create bhHitBody.steps -- bhHit
    create bhHitBody.steps -- bhHitStop
    create bhHitStart.successor -- bhHit
    create bhHit.successor -- bhHitStop
    create bhMissBody.steps -- bhMissStart
    create bhMissBody.steps -- bhAction
    create bhMissBody.steps -- bhMissStop
    create bhMissStart.successor -- bhAction
    create bhAction.successor -- bhMissStop
    create bhCall.wrapper -- bhBranch
    create bhCall.hit -- bhHit
    create bhCall.anchor -- bhBranch
} do {
}

// The same with the site's own hit ratio (CallSite.hitRatio, DESIGN.md AB33.2).
while match {
    biCall: RealisedCall {
        shape == "cache"
        built == "plain"
        built = "cache"
    }
    biAction: ExternalCallAction { }
    biSite: CallSite { }
    biMechanism: CachedCall { }
    biBehaviour: ResourceDemandingBehaviour { }
    biBefore: AbstractAction { }
    biAfter: AbstractAction { }
    biCall.action -- biAction
    biCall.site -- biSite
    biSite.mechanism -- biMechanism
    where biSite.hitRatio != null
    delete biBehaviour.steps -- biAction
    delete biBefore.successor -- biAction
    delete biAction.successor -- biAfter
    delete biCall.anchor -- biAction
    create biBranch: BranchAction {
        entityName = "cache"
    }
    create biHitTransition: ProbabilisticBranchTransition {
        entityName = "hit"
        branchProbability = biSite.hitRatio!!
    }
    create biMissTransition: ProbabilisticBranchTransition {
        entityName = "miss"
        branchProbability = 1.0 - biSite.hitRatio!!
    }
    create biHitBody: ResourceDemandingBehaviour { }
    create biMissBody: ResourceDemandingBehaviour { }
    create biHitStart: StartAction { }
    create biHit: InternalAction {
        entityName = "cacheHit"
    }
    create biHitStop: StopAction { }
    create biMissStart: StartAction { }
    create biMissStop: StopAction { }
    create biBehaviour.steps -- biBranch
    create biBefore.successor -- biBranch
    create biBranch.successor -- biAfter
    create biBranch.branches -- biHitTransition
    create biBranch.branches -- biMissTransition
    create biHitTransition.branchBehaviour -- biHitBody
    create biMissTransition.branchBehaviour -- biMissBody
    create biHitBody.steps -- biHitStart
    create biHitBody.steps -- biHit
    create biHitBody.steps -- biHitStop
    create biHitStart.successor -- biHit
    create biHit.successor -- biHitStop
    create biMissBody.steps -- biMissStart
    create biMissBody.steps -- biAction
    create biMissBody.steps -- biMissStop
    create biMissStart.successor -- biAction
    create biAction.successor -- biMissStop
    create biCall.wrapper -- biBranch
    create biCall.hit -- biHit
    create biCall.anchor -- biBranch
} do {
}

// The composer's cache (after the compose CPU).
while match {
    bkCall: RealisedCall {
        built == "composedCache"
    }
    bkAction: ExternalCallAction { }
    bkSite: CallSite { }
    bkMechanism: ComposedCall { }
    bkBehaviour: ResourceDemandingBehaviour { }
    bkBefore: AbstractAction { }
    bkAfter: AbstractAction { }
    bkCall.action -- bkAction
    bkCall.site -- bkSite
    bkSite.mechanism -- bkMechanism
    forbid wrapped {
        bkExisting: AbstractAction { }
        bkCall.wrapper -- bkExisting
    }
    forbid asBuilt {
        bkCached: OperationSignature { }
        bkSite.cachedService -- bkCached
    }
    where bkSite.hitRatio == null
    delete bkBehaviour.steps -- bkAction
    delete bkBefore.successor -- bkAction
    delete bkAction.successor -- bkAfter
    delete bkCall.anchor -- bkAction
    create bkBranch: BranchAction {
        entityName = "cache"
    }
    create bkHitTransition: ProbabilisticBranchTransition {
        entityName = "hit"
        branchProbability = bkMechanism.hitRatio!!
    }
    create bkMissTransition: ProbabilisticBranchTransition {
        entityName = "miss"
        branchProbability = 1.0 - bkMechanism.hitRatio!!
    }
    create bkHitBody: ResourceDemandingBehaviour { }
    create bkMissBody: ResourceDemandingBehaviour { }
    create bkHitStart: StartAction { }
    create bkHit: InternalAction {
        entityName = "cacheHit"
    }
    create bkHitStop: StopAction { }
    create bkMissStart: StartAction { }
    create bkMissStop: StopAction { }
    create bkBehaviour.steps -- bkBranch
    create bkBefore.successor -- bkBranch
    create bkBranch.successor -- bkAfter
    create bkBranch.branches -- bkHitTransition
    create bkBranch.branches -- bkMissTransition
    create bkHitTransition.branchBehaviour -- bkHitBody
    create bkMissTransition.branchBehaviour -- bkMissBody
    create bkHitBody.steps -- bkHitStart
    create bkHitBody.steps -- bkHit
    create bkHitBody.steps -- bkHitStop
    create bkHitStart.successor -- bkHit
    create bkHit.successor -- bkHitStop
    create bkMissBody.steps -- bkMissStart
    create bkMissBody.steps -- bkAction
    create bkMissBody.steps -- bkMissStop
    create bkMissStart.successor -- bkAction
    create bkAction.successor -- bkMissStop
    create bkCall.wrapper -- bkBranch
    create bkCall.hit -- bkHit
    create bkCall.anchor -- bkBranch
} do {
}

// The same with the site's own hit ratio (CallSite.hitRatio, DESIGN.md AB33.2).
while match {
    blCall: RealisedCall {
        built == "composedCache"
    }
    blAction: ExternalCallAction { }
    blSite: CallSite { }
    blMechanism: ComposedCall { }
    blBehaviour: ResourceDemandingBehaviour { }
    blBefore: AbstractAction { }
    blAfter: AbstractAction { }
    blCall.action -- blAction
    blCall.site -- blSite
    blSite.mechanism -- blMechanism
    forbid wrapped {
        blExisting: AbstractAction { }
        blCall.wrapper -- blExisting
    }
    forbid asBuilt {
        blCached: OperationSignature { }
        blSite.cachedService -- blCached
    }
    where blSite.hitRatio != null
    delete blBehaviour.steps -- blAction
    delete blBefore.successor -- blAction
    delete blAction.successor -- blAfter
    delete blCall.anchor -- blAction
    create blBranch: BranchAction {
        entityName = "cache"
    }
    create blHitTransition: ProbabilisticBranchTransition {
        entityName = "hit"
        branchProbability = blSite.hitRatio!!
    }
    create blMissTransition: ProbabilisticBranchTransition {
        entityName = "miss"
        branchProbability = 1.0 - blSite.hitRatio!!
    }
    create blHitBody: ResourceDemandingBehaviour { }
    create blMissBody: ResourceDemandingBehaviour { }
    create blHitStart: StartAction { }
    create blHit: InternalAction {
        entityName = "cacheHit"
    }
    create blHitStop: StopAction { }
    create blMissStart: StartAction { }
    create blMissStop: StopAction { }
    create blBehaviour.steps -- blBranch
    create blBefore.successor -- blBranch
    create blBranch.successor -- blAfter
    create blBranch.branches -- blHitTransition
    create blBranch.branches -- blMissTransition
    create blHitTransition.branchBehaviour -- blHitBody
    create blMissTransition.branchBehaviour -- blMissBody
    create blHitBody.steps -- blHitStart
    create blHitBody.steps -- blHit
    create blHitBody.steps -- blHitStop
    create blHitStart.successor -- blHit
    create blHit.successor -- blHitStop
    create blMissBody.steps -- blMissStart
    create blMissBody.steps -- blAction
    create blMissBody.steps -- blMissStop
    create blMissStart.successor -- blAction
    create blAction.successor -- blMissStop
    create blCall.wrapper -- blBranch
    create blCall.hit -- blHit
    create blCall.anchor -- blBranch
} do {
}

// The hit's CPU on the caller's (the composer's) container, where it is more than nothing.
while match {
    bdRoot: Realisation { }
    bdDecisions: ArchitectureDecisions { }
    bdCall: RealisedCall {
        built == "cache"
    }
    bdSite: CallSite { }
    bdMechanism: CachedCall {
        hitCpuMs > 0.0
    }
    bdHit: InternalAction { }
    bdCaller: AssemblyContext { }
    bdContext: AllocationContext { }
    bdContainer: ResourceContainer { }
    bdRates: RealisedContainer { }
    bdCall.site -- bdSite
    bdSite.mechanism -- bdMechanism
    bdCall.hit -- bdHit
    bdCall.caller -- bdCaller
    bdContext.assemblyContext -- bdCaller
    bdContext.resourceContainer -- bdContainer
    bdRates.container -- bdContainer
        forbid done {
        bdExisting: ParametricResourceDemand { }
        bdHit.resourceDemand -- bdExisting
    }
    create bdDemand: ParametricResourceDemand {
        specification = "Exp(1.0 / ((" + (bdMechanism.hitCpuMs / bdDecisions.msPerTimeUnit) + ") * (" + bdRates.cpuRate + ")))"
        requiredResource = ProcessingResourceType.CPU
    }
    create bdRealised: RealisedDemand {
        ms = bdMechanism.hitCpuMs
        kind = "CPU"
        rate = bdRates.cpuRate
    }
    create bdHit.resourceDemand -- bdDemand
    create bdRoot.demands -- bdRealised
    create bdRealised.demand -- bdDemand
    create bdRealised.owner -- bdCaller
} do {
}

while match {
    beRoot: Realisation { }
    beDecisions: ArchitectureDecisions { }
    beCall: RealisedCall {
        built == "composedCache"
    }
    beSite: CallSite { }
    beMechanism: ComposedCall { }
    beHit: InternalAction { }
    beCaller: AssemblyContext { }
    beContext: AllocationContext { }
    beContainer: ResourceContainer { }
    beRates: RealisedContainer { }
    beCall.site -- beSite
    beSite.mechanism -- beMechanism
    beCall.hit -- beHit
    beCall.caller -- beCaller
    beContext.assemblyContext -- beCaller
    beContext.resourceContainer -- beContainer
    beRates.container -- beContainer
    where beMechanism.hitCpuMs != null && beMechanism.hitCpuMs!! > 0.0
        forbid done {
        beExisting: ParametricResourceDemand { }
        beHit.resourceDemand -- beExisting
    }
    create beDemand: ParametricResourceDemand {
        specification = "Exp(1.0 / ((" + (beMechanism.hitCpuMs!! / beDecisions.msPerTimeUnit) + ") * (" + beRates.cpuRate + ")))"
        requiredResource = ProcessingResourceType.CPU
    }
    create beRealised: RealisedDemand {
        ms = beMechanism.hitCpuMs!!
        kind = "CPU"
        rate = beRates.cpuRate
    }
    create beHit.resourceDemand -- beDemand
    create beRoot.demands -- beRealised
    create beRealised.demand -- beDemand
    create beRealised.owner -- beCaller
} do {
}

// The cache as built (CallSite.cachedService, DESIGN.md AB33.1): no branch at the composer; the
// composed call goes to the provider's cached operation (its SEFF holds the cache), so a hit keeps
// the compose CPU and the call's middleware and costs the provider its hit CPU.
while match {
    bqCall: RealisedCall {
        built == "composedCache"
    }
    bqAction: ExternalCallAction { }
    bqSite: CallSite { }
    bqCached: OperationSignature { }
    bqService: OperationSignature { }
    bqCall.action -- bqAction
    bqCall.site -- bqSite
    bqSite.cachedService -- bqCached
    delete bqAction.calledService -- bqService
    create bqAction.calledService -- bqCached
    create bqCall.originalService -- bqService
    forbid done {
        bqOriginal: OperationSignature { }
        bqCall.originalService -- bqOriginal
    }
} do {
}

// A federation fetch (CallSite.fetchService, DESIGN.md AB43): the composed call goes to the provider's fetch
// operation (the subgraph's resolution of the entity the gateway hands it, then the field) instead of the field's
// own; within one container the caller resolves the field itself, as written, with nothing to resolve.
while match {
    bfCall: RealisedCall {
        built == "composed"
    }
    bfAction: ExternalCallAction { }
    bfSite: CallSite { }
    bfFetch: OperationSignature { }
    bfService: OperationSignature { }
    bfCall.action -- bfAction
    bfCall.site -- bfSite
    bfSite.fetchService -- bfFetch
    delete bfAction.calledService -- bfService
    create bfAction.calledService -- bfFetch
    create bfCall.originalService -- bfService
    forbid done {
        bfOriginal: OperationSignature { }
        bfCall.originalService -- bfOriginal
    }
} do {
}

// In the caller's transaction (InTransaction, DESIGN.md AB37): the call goes to the step's work
// (CallSite.joinedService) instead of its step form, so it pays no envelope and no commit of its own.
while match {
    bjCall: RealisedCall {
        shape == "joined"
        built == "plain"
        built = "joined"
    }
    bjAction: ExternalCallAction { }
    bjSite: CallSite { }
    bjJoined: OperationSignature { }
    bjService: OperationSignature { }
    bjCall.action -- bjAction
    bjCall.site -- bjSite
    bjSite.joinedService -- bjJoined
    delete bjAction.calledService -- bjService
    create bjAction.calledService -- bjJoined
    create bjCall.originalService -- bjService
} do {
}

// ═══ Asynchronous fork ════════════════════════════════════════════════════════════════
while match {
    baCall: RealisedCall {
        shape == "async"
        built == "plain"
        built = "async"
    }
    baAction: ExternalCallAction { }
    baBehaviour: ResourceDemandingBehaviour { }
    baBefore: AbstractAction { }
    baAfter: AbstractAction { }
    baCall.action -- baAction
    delete baBehaviour.steps -- baAction
    delete baBefore.successor -- baAction
    delete baAction.successor -- baAfter
    create baFork: ForkAction {
        entityName = "async"
    }
    create baForked: ForkedBehaviour { }
    create baStart: StartAction { }
    create baStop: StopAction { }
    create baBehaviour.steps -- baFork
    create baBefore.successor -- baFork
    create baFork.successor -- baAfter
    create baFork.asynchronousForkedBehaviours -- baForked
    create baForked.steps -- baStart
    create baForked.steps -- baAction
    create baForked.steps -- baStop
    create baStart.successor -- baAction
    create baAction.successor -- baStop
    create baCall.wrapper -- baFork
} do {
}
