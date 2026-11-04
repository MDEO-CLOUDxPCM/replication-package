using "../../metamodel/architecture.mm"
import "../pinned/blocks.mt" as pinnedAddBlocks

// The middleware blocks in a repair (DESIGN.md B4.5): ../realise/blocks.mt's statements pinned to
// each remote call without blocks (a call's blocks are made together and removed together); one
// scan of the calls finds them.

for match {
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
