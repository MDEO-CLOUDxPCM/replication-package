using "../../metamodel/architecture.mm"

// The longest-chain levels of the workflows' steps (./workflow-plan.mt, fixed part).

// Longest chains: b follows a when b's call sits in the SEFF that a calls.
while match {
    plPlan: WorkflowPlan { }
    plBefore: WorkflowStep { }
    plAfter: WorkflowStep {
        level = plBefore.level + 1
    }
    plBeforeCall: RealisedCall { }
    plAfterCall: RealisedCall { }
    plBeforeAction: ExternalCallAction { }
    plService: OperationSignature { }
    plProvider: AssemblyContext { }
    plProviderComponent: BasicComponent { }
    plSeff: ResourceDemandingSEFF { }
    plPlan.steps -- plBefore
    plPlan.steps -- plAfter
    plBefore.`call` -- plBeforeCall
    plAfter.`call` -- plAfterCall
    plBeforeCall.action -- plBeforeAction
    plBeforeAction.calledService -- plService
    plBeforeCall.logicalProvider -- plProvider
    plProvider.encapsulatedComponent -- plProviderComponent
    plProviderComponent.serviceEffectSpecifications -- plSeff
    plSeff.describedService -- plService
    plAfterCall.seff -- plSeff
    where plAfter.level <= plBefore.level && plBefore.level < 64
} do {
}

// An effect step's call goes to the provider's step form, which calls the step's work
// (CallSite.joinedService, DESIGN.md AB37): b follows a when b's call sits in a's work.
while match {
    pjPlan: WorkflowPlan { }
    pjBefore: WorkflowStep { }
    pjAfter: WorkflowStep {
        level = pjBefore.level + 1
    }
    pjBeforeCall: RealisedCall { }
    pjAfterCall: RealisedCall { }
    pjBeforeSite: CallSite { }
    pjService: OperationSignature { }
    pjProvider: AssemblyContext { }
    pjProviderComponent: BasicComponent { }
    pjSeff: ResourceDemandingSEFF { }
    pjPlan.steps -- pjBefore
    pjPlan.steps -- pjAfter
    pjBefore.`call` -- pjBeforeCall
    pjAfter.`call` -- pjAfterCall
    pjBeforeCall.site -- pjBeforeSite
    pjBeforeSite.joinedService -- pjService
    pjBeforeCall.logicalProvider -- pjProvider
    pjProvider.encapsulatedComponent -- pjProviderComponent
    pjProviderComponent.serviceEffectSpecifications -- pjSeff
    pjSeff.describedService -- pjService
    pjAfterCall.seff -- pjSeff
    where pjAfter.level <= pjBefore.level && pjBefore.level < 64
} do {
}

