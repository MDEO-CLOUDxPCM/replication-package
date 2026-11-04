using "../../metamodel/architecture.mm"

// Middleware links re-targeted after a move (./links.mt): the connector of a self link to the
// middleware of its source's container, of a peer link to that of its target's.

for match {
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
