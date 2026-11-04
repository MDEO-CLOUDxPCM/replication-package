using "../../metamodel/architecture.mm"

// The removal of notifications (DESIGN.md B3): the publish of one whose Notification was
// removed, the calls of removed Deliveries (their blocks are gone) with their forked behaviours,
// then the notification itself (with or without its CPU) once only its own behaviour is left.

while match {
    npRealised: RealisedNotification { }
    npBefore: AbstractAction { }
    npAfter: AbstractAction { }
    delete npPublish: ExternalCallAction { }
    delete npRealised.publish -- npPublish
    delete npBefore.successor -- npPublish
    delete npPublish.successor -- npAfter
    create npBefore.successor -- npAfter
    forbid notifying {
        npNotification: Notification { }
        npRealised.notification -- npNotification
    }
} do {
}

while match {
    delete ngCall: RealisedCall {
        shape == "gone"
    }
    delete ngAction: ExternalCallAction { }
    delete ngBranch: ForkedBehaviour { }
    delete ngStart: StartAction { }
    delete ngStop: StopAction { }
    delete ngCall.action -- ngAction
    delete ngCall.branch -- ngBranch
    delete ngBranch.steps -- ngStart
    delete ngBranch.steps -- ngAction
    delete ngBranch.steps -- ngStop
} do {
}

while match {
    delete nrRealised: RealisedNotification { }
    delete nrFork: ForkAction { }
    delete nrBody: ForkedBehaviour { }
    delete nrStart: StartAction { }
    delete nrStop: StopAction { }
    nrBefore: AbstractAction { }
    nrAfter: AbstractAction { }
    delete nrRealised.fork -- nrFork
    delete nrRealised.body -- nrBody
    delete nrBody.steps -- nrStart
    delete nrBody.steps -- nrStop
    delete nrStart.successor -- nrStop
    delete nrBefore.successor -- nrFork
    delete nrFork.successor -- nrAfter
    create nrBefore.successor -- nrAfter
    forbid notifying {
        nrNotification: Notification { }
        nrRealised.notification -- nrNotification
    }
    forbid delivering {
        nrDelivery: ForkedBehaviour { }
        nrFork.asynchronousForkedBehaviours -- nrDelivery
    }
    forbid working {
        nrWork: InternalAction { }
        nrRealised.cpu -- nrWork
    }
} do {
}

while match {
    delete ncRealised: RealisedNotification { }
    delete ncFork: ForkAction { }
    delete ncBody: ForkedBehaviour { }
    delete ncStart: StartAction { }
    delete ncStop: StopAction { }
    delete ncWork: InternalAction { }
    delete ncDemand: ParametricResourceDemand { }
    delete ncWorkDemand: RealisedDemand { }
    ncBefore: AbstractAction { }
    ncAfter: AbstractAction { }
    delete ncRealised.fork -- ncFork
    delete ncRealised.body -- ncBody
    delete ncRealised.cpu -- ncWork
    delete ncWork.resourceDemand -- ncDemand
    delete ncWorkDemand.demand -- ncDemand
    delete ncBody.steps -- ncStart
    delete ncBody.steps -- ncStop
    delete ncStart.successor -- ncStop
    delete ncBefore.successor -- ncWork
    delete ncWork.successor -- ncFork
    delete ncFork.successor -- ncAfter
    create ncBefore.successor -- ncAfter
    forbid notifying {
        ncNotification: Notification { }
        ncRealised.notification -- ncNotification
    }
    forbid delivering {
        ncDelivery: ForkedBehaviour { }
        ncFork.asynchronousForkedBehaviours -- ncDelivery
    }
} do {
}
