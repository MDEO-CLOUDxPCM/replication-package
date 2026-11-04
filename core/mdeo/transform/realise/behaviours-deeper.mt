using "../../metamodel/architecture.mm"

// Fixed part of the realisation (DESIGN.md B1.1): every behaviour of a base SEFF, with its SEFF and
// the SEFF-level action that holds it, so that later statements reach a call at any depth in one
// step. Base SEFFs are those of components that are not the realisation's (middleware). Level 1
// below a SEFF, then this file one level deeper (the caller runs the deeper level as often as the models nest; three
// levels in all are enough for every model here, DESIGN.md B1.9).

for match {
    o2BranchRoot: Realisation { }
    o2BranchOwned: OwnedBehaviour { }
    o2BranchParent: ResourceDemandingBehaviour { }
    o2BranchSeff: ResourceDemandingSEFF { }
    o2BranchUnit: AbstractAction { }
    o2BranchInner: BranchAction { }
    o2BranchChild: ResourceDemandingBehaviour { }
    o2BranchTransition: AbstractBranchTransition { }
    o2BranchOwned.behaviour -- o2BranchParent
    o2BranchOwned.seff -- o2BranchSeff
    o2BranchOwned.unit -- o2BranchUnit
    o2BranchParent.steps -- o2BranchInner
    o2BranchInner.branches -- o2BranchTransition
    o2BranchTransition.branchBehaviour -- o2BranchChild
    forbid done {
        o2BranchExisting: OwnedBehaviour { }
        o2BranchExisting.behaviour -- o2BranchChild
    }
    create o2BranchNew: OwnedBehaviour { }
    create o2BranchRoot.behaviours -- o2BranchNew
    create o2BranchNew.behaviour -- o2BranchChild
    create o2BranchNew.seff -- o2BranchSeff
    create o2BranchNew.unit -- o2BranchUnit
} do {
}

for match {
    o2LoopRoot: Realisation { }
    o2LoopOwned: OwnedBehaviour { }
    o2LoopParent: ResourceDemandingBehaviour { }
    o2LoopSeff: ResourceDemandingSEFF { }
    o2LoopUnit: AbstractAction { }
    o2LoopInner: AbstractLoopAction { }
    o2LoopChild: ResourceDemandingBehaviour { }
    o2LoopOwned.behaviour -- o2LoopParent
    o2LoopOwned.seff -- o2LoopSeff
    o2LoopOwned.unit -- o2LoopUnit
    o2LoopParent.steps -- o2LoopInner
    o2LoopInner.bodyBehaviour -- o2LoopChild
    forbid done {
        o2LoopExisting: OwnedBehaviour { }
        o2LoopExisting.behaviour -- o2LoopChild
    }
    create o2LoopNew: OwnedBehaviour { }
    create o2LoopRoot.behaviours -- o2LoopNew
    create o2LoopNew.behaviour -- o2LoopChild
    create o2LoopNew.seff -- o2LoopSeff
    create o2LoopNew.unit -- o2LoopUnit
} do {
}

for match {
    o2AsyncRoot: Realisation { }
    o2AsyncOwned: OwnedBehaviour { }
    o2AsyncParent: ResourceDemandingBehaviour { }
    o2AsyncSeff: ResourceDemandingSEFF { }
    o2AsyncUnit: AbstractAction { }
    o2AsyncInner: ForkAction { }
    o2AsyncChild: ForkedBehaviour { }
    o2AsyncOwned.behaviour -- o2AsyncParent
    o2AsyncOwned.seff -- o2AsyncSeff
    o2AsyncOwned.unit -- o2AsyncUnit
    o2AsyncParent.steps -- o2AsyncInner
    o2AsyncInner.asynchronousForkedBehaviours -- o2AsyncChild
    forbid done {
        o2AsyncExisting: OwnedBehaviour { }
        o2AsyncExisting.behaviour -- o2AsyncChild
    }
    create o2AsyncNew: OwnedBehaviour { }
    create o2AsyncRoot.behaviours -- o2AsyncNew
    create o2AsyncNew.behaviour -- o2AsyncChild
    create o2AsyncNew.seff -- o2AsyncSeff
    create o2AsyncNew.unit -- o2AsyncUnit
} do {
}

for match {
    o2SyncRoot: Realisation { }
    o2SyncOwned: OwnedBehaviour { }
    o2SyncParent: ResourceDemandingBehaviour { }
    o2SyncSeff: ResourceDemandingSEFF { }
    o2SyncUnit: AbstractAction { }
    o2SyncInner: ForkAction { }
    o2SyncChild: ForkedBehaviour { }
    o2SyncPoint: SynchronisationPoint { }
    o2SyncOwned.behaviour -- o2SyncParent
    o2SyncOwned.seff -- o2SyncSeff
    o2SyncOwned.unit -- o2SyncUnit
    o2SyncParent.steps -- o2SyncInner
    o2SyncInner.synchronisingBehaviours -- o2SyncPoint
    o2SyncPoint.synchronousForkedBehaviours -- o2SyncChild
    forbid done {
        o2SyncExisting: OwnedBehaviour { }
        o2SyncExisting.behaviour -- o2SyncChild
    }
    create o2SyncNew: OwnedBehaviour { }
    create o2SyncRoot.behaviours -- o2SyncNew
    create o2SyncNew.behaviour -- o2SyncChild
    create o2SyncNew.seff -- o2SyncSeff
    create o2SyncNew.unit -- o2SyncUnit
} do {
}
