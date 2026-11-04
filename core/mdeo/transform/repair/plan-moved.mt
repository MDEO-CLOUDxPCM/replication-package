using "../../metamodel/architecture.mm"

// ../realise/plan-placement.mt in a placement repair (DESIGN.md B4.9): composed or plain only for the
// calls marked dirty (an end moved); gone deliveries whole (their Delivery went with a move).

for match {
    pgCall: RealisedCall {
        shape != "gone"
        shape = "gone"
    }
    pgNotification: RealisedNotification { }
    pgCall.notification -- pgNotification
    forbid delivered {
        pgDelivery: Delivery { }
        pgCall.delivery -- pgDelivery
    }
} do {
}
for match {
    pcRoot: Realisation { }
    pcRoot.dirty -- pcCall
    pcCall: RealisedCall {
        shape != "composed"
        shape = "composed"
    }
    pcAction: ExternalCallAction { }
    pcSite: CallSite { }
    pcMechanism: ComposedCall { }
    pcComposer: ExternalCallAction { }
    pcCaller: AssemblyContext { }
    pcProvider: AssemblyContext { }
    pcCallerContext: AllocationContext { }
    pcProviderContext: AllocationContext { }
    pcCallerContainer: ResourceContainer { }
    pcProviderContainer: ResourceContainer { }
    pcCall.action -- pcAction
    pcCall.site -- pcSite
    pcSite.mechanism -- pcMechanism
    pcSite.composer -- pcComposer
    pcCall.logicalCaller -- pcCaller
    pcCall.logicalProvider -- pcProvider
    pcCallerContext.assemblyContext -- pcCaller
    pcProviderContext.assemblyContext -- pcProvider
    pcCallerContext.resourceContainer -- pcCallerContainer
    pcProviderContext.resourceContainer -- pcProviderContainer
    where pcMechanism.hitRatio == null || pcMechanism.hitRatio!! <= 0.0
    forbid step {
        pcWorkflow: Workflow { }
        pcStyle: Orchestrated { }
        pcWorkflow.steps -- pcAction
        pcWorkflow.style -- pcStyle
    }
} do {
}
for match {
    pkRoot: Realisation { }
    pkRoot.dirty -- pkCall
    pkCall: RealisedCall {
        shape != "composedCache"
        shape = "composedCache"
    }
    pkAction: ExternalCallAction { }
    pkSite: CallSite { }
    pkMechanism: ComposedCall { }
    where pkMechanism.hitRatio != null && pkMechanism.hitRatio!! > 0.0
    pkComposer: ExternalCallAction { }
    pkCaller: AssemblyContext { }
    pkProvider: AssemblyContext { }
    pkCallerContext: AllocationContext { }
    pkProviderContext: AllocationContext { }
    pkCallerContainer: ResourceContainer { }
    pkProviderContainer: ResourceContainer { }
    pkCall.action -- pkAction
    pkCall.site -- pkSite
    pkSite.mechanism -- pkMechanism
    pkSite.composer -- pkComposer
    pkCall.logicalCaller -- pkCaller
    pkCall.logicalProvider -- pkProvider
    pkCallerContext.assemblyContext -- pkCaller
    pkProviderContext.assemblyContext -- pkProvider
    pkCallerContext.resourceContainer -- pkCallerContainer
    pkProviderContext.resourceContainer -- pkProviderContainer
    forbid step {
        pkWorkflow: Workflow { }
        pkStyle: Orchestrated { }
        pkWorkflow.steps -- pkAction
        pkWorkflow.style -- pkStyle
    }
} do {
}

// Everything else is plain (a synchronous call, a mechanism of another layer, a ComposedCall
// within one container or without a composer, a delivery).
for match {
    ppRoot: Realisation { }
    ppRoot.dirty -- ppCall
    ppCall: RealisedCall {
        shape != "plain"
        shape != "gone"
        shape = "plain"
    }
    ppAction: ExternalCallAction { }
    ppCall.action -- ppAction
    forbid step {
        ppWorkflow: Workflow { }
        ppStyle: Orchestrated { }
        ppWorkflow.steps -- ppAction
        ppWorkflow.style -- ppStyle
    }
    forbid redirected {
        ppRedirect: Redirect { }
        ppRedirect.`call` -- ppAction
    }
    forbid cached {
        ppCacheSite: CallSite { }
        ppCache: CachedCall { }
        ppCall.site -- ppCacheSite
        ppCacheSite.mechanism -- ppCache
    }
    forbid asynchronous {
        ppAsyncSite: CallSite { }
        ppAsync: AsyncCall { }
        ppCall.site -- ppAsyncSite
        ppAsyncSite.mechanism -- ppAsync
    }
    forbid composed {
        ppComposedSite: CallSite { }
        ppComposed: ComposedCall { }
        ppComposer: ExternalCallAction { }
        ppCaller: AssemblyContext { }
        ppProvider: AssemblyContext { }
        ppCallerContext: AllocationContext { }
        ppProviderContext: AllocationContext { }
        ppCallerContainer: ResourceContainer { }
        ppProviderContainer: ResourceContainer { }
        ppCall.site -- ppComposedSite
        ppComposedSite.mechanism -- ppComposed
        ppComposedSite.composer -- ppComposer
        ppCall.logicalCaller -- ppCaller
        ppCall.logicalProvider -- ppProvider
        ppCallerContext.assemblyContext -- ppCaller
        ppProviderContext.assemblyContext -- ppProvider
        ppCallerContext.resourceContainer -- ppCallerContainer
        ppProviderContext.resourceContainer -- ppProviderContainer
    }
} do {
}

// In the caller's transaction (InTransaction, DESIGN.md AB37): joined while caller and provider share a
// container and the site's two schemas a database server (not as an orchestrated step); otherwise the
// site is a synchronous step (plain, above). After the plain rule, which it overrides: a forbid with the
// condition in the plain rule did not hold the shared container and server (the same variable twice in a
// forbid is not an equality there), so inTx calls apart kept a stale shape.
for match {
    pjRoot: Realisation { }
    pjRoot.dirty -- pjCall
    pjCall: RealisedCall {
        shape != "joined"
        shape = "joined"
    }
    pjAction: ExternalCallAction { }
    pjSite: CallSite { }
    pjMechanism: InTransaction { }
    pjJoined: OperationSignature { }
    pjCaller: AssemblyContext { }
    pjProvider: AssemblyContext { }
    pjCallerContext: AllocationContext { }
    pjProviderContext: AllocationContext { }
    pjContainer: ResourceContainer { }
    pjCallerSchema: AssemblyContext { }
    pjProviderSchema: AssemblyContext { }
    pjCallerSchemaContext: AllocationContext { }
    pjProviderSchemaContext: AllocationContext { }
    pjServer: ResourceContainer { }
    pjCall.action -- pjAction
    pjCall.site -- pjSite
    pjSite.mechanism -- pjMechanism
    pjSite.joinedService -- pjJoined
    pjSite.callerSchema -- pjCallerSchema
    pjSite.providerSchema -- pjProviderSchema
    pjCall.logicalCaller -- pjCaller
    pjCall.logicalProvider -- pjProvider
    pjCallerContext.assemblyContext -- pjCaller
    pjProviderContext.assemblyContext -- pjProvider
    pjCallerContext.resourceContainer -- pjContainer
    pjProviderContext.resourceContainer -- pjContainer
    pjCallerSchemaContext.assemblyContext -- pjCallerSchema
    pjProviderSchemaContext.assemblyContext -- pjProviderSchema
    pjCallerSchemaContext.resourceContainer -- pjServer
    pjProviderSchemaContext.resourceContainer -- pjServer
    forbid step {
        pjWorkflow: Workflow { }
        pjStyle: Orchestrated { }
        pjWorkflow.steps -- pjAction
        pjWorkflow.style -- pjStyle
    }
} do {
}
