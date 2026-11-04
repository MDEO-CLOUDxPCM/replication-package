using "../../metamodel/architecture.mm"

// Fixed part of the realisation (DESIGN.md B1.1): every behaviour of a base SEFF, with its SEFF and
// the SEFF-level action that holds it, so that later statements reach a call at any depth in one
// step. Base SEFFs are those of components that are not the realisation's (middleware). Level 1
// below a SEFF, then ./behaviours-deeper.mt one level deeper (the caller runs the deeper level as often as the models nest; three
// levels in all are enough for every model here, DESIGN.md B1.9).

// Every SEFF of a base component owns itself.
for match {
    o0Root: Realisation { }
    o0Component: BasicComponent { }
    o0Seff: ResourceDemandingSEFF { }
    o0Component.serviceEffectSpecifications -- o0Seff
    forbid derived {
        o0Realised: RealisedContainer { }
        o0Realised.component -- o0Component
    }
    forbid done {
        o0Existing: OwnedBehaviour { }
        o0Existing.behaviour -- o0Seff
    }
    create o0New: OwnedBehaviour { }
    create o0Root.behaviours -- o0New
    create o0New.behaviour -- o0Seff
    create o0New.seff -- o0Seff
} do {
}

for match {
    o1BranchRoot: Realisation { }
    o1BranchSeff: ResourceDemandingSEFF { }
    o1BranchOwned: OwnedBehaviour { }
    o1BranchUnit: BranchAction { }
    o1BranchChild: ResourceDemandingBehaviour { }
    o1BranchTransition: AbstractBranchTransition { }
    o1BranchOwned.behaviour -- o1BranchSeff
    o1BranchSeff.steps -- o1BranchUnit
    o1BranchUnit.branches -- o1BranchTransition
    o1BranchTransition.branchBehaviour -- o1BranchChild
    forbid done {
        o1BranchExisting: OwnedBehaviour { }
        o1BranchExisting.behaviour -- o1BranchChild
    }
    create o1BranchNew: OwnedBehaviour { }
    create o1BranchRoot.behaviours -- o1BranchNew
    create o1BranchNew.behaviour -- o1BranchChild
    create o1BranchNew.seff -- o1BranchSeff
    create o1BranchNew.unit -- o1BranchUnit
} do {
}

for match {
    o1LoopRoot: Realisation { }
    o1LoopSeff: ResourceDemandingSEFF { }
    o1LoopOwned: OwnedBehaviour { }
    o1LoopUnit: AbstractLoopAction { }
    o1LoopChild: ResourceDemandingBehaviour { }
    o1LoopOwned.behaviour -- o1LoopSeff
    o1LoopSeff.steps -- o1LoopUnit
    o1LoopUnit.bodyBehaviour -- o1LoopChild
    forbid done {
        o1LoopExisting: OwnedBehaviour { }
        o1LoopExisting.behaviour -- o1LoopChild
    }
    create o1LoopNew: OwnedBehaviour { }
    create o1LoopRoot.behaviours -- o1LoopNew
    create o1LoopNew.behaviour -- o1LoopChild
    create o1LoopNew.seff -- o1LoopSeff
    create o1LoopNew.unit -- o1LoopUnit
} do {
}

for match {
    o1AsyncRoot: Realisation { }
    o1AsyncSeff: ResourceDemandingSEFF { }
    o1AsyncOwned: OwnedBehaviour { }
    o1AsyncUnit: ForkAction { }
    o1AsyncChild: ForkedBehaviour { }
    o1AsyncOwned.behaviour -- o1AsyncSeff
    o1AsyncSeff.steps -- o1AsyncUnit
    o1AsyncUnit.asynchronousForkedBehaviours -- o1AsyncChild
    forbid done {
        o1AsyncExisting: OwnedBehaviour { }
        o1AsyncExisting.behaviour -- o1AsyncChild
    }
    create o1AsyncNew: OwnedBehaviour { }
    create o1AsyncRoot.behaviours -- o1AsyncNew
    create o1AsyncNew.behaviour -- o1AsyncChild
    create o1AsyncNew.seff -- o1AsyncSeff
    create o1AsyncNew.unit -- o1AsyncUnit
} do {
}

for match {
    o1SyncRoot: Realisation { }
    o1SyncSeff: ResourceDemandingSEFF { }
    o1SyncOwned: OwnedBehaviour { }
    o1SyncUnit: ForkAction { }
    o1SyncChild: ForkedBehaviour { }
    o1SyncPoint: SynchronisationPoint { }
    o1SyncOwned.behaviour -- o1SyncSeff
    o1SyncSeff.steps -- o1SyncUnit
    o1SyncUnit.synchronisingBehaviours -- o1SyncPoint
    o1SyncPoint.synchronousForkedBehaviours -- o1SyncChild
    forbid done {
        o1SyncExisting: OwnedBehaviour { }
        o1SyncExisting.behaviour -- o1SyncChild
    }
    create o1SyncNew: OwnedBehaviour { }
    create o1SyncRoot.behaviours -- o1SyncNew
    create o1SyncNew.behaviour -- o1SyncChild
    create o1SyncNew.seff -- o1SyncSeff
    create o1SyncNew.unit -- o1SyncUnit
} do {
}
