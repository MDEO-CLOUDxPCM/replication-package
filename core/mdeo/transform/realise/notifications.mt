using "../../metamodel/architecture.mm"

// Notifications (DESIGN.md B3, rule 0 of the earlier translation): after the action, the CPU
// (cpuMs > 0, on the owner's container) and an asynchronous fork with, published through a
// broker, the publish (./publish.mt, once the owner's middleware link exists) and one call per
// Delivery (./deliveries.mt, once its derived role exists). The owner is the assembly of the
// component whose SEFF holds the action. `while`: several notifications may follow one action,
// several deliveries go into one fork.
// Order after one action (the plugin's, translate.rs: unpublished before published; DESIGN.md
// B3.8 (c), B4.6 (5)), independent of match order and of history: an unpublished notification
// goes right after its action; a published one after the action and after every unpublished one
// realised there (right after the fork of the last of them: the realised unpublished one whose
// successor is not the CPU or fork of another), so unpublished ones realised later still come
// first. Among several of one kind the plugin orders by object name, which no pattern sees:
// match order there (MiSArch, P10 and domain seeds: equal unpublished CPUs, at most one
// published per action). Statements: n* unpublished, p* published (pa*: right after the action,
// no unpublished one realised there; pb*: after the last unpublished one); *w with CPU, *f without.

// unpublished, with CPU
while match {
    nwRoot: Realisation { }
    nwDecisions: ArchitectureDecisions { }
    nwNotification: Notification { }
    nwAction: AbstractAction { }
    nwNext: AbstractAction { }
    nwBehaviour: ResourceDemandingBehaviour { }
    nwOwned: OwnedBehaviour { }
    nwSeff: ResourceDemandingSEFF { }
    nwComponent: BasicComponent { }
    nwOwner: AssemblyContext { }
    nwContext: AllocationContext { }
    nwContainer: ResourceContainer { }
    nwRates: RealisedContainer { }
    nwNotification.after -- nwAction
    nwBehaviour.steps -- nwAction
    nwOwned.behaviour -- nwBehaviour
    nwOwned.seff -- nwSeff
    nwComponent.serviceEffectSpecifications -- nwSeff
    nwOwner.encapsulatedComponent -- nwComponent
    nwContext.assemblyContext -- nwOwner
    nwContext.resourceContainer -- nwContainer
    nwRates.container -- nwContainer
    where (nwNotification.cpuMs != null && nwNotification.cpuMs!! > 0.0) && (nwNotification.published == null || nwNotification.published!! == false)
    delete nwAction.successor -- nwNext
    forbid realised {
        nwExisting: RealisedNotification { }
        nwExisting.notification -- nwNotification
    }
    create nwRealised: RealisedNotification { }
    create nwWork: InternalAction {
        entityName = "notify"
    }
    create nwDemand: ParametricResourceDemand {
        specification = "Exp(1.0 / ((" + (nwNotification.cpuMs!! / nwDecisions.msPerTimeUnit) + ") * (" + nwRates.cpuRate + ")))"
        requiredResource = ProcessingResourceType.CPU
    }
    create nwWorkDemand: RealisedDemand {
        ms = nwNotification.cpuMs!!
        kind = "CPU"
        rate = nwRates.cpuRate
    }
    create nwFork: ForkAction {
        entityName = "notification"
    }
    create nwBody: ForkedBehaviour { }
    create nwStart: StartAction { }
    create nwStop: StopAction { }
    create nwRoot.notifications -- nwRealised
    create nwRealised.notification -- nwNotification
    create nwRealised.owner -- nwOwner
    create nwRealised.fork -- nwFork
    create nwRealised.body -- nwBody
    create nwRealised.cpu -- nwWork
    create nwBehaviour.steps -- nwWork
    create nwBehaviour.steps -- nwFork
    create nwAction.successor -- nwWork
    create nwWork.successor -- nwFork
    create nwFork.successor -- nwNext
    create nwWork.resourceDemand -- nwDemand
    create nwRoot.demands -- nwWorkDemand
    create nwWorkDemand.demand -- nwDemand
    create nwWorkDemand.owner -- nwOwner
    create nwFork.asynchronousForkedBehaviours -- nwBody
    create nwBody.steps -- nwStart
    create nwBody.steps -- nwStop
    create nwStart.successor -- nwStop
} do {
}

// unpublished, without CPU
while match {
    nfRoot: Realisation { }
    nfNotification: Notification { }
    nfAction: AbstractAction { }
    nfNext: AbstractAction { }
    nfBehaviour: ResourceDemandingBehaviour { }
    nfOwned: OwnedBehaviour { }
    nfSeff: ResourceDemandingSEFF { }
    nfComponent: BasicComponent { }
    nfOwner: AssemblyContext { }
    nfNotification.after -- nfAction
    nfBehaviour.steps -- nfAction
    nfOwned.behaviour -- nfBehaviour
    nfOwned.seff -- nfSeff
    nfComponent.serviceEffectSpecifications -- nfSeff
    nfOwner.encapsulatedComponent -- nfComponent
    where (nfNotification.cpuMs == null || nfNotification.cpuMs!! <= 0.0) && (nfNotification.published == null || nfNotification.published!! == false)
    delete nfAction.successor -- nfNext
    forbid realised {
        nfExisting: RealisedNotification { }
        nfExisting.notification -- nfNotification
    }
    create nfRealised: RealisedNotification { }
    create nfFork: ForkAction {
        entityName = "notification"
    }
    create nfBody: ForkedBehaviour { }
    create nfStart: StartAction { }
    create nfStop: StopAction { }
    create nfRoot.notifications -- nfRealised
    create nfRealised.notification -- nfNotification
    create nfRealised.owner -- nfOwner
    create nfRealised.fork -- nfFork
    create nfRealised.body -- nfBody
    create nfBehaviour.steps -- nfFork
    create nfAction.successor -- nfFork
    create nfFork.successor -- nfNext
    create nfFork.asynchronousForkedBehaviours -- nfBody
    create nfBody.steps -- nfStart
    create nfBody.steps -- nfStop
    create nfStart.successor -- nfStop
} do {
}

// published, with CPU, no unpublished one realised after the action
while match {
    pawRoot: Realisation { }
    pawDecisions: ArchitectureDecisions { }
    pawNotification: Notification { }
    pawAction: AbstractAction { }
    pawNext: AbstractAction { }
    pawBehaviour: ResourceDemandingBehaviour { }
    pawOwned: OwnedBehaviour { }
    pawSeff: ResourceDemandingSEFF { }
    pawComponent: BasicComponent { }
    pawOwner: AssemblyContext { }
    pawContext: AllocationContext { }
    pawContainer: ResourceContainer { }
    pawRates: RealisedContainer { }
    pawNotification.after -- pawAction
    pawBehaviour.steps -- pawAction
    pawOwned.behaviour -- pawBehaviour
    pawOwned.seff -- pawSeff
    pawComponent.serviceEffectSpecifications -- pawSeff
    pawOwner.encapsulatedComponent -- pawComponent
    pawContext.assemblyContext -- pawOwner
    pawContext.resourceContainer -- pawContainer
    pawRates.container -- pawContainer
    where (pawNotification.cpuMs != null && pawNotification.cpuMs!! > 0.0) && (pawNotification.published != null && pawNotification.published!! == true)
    delete pawAction.successor -- pawNext
    forbid realised {
        pawExisting: RealisedNotification { }
        pawExisting.notification -- pawNotification
    }
    forbid unpublished {
        pawOther: RealisedNotification { }
        pawOtherNotification: Notification { }
        pawOther.notification -- pawOtherNotification
        pawOtherNotification.after -- pawAction
        where (pawOtherNotification.published == null || pawOtherNotification.published!! == false)
    }
    create pawRealised: RealisedNotification { }
    create pawWork: InternalAction {
        entityName = "notify"
    }
    create pawDemand: ParametricResourceDemand {
        specification = "Exp(1.0 / ((" + (pawNotification.cpuMs!! / pawDecisions.msPerTimeUnit) + ") * (" + pawRates.cpuRate + ")))"
        requiredResource = ProcessingResourceType.CPU
    }
    create pawWorkDemand: RealisedDemand {
        ms = pawNotification.cpuMs!!
        kind = "CPU"
        rate = pawRates.cpuRate
    }
    create pawFork: ForkAction {
        entityName = "notification"
    }
    create pawBody: ForkedBehaviour { }
    create pawStart: StartAction { }
    create pawStop: StopAction { }
    create pawRoot.notifications -- pawRealised
    create pawRealised.notification -- pawNotification
    create pawRealised.owner -- pawOwner
    create pawRealised.fork -- pawFork
    create pawRealised.body -- pawBody
    create pawRealised.cpu -- pawWork
    create pawBehaviour.steps -- pawWork
    create pawBehaviour.steps -- pawFork
    create pawAction.successor -- pawWork
    create pawWork.successor -- pawFork
    create pawFork.successor -- pawNext
    create pawWork.resourceDemand -- pawDemand
    create pawRoot.demands -- pawWorkDemand
    create pawWorkDemand.demand -- pawDemand
    create pawWorkDemand.owner -- pawOwner
    create pawFork.asynchronousForkedBehaviours -- pawBody
    create pawBody.steps -- pawStart
    create pawBody.steps -- pawStop
    create pawStart.successor -- pawStop
} do {
}

// published, without CPU, no unpublished one realised after the action
while match {
    pafRoot: Realisation { }
    pafNotification: Notification { }
    pafAction: AbstractAction { }
    pafNext: AbstractAction { }
    pafBehaviour: ResourceDemandingBehaviour { }
    pafOwned: OwnedBehaviour { }
    pafSeff: ResourceDemandingSEFF { }
    pafComponent: BasicComponent { }
    pafOwner: AssemblyContext { }
    pafNotification.after -- pafAction
    pafBehaviour.steps -- pafAction
    pafOwned.behaviour -- pafBehaviour
    pafOwned.seff -- pafSeff
    pafComponent.serviceEffectSpecifications -- pafSeff
    pafOwner.encapsulatedComponent -- pafComponent
    where (pafNotification.cpuMs == null || pafNotification.cpuMs!! <= 0.0) && (pafNotification.published != null && pafNotification.published!! == true)
    delete pafAction.successor -- pafNext
    forbid realised {
        pafExisting: RealisedNotification { }
        pafExisting.notification -- pafNotification
    }
    forbid unpublished {
        pafOther: RealisedNotification { }
        pafOtherNotification: Notification { }
        pafOther.notification -- pafOtherNotification
        pafOtherNotification.after -- pafAction
        where (pafOtherNotification.published == null || pafOtherNotification.published!! == false)
    }
    create pafRealised: RealisedNotification { }
    create pafFork: ForkAction {
        entityName = "notification"
    }
    create pafBody: ForkedBehaviour { }
    create pafStart: StartAction { }
    create pafStop: StopAction { }
    create pafRoot.notifications -- pafRealised
    create pafRealised.notification -- pafNotification
    create pafRealised.owner -- pafOwner
    create pafRealised.fork -- pafFork
    create pafRealised.body -- pafBody
    create pafBehaviour.steps -- pafFork
    create pafAction.successor -- pafFork
    create pafFork.successor -- pafNext
    create pafFork.asynchronousForkedBehaviours -- pafBody
    create pafBody.steps -- pafStart
    create pafBody.steps -- pafStop
    create pafStart.successor -- pafStop
} do {
}

// published, with CPU, after the last unpublished one
while match {
    pbwRoot: Realisation { }
    pbwDecisions: ArchitectureDecisions { }
    pbwNotification: Notification { }
    pbwAction: AbstractAction { }
    pbwLast: RealisedNotification { }
    pbwLastNotification: Notification { }
    pbwAnchor: ForkAction { }
    pbwNext: AbstractAction { }
    pbwBehaviour: ResourceDemandingBehaviour { }
    pbwOwned: OwnedBehaviour { }
    pbwSeff: ResourceDemandingSEFF { }
    pbwComponent: BasicComponent { }
    pbwOwner: AssemblyContext { }
    pbwContext: AllocationContext { }
    pbwContainer: ResourceContainer { }
    pbwRates: RealisedContainer { }
    pbwNotification.after -- pbwAction
    pbwBehaviour.steps -- pbwAction
    pbwOwned.behaviour -- pbwBehaviour
    pbwOwned.seff -- pbwSeff
    pbwComponent.serviceEffectSpecifications -- pbwSeff
    pbwOwner.encapsulatedComponent -- pbwComponent
    pbwContext.assemblyContext -- pbwOwner
    pbwContext.resourceContainer -- pbwContainer
    pbwRates.container -- pbwContainer
    pbwLast.notification -- pbwLastNotification
    pbwLastNotification.after -- pbwAction
    pbwLast.fork -- pbwAnchor
    where (pbwNotification.cpuMs != null && pbwNotification.cpuMs!! > 0.0) && (pbwNotification.published != null && pbwNotification.published!! == true) && (pbwLastNotification.published == null || pbwLastNotification.published!! == false)
    delete pbwAnchor.successor -- pbwNext
    forbid realised {
        pbwExisting: RealisedNotification { }
        pbwExisting.notification -- pbwNotification
    }
    forbid unpublishedCpu {
        pbwCpuOther: RealisedNotification { }
        pbwCpuOtherNotification: Notification { }
        pbwCpuOtherAction: InternalAction { }
        pbwCpuOther.notification -- pbwCpuOtherNotification
        pbwCpuOtherNotification.after -- pbwAction
        pbwCpuOther.cpu -- pbwCpuOtherAction
        pbwAnchor.successor -- pbwCpuOtherAction
        where (pbwCpuOtherNotification.published == null || pbwCpuOtherNotification.published!! == false)
    }
    forbid unpublishedFork {
        pbwForkOther: RealisedNotification { }
        pbwForkOtherNotification: Notification { }
        pbwForkOtherAction: ForkAction { }
        pbwForkOther.notification -- pbwForkOtherNotification
        pbwForkOtherNotification.after -- pbwAction
        pbwForkOther.fork -- pbwForkOtherAction
        pbwAnchor.successor -- pbwForkOtherAction
        where (pbwForkOtherNotification.published == null || pbwForkOtherNotification.published!! == false)
    }
    create pbwRealised: RealisedNotification { }
    create pbwWork: InternalAction {
        entityName = "notify"
    }
    create pbwDemand: ParametricResourceDemand {
        specification = "Exp(1.0 / ((" + (pbwNotification.cpuMs!! / pbwDecisions.msPerTimeUnit) + ") * (" + pbwRates.cpuRate + ")))"
        requiredResource = ProcessingResourceType.CPU
    }
    create pbwWorkDemand: RealisedDemand {
        ms = pbwNotification.cpuMs!!
        kind = "CPU"
        rate = pbwRates.cpuRate
    }
    create pbwFork: ForkAction {
        entityName = "notification"
    }
    create pbwBody: ForkedBehaviour { }
    create pbwStart: StartAction { }
    create pbwStop: StopAction { }
    create pbwRoot.notifications -- pbwRealised
    create pbwRealised.notification -- pbwNotification
    create pbwRealised.owner -- pbwOwner
    create pbwRealised.fork -- pbwFork
    create pbwRealised.body -- pbwBody
    create pbwRealised.cpu -- pbwWork
    create pbwBehaviour.steps -- pbwWork
    create pbwBehaviour.steps -- pbwFork
    create pbwAnchor.successor -- pbwWork
    create pbwWork.successor -- pbwFork
    create pbwFork.successor -- pbwNext
    create pbwWork.resourceDemand -- pbwDemand
    create pbwRoot.demands -- pbwWorkDemand
    create pbwWorkDemand.demand -- pbwDemand
    create pbwWorkDemand.owner -- pbwOwner
    create pbwFork.asynchronousForkedBehaviours -- pbwBody
    create pbwBody.steps -- pbwStart
    create pbwBody.steps -- pbwStop
    create pbwStart.successor -- pbwStop
} do {
}

// published, without CPU, after the last unpublished one
while match {
    pbfRoot: Realisation { }
    pbfNotification: Notification { }
    pbfAction: AbstractAction { }
    pbfLast: RealisedNotification { }
    pbfLastNotification: Notification { }
    pbfAnchor: ForkAction { }
    pbfNext: AbstractAction { }
    pbfBehaviour: ResourceDemandingBehaviour { }
    pbfOwned: OwnedBehaviour { }
    pbfSeff: ResourceDemandingSEFF { }
    pbfComponent: BasicComponent { }
    pbfOwner: AssemblyContext { }
    pbfNotification.after -- pbfAction
    pbfBehaviour.steps -- pbfAction
    pbfOwned.behaviour -- pbfBehaviour
    pbfOwned.seff -- pbfSeff
    pbfComponent.serviceEffectSpecifications -- pbfSeff
    pbfOwner.encapsulatedComponent -- pbfComponent
    pbfLast.notification -- pbfLastNotification
    pbfLastNotification.after -- pbfAction
    pbfLast.fork -- pbfAnchor
    where (pbfNotification.cpuMs == null || pbfNotification.cpuMs!! <= 0.0) && (pbfNotification.published != null && pbfNotification.published!! == true) && (pbfLastNotification.published == null || pbfLastNotification.published!! == false)
    delete pbfAnchor.successor -- pbfNext
    forbid realised {
        pbfExisting: RealisedNotification { }
        pbfExisting.notification -- pbfNotification
    }
    forbid unpublishedCpu {
        pbfCpuOther: RealisedNotification { }
        pbfCpuOtherNotification: Notification { }
        pbfCpuOtherAction: InternalAction { }
        pbfCpuOther.notification -- pbfCpuOtherNotification
        pbfCpuOtherNotification.after -- pbfAction
        pbfCpuOther.cpu -- pbfCpuOtherAction
        pbfAnchor.successor -- pbfCpuOtherAction
        where (pbfCpuOtherNotification.published == null || pbfCpuOtherNotification.published!! == false)
    }
    forbid unpublishedFork {
        pbfForkOther: RealisedNotification { }
        pbfForkOtherNotification: Notification { }
        pbfForkOtherAction: ForkAction { }
        pbfForkOther.notification -- pbfForkOtherNotification
        pbfForkOtherNotification.after -- pbfAction
        pbfForkOther.fork -- pbfForkOtherAction
        pbfAnchor.successor -- pbfForkOtherAction
        where (pbfForkOtherNotification.published == null || pbfForkOtherNotification.published!! == false)
    }
    create pbfRealised: RealisedNotification { }
    create pbfFork: ForkAction {
        entityName = "notification"
    }
    create pbfBody: ForkedBehaviour { }
    create pbfStart: StartAction { }
    create pbfStop: StopAction { }
    create pbfRoot.notifications -- pbfRealised
    create pbfRealised.notification -- pbfNotification
    create pbfRealised.owner -- pbfOwner
    create pbfRealised.fork -- pbfFork
    create pbfRealised.body -- pbfBody
    create pbfBehaviour.steps -- pbfFork
    create pbfAnchor.successor -- pbfFork
    create pbfFork.successor -- pbfNext
    create pbfFork.asynchronousForkedBehaviours -- pbfBody
    create pbfBody.steps -- pbfStart
    create pbfBody.steps -- pbfStop
    create pbfStart.successor -- pbfStop
} do {
}
