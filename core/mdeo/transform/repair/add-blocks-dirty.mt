using "../../metamodel/architecture.mm"
import "../pinned/blocks.mt" as pinnedAddBlocks

// ./add-blocks.mt for the calls marked dirty only (placement repair, DESIGN.md B4.9).

for match {
    daRoot: Realisation { }
    daRoot.dirty -- daCall
    daCall: RealisedCall { }
    daCaller: AssemblyContext { }
    daProvider: AssemblyContext { }
    daCallerContext: AllocationContext { }
    daProviderContext: AllocationContext { }
    daCallerContainer: ResourceContainer { }
    daProviderContainer: ResourceContainer { }
    daMiddleware: RealisedContainer { }
    daMiddlewareAssembly: AssemblyContext { }
    daCall.caller -- daCaller
    daCall.provider -- daProvider
    daCallerContext.assemblyContext -- daCaller
    daProviderContext.assemblyContext -- daProvider
    daCallerContext.resourceContainer -- daCallerContainer
    daProviderContext.resourceContainer -- daProviderContainer
    daMiddleware.container -- daProviderContainer
    daMiddleware.assembly -- daMiddlewareAssembly
    forbid blocked {
        daBlock: MiddlewareBlock { }
        daBlock.realised -- daCall
    }
} do {
    call pinnedAddBlocks(pc = daCall)
}
