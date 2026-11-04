using "../../metamodel/architecture.mm"

// Derived roles (DESIGN.md B3, `role_to` of the earlier translation): a required role of a base
// component for an interface, and its connector to a providing assembly, for a call that the
// realisation re-points (a redirect, a composed call, an orchestrated step) or makes (a
// delivery: ./deliveries.mt). One per (source, target, interface), made when first needed and kept. `while`: two
// calls may need the same one (a `for` would make it twice). Only calls not yet re-pointed need
// one: the objects of a `forbid` are matched injectively with the pattern's, so a call's current
// (derived) role would hide itself. So a Home's call re-targeted to a derived role (./homes-retarget.mt) and then
// re-pointed by its own caller (an orchestrated step) gets a second derived role for the same (source, target,
// interface), on purpose: ./workflow.mt ws/wt and ./teardown-calls.mt tm/tw2/tr match the two injectively (AB66).

// A redirect: the caller to the Redirect's provider, for the interface of its service.
while match {
    rrRoot: Realisation { }
    rrSystem: System { }
    rrSource: AssemblyContext { }
    rrSourceComponent: BasicComponent { }
    rrTarget: AssemblyContext { }
    rrTargetComponent: BasicComponent { }
    rrInterface: OperationInterface { }
    rrProvided: OperationProvidedRole { }
    rrSource.encapsulatedComponent -- rrSourceComponent
    rrTarget.encapsulatedComponent -- rrTargetComponent
    rrTargetComponent.providedRoles -- rrProvided
    rrProvided.providedInterface -- rrInterface
    rrCall: RealisedCall {
        shape == "redirect"
        built == "plain"
    }
    rrAction: ExternalCallAction { }
    rrRedirect: Redirect { }
    rrService: OperationSignature { }
    rrCall.action -- rrAction
    rrRedirect.`call` -- rrAction
    rrRedirect.provider -- rrTarget
    rrRedirect.service -- rrService
    rrInterface.signatures -- rrService
    rrCall.logicalCaller -- rrSource
    forbid known {
        rrKnown: RealisedRole { }
        rrKnownRole: OperationRequiredRole { }
        rrKnown.source -- rrSource
        rrKnown.target -- rrTarget
        rrKnown.role -- rrKnownRole
        rrKnownRole.requiredInterface -- rrInterface
    }
    create rrRole: OperationRequiredRole {
        entityName = "realised_" + rrInterface.entityName
    }
    create rrConnector: AssemblyConnector {
        entityName = "realised"
    }
    create rrRealised: RealisedRole { }
    create rrSourceComponent.requiredRoles -- rrRole
    create rrRole.requiredInterface -- rrInterface
    create rrSystem.connectors -- rrConnector
    create rrConnector.requiringAssemblyContext -- rrSource
    create rrConnector.requiredRole -- rrRole
    create rrConnector.providingAssemblyContext -- rrTarget
    create rrConnector.providedRole -- rrProvided
    create rrRoot.roles -- rrRealised
    create rrRealised.source -- rrSource
    create rrRealised.target -- rrTarget
    create rrRealised.role -- rrRole
    create rrRealised.connector -- rrConnector
} do {
}

// A composed call: the composer (the caller of the CallSite's composer call) to the provider.
while match {
    rcRoot: Realisation { }
    rcSystem: System { }
    rcSource: AssemblyContext { }
    rcSourceComponent: BasicComponent { }
    rcTarget: AssemblyContext { }
    rcTargetComponent: BasicComponent { }
    rcInterface: OperationInterface { }
    rcProvided: OperationProvidedRole { }
    rcSource.encapsulatedComponent -- rcSourceComponent
    rcTarget.encapsulatedComponent -- rcTargetComponent
    rcTargetComponent.providedRoles -- rcProvided
    rcProvided.providedInterface -- rcInterface
    rcCall: RealisedCall {
        built == "plain"
    }
    rcAction: ExternalCallAction { }
    rcSite: CallSite { }
    rcComposerAction: ExternalCallAction { }
    rcComposerCall: RealisedCall { }
    rcCallRole: OperationRequiredRole { }
    rcCall.action -- rcAction
    rcCall.site -- rcSite
    rcSite.composer -- rcComposerAction
    rcComposerCall.action -- rcComposerAction
    rcComposerCall.caller -- rcSource
    rcCall.logicalProvider -- rcTarget
    rcAction.role -- rcCallRole
    rcCallRole.requiredInterface -- rcInterface
    where rcCall.shape == "composed" || rcCall.shape == "composedCache"
    forbid known {
        rcKnown: RealisedRole { }
        rcKnownRole: OperationRequiredRole { }
        rcKnown.source -- rcSource
        rcKnown.target -- rcTarget
        rcKnown.role -- rcKnownRole
        rcKnownRole.requiredInterface -- rcInterface
    }
    create rcRole: OperationRequiredRole {
        entityName = "realised_" + rcInterface.entityName
    }
    create rcConnector: AssemblyConnector {
        entityName = "realised"
    }
    create rcRealised: RealisedRole { }
    create rcSourceComponent.requiredRoles -- rcRole
    create rcRole.requiredInterface -- rcInterface
    create rcSystem.connectors -- rcConnector
    create rcConnector.requiringAssemblyContext -- rcSource
    create rcConnector.requiredRole -- rcRole
    create rcConnector.providingAssemblyContext -- rcTarget
    create rcConnector.providedRole -- rcProvided
    create rcRoot.roles -- rcRealised
    create rcRealised.source -- rcSource
    create rcRealised.target -- rcTarget
    create rcRealised.role -- rcRole
    create rcRealised.connector -- rcConnector
} do {
}

// An orchestrated step: the orchestrator to the step's provider.
while match {
    roRoot: Realisation { }
    roSystem: System { }
    roSource: AssemblyContext { }
    roSourceComponent: BasicComponent { }
    roTarget: AssemblyContext { }
    roTargetComponent: BasicComponent { }
    roInterface: OperationInterface { }
    roProvided: OperationProvidedRole { }
    roSource.encapsulatedComponent -- roSourceComponent
    roTarget.encapsulatedComponent -- roTargetComponent
    roTargetComponent.providedRoles -- roProvided
    roProvided.providedInterface -- roInterface
    roCall: RealisedCall {
        shape == "step"
        built == "plain"
    }
    roAction: ExternalCallAction { }
    roStep: WorkflowStep { }
    roPlan: WorkflowPlan { }
    roCallRole: OperationRequiredRole { }
    roCall.action -- roAction
    roStep.`call` -- roCall
    roPlan.steps -- roStep
    roPlan.orchestrator -- roSource
    roCall.logicalProvider -- roTarget
    roAction.role -- roCallRole
    roCallRole.requiredInterface -- roInterface
    forbid known {
        roKnown: RealisedRole { }
        roKnownRole: OperationRequiredRole { }
        roKnown.source -- roSource
        roKnown.target -- roTarget
        roKnown.role -- roKnownRole
        roKnownRole.requiredInterface -- roInterface
    }
    create roRole: OperationRequiredRole {
        entityName = "realised_" + roInterface.entityName
    }
    create roConnector: AssemblyConnector {
        entityName = "realised"
    }
    create roRealised: RealisedRole { }
    create roSourceComponent.requiredRoles -- roRole
    create roRole.requiredInterface -- roInterface
    create roSystem.connectors -- roConnector
    create roConnector.requiringAssemblyContext -- roSource
    create roConnector.requiredRole -- roRole
    create roConnector.providingAssemblyContext -- roTarget
    create roConnector.providedRole -- roProvided
    create roRoot.roles -- roRealised
    create roRealised.source -- roSource
    create roRealised.target -- roTarget
    create roRealised.role -- roRole
    create roRealised.connector -- roConnector
} do {
}


// An orchestrated step whose provider is the orchestrator itself (pattern objects are matched
// injectively, so source and target as one object need a statement of their own).
while match {
    rsRoot: Realisation { }
    rsSystem: System { }
    rsSource: AssemblyContext { }
    rsSourceComponent: BasicComponent { }
    rsInterface: OperationInterface { }
    rsProvided: OperationProvidedRole { }
    rsSource.encapsulatedComponent -- rsSourceComponent
    rsSourceComponent.providedRoles -- rsProvided
    rsProvided.providedInterface -- rsInterface
    rsCall: RealisedCall {
        shape == "step"
        built == "plain"
    }
    rsAction: ExternalCallAction { }
    rsStep: WorkflowStep { }
    rsPlan: WorkflowPlan { }
    rsCallRole: OperationRequiredRole { }
    rsCall.action -- rsAction
    rsStep.`call` -- rsCall
    rsPlan.steps -- rsStep
    rsPlan.orchestrator -- rsSource
    rsCall.logicalProvider -- rsSource
    rsAction.role -- rsCallRole
    rsCallRole.requiredInterface -- rsInterface
    forbid known {
        rsKnown: RealisedRole { }
        rsKnownRole: OperationRequiredRole { }
        rsKnown.source -- rsSource
        rsKnown.target -- rsSource
        rsKnown.role -- rsKnownRole
        rsKnownRole.requiredInterface -- rsInterface
    }
    create rsRole: OperationRequiredRole {
        entityName = "realised_" + rsInterface.entityName
    }
    create rsConnector: AssemblyConnector {
        entityName = "realised"
    }
    create rsRealised: RealisedRole { }
    create rsSourceComponent.requiredRoles -- rsRole
    create rsRole.requiredInterface -- rsInterface
    create rsSystem.connectors -- rsConnector
    create rsConnector.requiringAssemblyContext -- rsSource
    create rsConnector.requiredRole -- rsRole
    create rsConnector.providingAssemblyContext -- rsSource
    create rsConnector.providedRole -- rsProvided
    create rsRoot.roles -- rsRealised
    create rsRealised.source -- rsSource
    create rsRealised.target -- rsSource
    create rsRealised.role -- rsRole
    create rsRealised.connector -- rsConnector
} do {
}
