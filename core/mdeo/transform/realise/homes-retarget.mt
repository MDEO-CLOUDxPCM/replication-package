using "../../metamodel/architecture.mm"

// The re-targeting of a Home's calls (DESIGN.md AB41; ./homes.mt marks them, ../realise.mt takes them apart first):
// every call here is plain (`built`) with the pseudo shape `retarget`, its caller and provider the logical ones.

// Back to the written option: the call's role as written, the signature of the same name on the written option's
// interface, the written option's assembly.
while match {
    hbCall: RealisedCall {
        built == "plain"
        shape == "retarget"
    }
    hbAction: ExternalCallAction { }
    hbHome: Home { }
    hbApplied: HomeOption { }
    hbWritten: HomeOption { }
    hbAppliedProvider: AssemblyContext { }
    hbWrittenProvider: AssemblyContext { }
    hbRole: OperationRequiredRole { }
    hbWrittenRole: OperationRequiredRole { }
    hbService: OperationSignature { }
    hbWrittenService: OperationSignature { }
    hbWrittenInterface: OperationInterface { }
    hbCall.action -- hbAction
    hbHome.calls -- hbAction
    hbHome.written -- hbWritten
    hbWritten.provider -- hbWrittenProvider
    hbWritten.interface -- hbWrittenInterface
    hbWrittenInterface.signatures -- hbWrittenService
    where hbWrittenService.entityName == hbService.entityName
    delete hbCall.home -- hbApplied
    create hbCall.home -- hbWritten
    delete hbCall.writtenRole -- hbWrittenRole
    delete hbAction.role -- hbRole
    create hbAction.role -- hbWrittenRole
    delete hbAction.calledService -- hbService
    create hbAction.calledService -- hbWrittenService
    delete hbCall.logicalProvider -- hbAppliedProvider
    create hbCall.logicalProvider -- hbWrittenProvider
    delete hbCall.provider -- hbAppliedProvider
    create hbCall.provider -- hbWrittenProvider
} do {
}

// A derived role of the caller for the chosen option's interface and its connector to the option's assembly
// (as ./roles.mt makes for a redirect), when the call is about to leave the written option.
while match {
    hrRoot: Realisation { }
    hrSystem: System { }
    hrSource: AssemblyContext { }
    hrSourceComponent: BasicComponent { }
    hrTarget: AssemblyContext { }
    hrTargetComponent: BasicComponent { }
    hrInterface: OperationInterface { }
    hrProvided: OperationProvidedRole { }
    hrSource.encapsulatedComponent -- hrSourceComponent
    hrTarget.encapsulatedComponent -- hrTargetComponent
    hrTargetComponent.providedRoles -- hrProvided
    hrProvided.providedInterface -- hrInterface
    hrCall: RealisedCall {
        built == "plain"
        shape == "retarget"
    }
    hrAction: ExternalCallAction { }
    hrHome: Home { }
    hrWritten: HomeOption { }
    hrChosen: HomeOption { }
    hrCall.action -- hrAction
    hrHome.calls -- hrAction
    hrHome.written -- hrWritten
    hrHome.home -- hrChosen
    hrCall.home -- hrWritten
    hrChosen.provider -- hrTarget
    hrChosen.interface -- hrInterface
    hrCall.logicalCaller -- hrSource
    forbid known {
        hrKnown: RealisedRole { }
        hrKnownRole: OperationRequiredRole { }
        hrKnown.source -- hrSource
        hrKnown.target -- hrTarget
        hrKnown.role -- hrKnownRole
        hrKnownRole.requiredInterface -- hrInterface
    }
    create hrRole: OperationRequiredRole {
        entityName = "realised_" + hrInterface.entityName
    }
    create hrConnector: AssemblyConnector {
        entityName = "realised"
    }
    create hrRealised: RealisedRole { }
    create hrSourceComponent.requiredRoles -- hrRole
    create hrRole.requiredInterface -- hrInterface
    create hrSystem.connectors -- hrConnector
    create hrConnector.requiringAssemblyContext -- hrSource
    create hrConnector.requiredRole -- hrRole
    create hrConnector.providingAssemblyContext -- hrTarget
    create hrConnector.providedRole -- hrProvided
    create hrRoot.roles -- hrRealised
    create hrRealised.source -- hrSource
    create hrRealised.target -- hrTarget
    create hrRealised.role -- hrRole
    create hrRealised.connector -- hrConnector
} do {
}

// To the chosen option: the derived role (the role as written kept), the signature of the same name on the
// option's interface, the option's assembly.
while match {
    haCall: RealisedCall {
        built == "plain"
        shape == "retarget"
    }
    haAction: ExternalCallAction { }
    haHome: Home { }
    haWritten: HomeOption { }
    haChosen: HomeOption { }
    haWrittenProvider: AssemblyContext { }
    haChosenProvider: AssemblyContext { }
    haSource: AssemblyContext { }
    haRole: OperationRequiredRole { }
    haNewRole: OperationRequiredRole { }
    haKnown: RealisedRole { }
    haService: OperationSignature { }
    haNewService: OperationSignature { }
    haInterface: OperationInterface { }
    haCall.action -- haAction
    haHome.calls -- haAction
    haHome.written -- haWritten
    haHome.home -- haChosen
    haChosen.provider -- haChosenProvider
    haChosen.interface -- haInterface
    haInterface.signatures -- haNewService
    where haNewService.entityName == haService.entityName
    haCall.logicalCaller -- haSource
    haKnown.source -- haSource
    haKnown.target -- haChosenProvider
    haKnown.role -- haNewRole
    haNewRole.requiredInterface -- haInterface
    delete haCall.home -- haWritten
    create haCall.home -- haChosen
    delete haAction.role -- haRole
    create haAction.role -- haNewRole
    create haCall.writtenRole -- haRole
    delete haAction.calledService -- haService
    create haAction.calledService -- haNewService
    delete haCall.logicalProvider -- haWrittenProvider
    create haCall.logicalProvider -- haChosenProvider
    delete haCall.provider -- haWrittenProvider
    create haCall.provider -- haChosenProvider
} do {
}

// The call site follows the applied option: the step form and the work of the same name on its interface, its
// schema (an effect step's in-transaction condition, AB37).
for match {
    hsCall: RealisedCall {
        shape == "retarget"
    }
    hsSite: CallSite { }
    hsOption: HomeOption { }
    hsInterface: OperationInterface { }
    hsOld: OperationSignature { }
    hsNew: OperationSignature { }
    hsCall.site -- hsSite
    hsCall.home -- hsOption
    hsOption.interface -- hsInterface
    hsInterface.signatures -- hsNew
    where hsNew.entityName == hsOld.entityName
    delete hsSite.stepService -- hsOld
    create hsSite.stepService -- hsNew
    forbid current {
        hsInterface.signatures -- hsOld
    }
} do {
}

for match {
    hjCall: RealisedCall {
        shape == "retarget"
    }
    hjSite: CallSite { }
    hjOption: HomeOption { }
    hjInterface: OperationInterface { }
    hjOld: OperationSignature { }
    hjNew: OperationSignature { }
    hjCall.site -- hjSite
    hjCall.home -- hjOption
    hjOption.interface -- hjInterface
    hjInterface.signatures -- hjNew
    where hjNew.entityName == hjOld.entityName
    delete hjSite.joinedService -- hjOld
    create hjSite.joinedService -- hjNew
    forbid current {
        hjInterface.signatures -- hjOld
    }
} do {
}

for match {
    hcCall: RealisedCall {
        shape == "retarget"
    }
    hcSite: CallSite { }
    hcOption: HomeOption { }
    hcOld: AssemblyContext { }
    hcSchema: AssemblyContext { }
    hcCall.site -- hcSite
    hcCall.home -- hcOption
    hcOption.schema -- hcSchema
    delete hcSite.providerSchema -- hcOld
    create hcSite.providerSchema -- hcSchema
} do {
}
