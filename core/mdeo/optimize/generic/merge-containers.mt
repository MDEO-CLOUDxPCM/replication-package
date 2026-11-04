using "../../metamodel/architecture.mm"

// Merge two containers: every movable component of `gone` that may run on `keep` moves there.
// `gone` must call `keep` (an assembly connector from a component on `gone` to one on `keep`), and
// at least one of its components must be allowed on `keep`. `keep` keeps its own replicas.
// The realisation's derived elements (entity name "realised": colocations, middleware, derived
// connectors) are skipped (DESIGN.md B1.8, G9).

// Fail fast (DESIGN.md S4): whether any pair qualifies, as one witness found by walking from a
// connector, before the draw below pairs every container with every other one to find out. It
// changes nothing and does not affect the draw: it holds exactly when the draw finds a pair (a
// connector from a component on one container to one on another, and a movable component on the
// first that may run on the second: the caller itself, else another one).
if match {
    wConnector: AssemblyConnector { }
    wCaller: AssemblyContext { }
    wCallee: AssemblyContext { }
    wCallerAllocation: AllocationContext { }
    wCalleeAllocation: AllocationContext { }
    wGone: ResourceContainer { }
    wKeep: ResourceContainer { }
    wPlacement: Placement { }
    wConnector.requiringAssemblyContext -- wCaller
    wConnector.providingAssemblyContext -- wCallee
    wCallerAllocation.assemblyContext -- wCaller
    wCalleeAllocation.assemblyContext -- wCallee
    wCallerAllocation.resourceContainer -- wGone
    wCalleeAllocation.resourceContainer -- wKeep
    wPlacement.allocation -- wCallerAllocation
    wPlacement.candidates -- wKeep
    where wConnector.entityName == null || wConnector.entityName!! != "realised"
    where wCallerAllocation.entityName == null || wCallerAllocation.entityName!! != "realised"
    where wCalleeAllocation.entityName == null || wCalleeAllocation.entityName!! != "realised"
} then {
} else {
    match {
        vConnector: AssemblyConnector { }
        vCaller: AssemblyContext { }
        vCallee: AssemblyContext { }
        vCallerAllocation: AllocationContext { }
        vCalleeAllocation: AllocationContext { }
        vGone: ResourceContainer { }
        vKeep: ResourceContainer { }
        vConnector.requiringAssemblyContext -- vCaller
        vConnector.providingAssemblyContext -- vCallee
        vCallerAllocation.assemblyContext -- vCaller
        vCalleeAllocation.assemblyContext -- vCallee
        vCallerAllocation.resourceContainer -- vGone
        vCalleeAllocation.resourceContainer -- vKeep
        where vConnector.entityName == null || vConnector.entityName!! != "realised"
        where vCallerAllocation.entityName == null || vCallerAllocation.entityName!! != "realised"
        where vCalleeAllocation.entityName == null || vCalleeAllocation.entityName!! != "realised"
        require vMovable {
            vPlacement: Placement { }
            vMovableAllocation: AllocationContext { }
            vPlacement.allocation -- vMovableAllocation
            vPlacement.candidates -- vKeep
            vMovableAllocation.resourceContainer -- vGone
        }
    }
}

match {
    gone: ResourceContainer { }
    keep: ResourceContainer { }

    require calls {
        callerAllocation: AllocationContext { }
        calleeAllocation: AllocationContext { }
        caller: AssemblyContext { }
        callee: AssemblyContext { }
        connector: AssemblyConnector { }
        callerAllocation.resourceContainer -- gone
        callerAllocation.assemblyContext -- caller
        calleeAllocation.resourceContainer -- keep
        calleeAllocation.assemblyContext -- callee
        connector.requiringAssemblyContext -- caller
        connector.providingAssemblyContext -- callee
        where callerAllocation.entityName == null || callerAllocation.entityName!! != "realised"
        where calleeAllocation.entityName == null || calleeAllocation.entityName!! != "realised"
        where connector.entityName == null || connector.entityName!! != "realised"
    }

    require movable {
        movablePlacement: Placement { }
        movableAllocation: AllocationContext { }
        movablePlacement.allocation -- movableAllocation
        movablePlacement.candidates -- keep
        movableAllocation.resourceContainer -- gone
    }
}

for match {
    gone { }
    keep { }
    placement: Placement { }
    moved: AllocationContext { }
    placement.allocation -- moved
    placement.candidates -- keep
    delete moved.resourceContainer -- gone
} do {
    match {
        keep { }
        moved { }
        create moved.resourceContainer -- keep
    }
}
