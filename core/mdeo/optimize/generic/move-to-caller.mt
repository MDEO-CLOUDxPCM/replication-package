using "../../metamodel/architecture.mm"

// Move a movable component into the container of a component that calls it (an assembly
// connector from a component on `target` to it), if it may run there (P10, DESIGN.md D58).
// The realisation's derived elements (entity name "realised": colocations, middleware, derived
// connectors) are skipped (DESIGN.md B1.8, G9).

match {
    placement: Placement { }
    moved: AllocationContext { }
    current: ResourceContainer { }
    target: ResourceContainer { }
    partner: AllocationContext { }
    caller: AssemblyContext { }
    callee: AssemblyContext { }
    connector: AssemblyConnector { }

    placement.allocation -- moved
    placement.candidates -- target
    moved.assemblyContext -- callee
    partner.assemblyContext -- caller
    partner.resourceContainer -- target
    connector.requiringAssemblyContext -- caller
    connector.providingAssemblyContext -- callee
    where partner.entityName == null || partner.entityName!! != "realised"
    where connector.entityName == null || connector.entityName!! != "realised"

    delete moved.resourceContainer -- current
    create moved.resourceContainer -- target
}
