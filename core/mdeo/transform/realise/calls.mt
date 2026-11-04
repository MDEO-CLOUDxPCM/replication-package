using "../../metamodel/architecture.mm"

// Fixed part of the realisation (DESIGN.md B1.1): a RealisedCall per base call (an
// ExternalCallAction of a base SEFF whose role has a connector from the component's assembly):
// its caller and provider as written (logical, and current until a realisation re-points it), its
// SEFF, the SEFF-level action that holds it, its CallSite.

// A call nested below a SEFF-level action.
for match {
    rnRoot: Realisation { }
    rnOwned: OwnedBehaviour { }
    rnBehaviour: ResourceDemandingBehaviour { }
    rnSeff: ResourceDemandingSEFF { }
    rnUnit: AbstractAction { }
    rnCall: ExternalCallAction { }
    rnComponent: BasicComponent { }
    rnCaller: AssemblyContext { }
    rnRole: OperationRequiredRole { }
    rnConnector: AssemblyConnector { }
    rnProvider: AssemblyContext { }
    rnOwned.behaviour -- rnBehaviour
    rnOwned.seff -- rnSeff
    rnOwned.unit -- rnUnit
    rnBehaviour.steps -- rnCall
    rnComponent.serviceEffectSpecifications -- rnSeff
    rnCaller.encapsulatedComponent -- rnComponent
    rnCall.role -- rnRole
    rnConnector.requiringAssemblyContext -- rnCaller
    rnConnector.requiredRole -- rnRole
    rnConnector.providingAssemblyContext -- rnProvider
    forbid done {
        rnExisting: RealisedCall { }
        rnExisting.action -- rnCall
    }
    create rnRealised: RealisedCall {
        shape = "plain"
        built = "plain"
        kind = "sync"
    }
    create rnRoot.calls -- rnRealised
    create rnRealised.action -- rnCall
    create rnRealised.caller -- rnCaller
    create rnRealised.provider -- rnProvider
    create rnRealised.logicalCaller -- rnCaller
    create rnRealised.logicalProvider -- rnProvider
    create rnRealised.seff -- rnSeff
    create rnRealised.unit -- rnUnit
    create rnRealised.anchor -- rnCall
} do {
}

// A call directly in its SEFF: the call is its own unit.
for match {
    rdRoot: Realisation { }
    rdOwned: OwnedBehaviour { }
    rdSeff: ResourceDemandingSEFF { }
    rdCall: ExternalCallAction { }
    rdComponent: BasicComponent { }
    rdCaller: AssemblyContext { }
    rdRole: OperationRequiredRole { }
    rdConnector: AssemblyConnector { }
    rdProvider: AssemblyContext { }
    rdOwned.behaviour -- rdSeff
    rdSeff.steps -- rdCall
    rdComponent.serviceEffectSpecifications -- rdSeff
    rdCaller.encapsulatedComponent -- rdComponent
    rdCall.role -- rdRole
    rdConnector.requiringAssemblyContext -- rdCaller
    rdConnector.requiredRole -- rdRole
    rdConnector.providingAssemblyContext -- rdProvider
    forbid nested {
        rdUnit: AbstractAction { }
        rdOwned.unit -- rdUnit
    }
    forbid done {
        rdExisting: RealisedCall { }
        rdExisting.action -- rdCall
    }
    create rdRealised: RealisedCall {
        shape = "plain"
        built = "plain"
        kind = "sync"
    }
    create rdRoot.calls -- rdRealised
    create rdRealised.action -- rdCall
    create rdRealised.caller -- rdCaller
    create rdRealised.provider -- rdProvider
    create rdRealised.logicalCaller -- rdCaller
    create rdRealised.logicalProvider -- rdProvider
    create rdRealised.seff -- rdSeff
    create rdRealised.unit -- rdCall
    create rdRealised.anchor -- rdCall
} do {
}

// A call of the component itself (its connector ends at its own assembly), nested.
for match {
    snRoot: Realisation { }
    snOwned: OwnedBehaviour { }
    snBehaviour: ResourceDemandingBehaviour { }
    snSeff: ResourceDemandingSEFF { }
    snUnit: AbstractAction { }
    snCall: ExternalCallAction { }
    snComponent: BasicComponent { }
    snCaller: AssemblyContext { }
    snRole: OperationRequiredRole { }
    snConnector: AssemblyConnector { }
    snOwned.behaviour -- snBehaviour
    snOwned.seff -- snSeff
    snOwned.unit -- snUnit
    snBehaviour.steps -- snCall
    snComponent.serviceEffectSpecifications -- snSeff
    snCaller.encapsulatedComponent -- snComponent
    snCall.role -- snRole
    snConnector.requiringAssemblyContext -- snCaller
    snConnector.requiredRole -- snRole
    snConnector.providingAssemblyContext -- snCaller
    forbid done {
        snExisting: RealisedCall { }
        snExisting.action -- snCall
    }
    create snRealised: RealisedCall {
        shape = "plain"
        built = "plain"
        kind = "sync"
    }
    create snRoot.calls -- snRealised
    create snRealised.action -- snCall
    create snRealised.caller -- snCaller
    create snRealised.provider -- snCaller
    create snRealised.logicalCaller -- snCaller
    create snRealised.logicalProvider -- snCaller
    create snRealised.seff -- snSeff
    create snRealised.unit -- snUnit
    create snRealised.anchor -- snCall
} do {
}

// A call of the component itself, directly in its SEFF.
for match {
    sdRoot: Realisation { }
    sdOwned: OwnedBehaviour { }
    sdSeff: ResourceDemandingSEFF { }
    sdCall: ExternalCallAction { }
    sdComponent: BasicComponent { }
    sdCaller: AssemblyContext { }
    sdRole: OperationRequiredRole { }
    sdConnector: AssemblyConnector { }
    sdOwned.behaviour -- sdSeff
    sdSeff.steps -- sdCall
    sdComponent.serviceEffectSpecifications -- sdSeff
    sdCaller.encapsulatedComponent -- sdComponent
    sdCall.role -- sdRole
    sdConnector.requiringAssemblyContext -- sdCaller
    sdConnector.requiredRole -- sdRole
    sdConnector.providingAssemblyContext -- sdCaller
    forbid nested {
        sdUnit: AbstractAction { }
        sdOwned.unit -- sdUnit
    }
    forbid done {
        sdExisting: RealisedCall { }
        sdExisting.action -- sdCall
    }
    create sdRealised: RealisedCall {
        shape = "plain"
        built = "plain"
        kind = "sync"
    }
    create sdRoot.calls -- sdRealised
    create sdRealised.action -- sdCall
    create sdRealised.caller -- sdCaller
    create sdRealised.provider -- sdCaller
    create sdRealised.logicalCaller -- sdCaller
    create sdRealised.logicalProvider -- sdCaller
    create sdRealised.seff -- sdSeff
    create sdRealised.unit -- sdCall
    create sdRealised.anchor -- sdCall
} do {
}

// Its CallSite, where it has one.
for match {
    rsRealised: RealisedCall { }
    rsCall: ExternalCallAction { }
    rsSite: CallSite { }
    rsRealised.action -- rsCall
    rsSite.`call` -- rsCall
    forbid done {
        rsExisting: CallSite { }
        rsRealised.site -- rsExisting
    }
    create rsRealised.site -- rsSite
} do {
}
