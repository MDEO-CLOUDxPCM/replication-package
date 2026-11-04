using "../../metamodel/architecture.mm"

// Removal of middleware blocks of calls that are no longer remote (caller and provider in one
// container; DESIGN.md B3, ./blocks-remove.mt).

while match {
    delete l1Block: MiddlewareBlock {
        size == 1
    }
    l1Call: RealisedCall { }
    l1Before: AbstractAction { }
    l1After: AbstractAction { }
    delete l1A0: ExternalCallAction { }
    delete l1Block.realised -- l1Call
    delete l1Block.first -- l1A0
    delete l1Block.last -- l1A0
    delete l1Before.successor -- l1A0
    delete l1A0.successor -- l1After
    create l1Before.successor -- l1After
    l1Caller: AssemblyContext { }
    l1Provider: AssemblyContext { }
    l1CallerContext: AllocationContext { }
    l1ProviderContext: AllocationContext { }
    l1Container: ResourceContainer { }
    l1Call.caller -- l1Caller
    l1Call.provider -- l1Provider
    l1CallerContext.assemblyContext -- l1Caller
    l1ProviderContext.assemblyContext -- l1Provider
    l1CallerContext.resourceContainer -- l1Container
    l1ProviderContext.resourceContainer -- l1Container
} do {
}

while match {
    delete l3Block: MiddlewareBlock {
        size == 3
    }
    l3Call: RealisedCall { }
    l3Before: AbstractAction { }
    l3After: AbstractAction { }
    delete l3A0: ExternalCallAction { }
    delete l3A1: ExternalCallAction { }
    delete l3A2: ExternalCallAction { }
    delete l3Block.realised -- l3Call
    delete l3Block.first -- l3A0
    delete l3Block.last -- l3A2
    delete l3A0.successor -- l3A1
    delete l3A1.successor -- l3A2
    delete l3Before.successor -- l3A0
    delete l3A2.successor -- l3After
    create l3Before.successor -- l3After
    l3Caller: AssemblyContext { }
    l3Provider: AssemblyContext { }
    l3CallerContext: AllocationContext { }
    l3ProviderContext: AllocationContext { }
    l3Container: ResourceContainer { }
    l3Call.caller -- l3Caller
    l3Call.provider -- l3Provider
    l3CallerContext.assemblyContext -- l3Caller
    l3ProviderContext.assemblyContext -- l3Provider
    l3CallerContext.resourceContainer -- l3Container
    l3ProviderContext.resourceContainer -- l3Container
} do {
}

while match {
    delete l4Block: MiddlewareBlock {
        size == 4
    }
    l4Call: RealisedCall { }
    l4Before: AbstractAction { }
    l4After: AbstractAction { }
    delete l4A0: ExternalCallAction { }
    delete l4A1: ExternalCallAction { }
    delete l4A2: ExternalCallAction { }
    delete l4A3: ExternalCallAction { }
    delete l4Block.realised -- l4Call
    delete l4Block.first -- l4A0
    delete l4Block.last -- l4A3
    delete l4A0.successor -- l4A1
    delete l4A1.successor -- l4A2
    delete l4A2.successor -- l4A3
    delete l4Before.successor -- l4A0
    delete l4A3.successor -- l4After
    create l4Before.successor -- l4After
    l4Caller: AssemblyContext { }
    l4Provider: AssemblyContext { }
    l4CallerContext: AllocationContext { }
    l4ProviderContext: AllocationContext { }
    l4Container: ResourceContainer { }
    l4Call.caller -- l4Caller
    l4Call.provider -- l4Provider
    l4CallerContext.assemblyContext -- l4Caller
    l4ProviderContext.assemblyContext -- l4Provider
    l4CallerContext.resourceContainer -- l4Container
    l4ProviderContext.resourceContainer -- l4Container
} do {
}
