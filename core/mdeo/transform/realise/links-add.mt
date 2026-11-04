using "../../metamodel/architecture.mm"

// New middleware links (./links.mt), once per caller (pair): the pattern matches the caller (and
// provider) and requires a call between them; a broker link per caller with a self link.

// New links, once per caller (pair): the pattern matches the caller (and provider) and requires a
// call between them.
for match {
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
    require calling {
        asCall: RealisedCall { }
        asCall.caller -- asSource
    }
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

for match {
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
    require calling {
        apCall: RealisedCall { }
        apCall.caller -- apSource
        apCall.provider -- apProvider
    }
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

for match {
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
