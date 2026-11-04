using "../../metamodel/architecture.mm"

// ../realise/links.mt in a placement repair (DESIGN.md B4.9): the self links of moved sources and
// the peer links of moved targets re-targeted (Realisation.moved), new links only for the callers
// (and pairs) of calls marked dirty. `while`: several dirty calls share a caller or a pair, and a
// `for match` would make a link per call.

for match {
    lsRoot: Realisation { }
    lsPlacement: RealisedPlacement { }
    lsRoot.moved -- lsPlacement
    lsPlacement.allocation -- lsContext
    lsLink: MiddlewareLink {
        kind == "self"
    }
    lsSource: AssemblyContext { }
    lsConnector: AssemblyConnector { }
    lsOld: AssemblyContext { }
    lsOldRole: OperationProvidedRole { }
    lsContext: AllocationContext { }
    lsContainer: ResourceContainer { }
    lsMiddleware: RealisedContainer { }
    lsNew: AssemblyContext { }
    lsComponent: BasicComponent { }
    lsNewRole: OperationProvidedRole { }
    lsLink.source -- lsSource
    lsLink.connector -- lsConnector
    lsContext.assemblyContext -- lsSource
    lsContext.resourceContainer -- lsContainer
    lsMiddleware.container -- lsContainer
    lsMiddleware.assembly -- lsNew
    lsMiddleware.component -- lsComponent
    lsComponent.providedRoles -- lsNewRole
    delete lsConnector.providingAssemblyContext -- lsOld
    delete lsConnector.providedRole -- lsOldRole
    create lsConnector.providingAssemblyContext -- lsNew
    create lsConnector.providedRole -- lsNewRole
} do {
}

for match {
    lpRoot: Realisation { }
    lpPlacement: RealisedPlacement { }
    lpRoot.moved -- lpPlacement
    lpPlacement.allocation -- lpContext
    lpLink: MiddlewareLink {
        kind == "peer"
    }
    lpTarget: AssemblyContext { }
    lpConnector: AssemblyConnector { }
    lpOld: AssemblyContext { }
    lpOldRole: OperationProvidedRole { }
    lpContext: AllocationContext { }
    lpContainer: ResourceContainer { }
    lpMiddleware: RealisedContainer { }
    lpNew: AssemblyContext { }
    lpComponent: BasicComponent { }
    lpNewRole: OperationProvidedRole { }
    lpLink.target -- lpTarget
    lpLink.connector -- lpConnector
    lpContext.assemblyContext -- lpTarget
    lpContext.resourceContainer -- lpContainer
    lpMiddleware.container -- lpContainer
    lpMiddleware.assembly -- lpNew
    lpMiddleware.component -- lpComponent
    lpComponent.providedRoles -- lpNewRole
    delete lpConnector.providingAssemblyContext -- lpOld
    delete lpConnector.providedRole -- lpOldRole
    create lpConnector.providingAssemblyContext -- lpNew
    create lpConnector.providedRole -- lpNewRole
} do {
}

while match {
    asRoot: Realisation { }
    asSystem: System { }
    asInterface: OperationInterface { }
    asSource: AssemblyContext { }
    asSourceComponent: BasicComponent { }
    asContext: AllocationContext { }
    asContainer: ResourceContainer { }
    asMiddleware: RealisedContainer { }
    asTarget: AssemblyContext { }
    asComponent: BasicComponent { }
    asProvided: OperationProvidedRole { }
    asRoot.middleware -- asInterface
    asCall: RealisedCall { }
    asRoot.dirty -- asCall
    asCall.caller -- asSource
    asSource.encapsulatedComponent -- asSourceComponent
    asContext.assemblyContext -- asSource
    asContext.resourceContainer -- asContainer
    asMiddleware.container -- asContainer
    asMiddleware.assembly -- asTarget
    asMiddleware.component -- asComponent
    asComponent.providedRoles -- asProvided
    forbid linked {
        asExisting: MiddlewareLink {
            kind == "self"
        }
        asExisting.source -- asSource
    }
    create asRole: OperationRequiredRole {
        entityName = "realised_middleware"
    }
    create asConnector: AssemblyConnector {
        entityName = "realised"
    }
    create asLink: MiddlewareLink {
        kind = "self"
    }
    create asSourceComponent.requiredRoles -- asRole
    create asRole.requiredInterface -- asInterface
    create asSystem.connectors -- asConnector
    create asConnector.requiringAssemblyContext -- asSource
    create asConnector.requiredRole -- asRole
    create asConnector.providingAssemblyContext -- asTarget
    create asConnector.providedRole -- asProvided
    create asRoot.links -- asLink
    create asLink.source -- asSource
    create asLink.target -- asSource
    create asLink.role -- asRole
    create asLink.connector -- asConnector
} do {
}

while match {
    apRoot: Realisation { }
    apSystem: System { }
    apInterface: OperationInterface { }
    apSource: AssemblyContext { }
    apSourceComponent: BasicComponent { }
    apProvider: AssemblyContext { }
    apContext: AllocationContext { }
    apContainer: ResourceContainer { }
    apMiddleware: RealisedContainer { }
    apTarget: AssemblyContext { }
    apComponent: BasicComponent { }
    apProvided: OperationProvidedRole { }
    apRoot.middleware -- apInterface
    apCall: RealisedCall { }
    apRoot.dirty -- apCall
    apCall.caller -- apSource
    apCall.provider -- apProvider
    apSource.encapsulatedComponent -- apSourceComponent
    apContext.assemblyContext -- apProvider
    apContext.resourceContainer -- apContainer
    apMiddleware.container -- apContainer
    apMiddleware.assembly -- apTarget
    apMiddleware.component -- apComponent
    apComponent.providedRoles -- apProvided
    forbid linked {
        apExisting: MiddlewareLink {
            kind == "peer"
        }
        apExisting.source -- apSource
        apExisting.target -- apProvider
    }
    create apRole: OperationRequiredRole {
        entityName = "realised_middleware"
    }
    create apConnector: AssemblyConnector {
        entityName = "realised"
    }
    create apLink: MiddlewareLink {
        kind = "peer"
    }
    create apSourceComponent.requiredRoles -- apRole
    create apRole.requiredInterface -- apInterface
    create apSystem.connectors -- apConnector
    create apConnector.requiringAssemblyContext -- apSource
    create apConnector.requiredRole -- apRole
    create apConnector.providingAssemblyContext -- apTarget
    create apConnector.providedRole -- apProvided
    create apRoot.links -- apLink
    create apLink.source -- apSource
    create apLink.target -- apProvider
    create apLink.role -- apRole
    create apLink.connector -- apConnector
} do {
}

while match {
    abRoot: Realisation { }
    abSystem: System { }
    abRemote: RemoteCalls { }
    abBroker: AssemblyContext { }
    abBrokerComponent: BasicComponent { }
    abProvided: OperationProvidedRole { }
    abInterface: OperationInterface { }
    abSelf: MiddlewareLink {
        kind == "self"
    }
    abSource: AssemblyContext { }
    abSourceComponent: BasicComponent { }
    abRemote.broker -- abBroker
    abBroker.encapsulatedComponent -- abBrokerComponent
    abBrokerComponent.providedRoles -- abProvided
    abProvided.providedInterface -- abInterface
    abSelf.source -- abSource
    abCall: RealisedCall { }
    abRoot.dirty -- abCall
    abCall.caller -- abSource
    abSource.encapsulatedComponent -- abSourceComponent
    forbid linked {
        abExisting: MiddlewareLink {
            kind == "broker"
        }
        abExisting.source -- abSource
    }
    create abRole: OperationRequiredRole {
        entityName = "realised_broker"
    }
    create abConnector: AssemblyConnector {
        entityName = "realised"
    }
    create abLink: MiddlewareLink {
        kind = "broker"
    }
    create abSourceComponent.requiredRoles -- abRole
    create abRole.requiredInterface -- abInterface
    create abSystem.connectors -- abConnector
    create abConnector.requiringAssemblyContext -- abSource
    create abConnector.requiredRole -- abRole
    create abConnector.providingAssemblyContext -- abBroker
    create abConnector.providedRole -- abProvided
    create abRoot.links -- abLink
    create abLink.source -- abSource
    create abLink.target -- abBroker
    create abLink.role -- abRole
    create abLink.connector -- abConnector
} do {
}
