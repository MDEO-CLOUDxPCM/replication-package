using "../../metamodel/architecture.mm"

// The deliveries of realised notifications (DESIGN.md B3): one call per Delivery, each in a
// forked behaviour of its own of the notification's asynchronous fork (the earlier translation
// ran them one after the other in one; in the background either way), through the derived role
// of the owner to the delivery's provider (./roles.mt).

// The derived role of the owner to the delivery's provider (as ./roles.mt).
while match {
    rdRoot: Realisation { }
    rdSystem: System { }
    rdSource: AssemblyContext { }
    rdSourceComponent: BasicComponent { }
    rdTarget: AssemblyContext { }
    rdTargetComponent: BasicComponent { }
    rdInterface: OperationInterface { }
    rdProvided: OperationProvidedRole { }
    rdSource.encapsulatedComponent -- rdSourceComponent
    rdTarget.encapsulatedComponent -- rdTargetComponent
    rdTargetComponent.providedRoles -- rdProvided
    rdProvided.providedInterface -- rdInterface
    rdNotification: RealisedNotification { }
    rdDecision: Notification { }
    rdDelivery: Delivery { }
    rdService: OperationSignature { }
    rdNotification.notification -- rdDecision
    rdDecision.deliveries -- rdDelivery
    rdNotification.owner -- rdSource
    rdDelivery.provider -- rdTarget
    rdDelivery.service -- rdService
    rdInterface.signatures -- rdService
    forbid known {
        rdKnown: RealisedRole { }
        rdKnownRole: OperationRequiredRole { }
        rdKnown.source -- rdSource
        rdKnown.target -- rdTarget
        rdKnown.role -- rdKnownRole
        rdKnownRole.requiredInterface -- rdInterface
    }
    create rdRole: OperationRequiredRole {
        entityName = "realised_" + rdInterface.entityName
    }
    create rdConnector: AssemblyConnector {
        entityName = "realised"
    }
    create rdRealised: RealisedRole { }
    create rdSourceComponent.requiredRoles -- rdRole
    create rdRole.requiredInterface -- rdInterface
    create rdSystem.connectors -- rdConnector
    create rdConnector.requiringAssemblyContext -- rdSource
    create rdConnector.requiredRole -- rdRole
    create rdConnector.providingAssemblyContext -- rdTarget
    create rdConnector.providedRole -- rdProvided
    create rdRoot.roles -- rdRealised
    create rdRealised.source -- rdSource
    create rdRealised.target -- rdTarget
    create rdRealised.role -- rdRole
    create rdRealised.connector -- rdConnector
} do {
}

// A call per Delivery, at the end of the fork; a published one (with a broker) travels as a
// message, kind "published".
for match {
    ndRoot: Realisation { }
    ndRealised: RealisedNotification { }
    ndNotification: Notification { }
    ndRemote: RemoteCalls { }
    ndBroker: AssemblyContext { }
    ndDelivery: Delivery { }
    ndOwner: AssemblyContext { }
    ndProvider: AssemblyContext { }
    ndService: OperationSignature { }
    ndInterface: OperationInterface { }
    ndKnown: RealisedRole { }
    ndRole: OperationRequiredRole { }
    ndFork: ForkAction { }
    ndRealised.notification -- ndNotification
    where ndNotification.published != null && ndNotification.published!! == true
    ndRemote.broker -- ndBroker
    ndNotification.deliveries -- ndDelivery
    ndRealised.owner -- ndOwner
    ndDelivery.provider -- ndProvider
    ndDelivery.service -- ndService
    ndInterface.signatures -- ndService
    ndKnown.source -- ndOwner
    ndKnown.target -- ndProvider
    ndKnown.role -- ndRole
    ndRole.requiredInterface -- ndInterface
    ndRealised.fork -- ndFork
    forbid realised {
        ndExisting: RealisedCall { }
        ndExisting.delivery -- ndDelivery
    }
    create ndAction: ExternalCallAction {
        entityName = ndService.entityName
    }
    create ndCall: RealisedCall {
        shape = "plain"
        built = "plain"
        kind = "published"
    }
    create ndBranch: ForkedBehaviour { }
    create ndStart: StartAction { }
    create ndStop: StopAction { }
    create ndFork.asynchronousForkedBehaviours -- ndBranch
    create ndBranch.steps -- ndStart
    create ndBranch.steps -- ndAction
    create ndBranch.steps -- ndStop
    create ndStart.successor -- ndAction
    create ndAction.successor -- ndStop
    create ndCall.branch -- ndBranch
    create ndAction.role -- ndRole
    create ndAction.calledService -- ndService
    create ndRoot.calls -- ndCall
    create ndCall.action -- ndAction
    create ndCall.caller -- ndOwner
    create ndCall.provider -- ndProvider
    create ndCall.anchor -- ndAction
    create ndCall.delivery -- ndDelivery
    create ndCall.notification -- ndRealised
} do {
}

for match {
    nsRoot: Realisation { }
    nsRealised: RealisedNotification { }
    nsNotification: Notification { }
    nsDelivery: Delivery { }
    nsOwner: AssemblyContext { }
    nsProvider: AssemblyContext { }
    nsService: OperationSignature { }
    nsInterface: OperationInterface { }
    nsKnown: RealisedRole { }
    nsRole: OperationRequiredRole { }
    nsFork: ForkAction { }
    nsRealised.notification -- nsNotification
    nsNotification.deliveries -- nsDelivery
    nsRealised.owner -- nsOwner
    nsDelivery.provider -- nsProvider
    nsDelivery.service -- nsService
    nsInterface.signatures -- nsService
    nsKnown.source -- nsOwner
    nsKnown.target -- nsProvider
    nsKnown.role -- nsRole
    nsRole.requiredInterface -- nsInterface
    nsRealised.fork -- nsFork
    forbid realised {
        nsExisting: RealisedCall { }
        nsExisting.delivery -- nsDelivery
    }
    forbid published {
        where nsNotification.published != null && nsNotification.published!! == true
        nsRemote: RemoteCalls { }
        nsBroker: AssemblyContext { }
        nsRemote.broker -- nsBroker
    }
    create nsAction: ExternalCallAction {
        entityName = nsService.entityName
    }
    create nsCall: RealisedCall {
        shape = "plain"
        built = "plain"
        kind = "sync"
    }
    create nsBranch: ForkedBehaviour { }
    create nsStart: StartAction { }
    create nsStop: StopAction { }
    create nsFork.asynchronousForkedBehaviours -- nsBranch
    create nsBranch.steps -- nsStart
    create nsBranch.steps -- nsAction
    create nsBranch.steps -- nsStop
    create nsStart.successor -- nsAction
    create nsAction.successor -- nsStop
    create nsCall.branch -- nsBranch
    create nsAction.role -- nsRole
    create nsAction.calledService -- nsService
    create nsRoot.calls -- nsCall
    create nsCall.action -- nsAction
    create nsCall.caller -- nsOwner
    create nsCall.provider -- nsProvider
    create nsCall.anchor -- nsAction
    create nsCall.delivery -- nsDelivery
    create nsCall.notification -- nsRealised
} do {
}
