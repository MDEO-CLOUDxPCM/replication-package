using "../../../metamodel/architecture.mm"

// The coupled partners of `component` (DESIGN.md G2): the movable components on `source` that it
// calls or that call it (an assembly connector between their assembly contexts, either direction)
// and that may run on `destination` (their Placement's candidates). Components without a Placement
// (fixed ones, the realisation's derived allocations) are never partners, and the realisation's
// derived connectors (entity name "realised", e.g. a redirect to a copy store) couple nothing: only
// the logical architecture counts (DESIGN.md B1.1, B1.8). Changes nothing.
in component: AllocationContext
in source: ResourceContainer
in destination: ResourceContainer
out found: List<AllocationContext>

for match {
    component { }
    source { }
    destination { }
    callee: AllocationContext { }
    calleePlacement: Placement { }
    componentAssembly: AssemblyContext { }
    calleeAssembly: AssemblyContext { }
    toCallee: AssemblyConnector { }
    component.assemblyContext -- componentAssembly
    callee.resourceContainer -- source
    callee.assemblyContext -- calleeAssembly
    calleePlacement.allocation -- callee
    calleePlacement.candidates -- destination
    toCallee.requiringAssemblyContext -- componentAssembly
    toCallee.providingAssemblyContext -- calleeAssembly
    where toCallee.entityName == null || toCallee.entityName!! != "realised"
    found += callee
} do {
}
for match {
    component { }
    source { }
    destination { }
    caller: AllocationContext { }
    callerPlacement: Placement { }
    calledAssembly: AssemblyContext { }
    callerAssembly: AssemblyContext { }
    fromCaller: AssemblyConnector { }
    component.assemblyContext -- calledAssembly
    caller.resourceContainer -- source
    caller.assemblyContext -- callerAssembly
    callerPlacement.allocation -- caller
    callerPlacement.candidates -- destination
    fromCaller.requiringAssemblyContext -- callerAssembly
    fromCaller.providingAssemblyContext -- calledAssembly
    where fromCaller.entityName == null || fromCaller.entityName!! != "realised"
    found += caller
} do {
}
