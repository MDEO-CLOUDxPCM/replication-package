using "../../metamodel/architecture.mm"
import "../pinned/blocks-stale.mt" as pinnedRemoveStaleBlocks
import "../pinned/blocks-local.mt" as pinnedRemoveLocalBlocks

// ./stale-blocks.mt for the calls marked dirty only (placement repair, DESIGN.md B4.9). The blocks
// are conditions (`require`), not matched objects: one match per dirty call with a stale (or no
// longer remote) block, found by walking from the call, and the pinned removal takes all of the
// call's blocks at once (before: one match per (call, block), the planner paired every block with
// every dirty call; DESIGN.md S3).

for match {
    dsRoot: Realisation { }
    dsRoot.dirty -- dsCall
    dsCall: RealisedCall { }
    require stale {
        dsBlock: MiddlewareBlock { }
        dsBlock.realised -- dsCall
        where dsBlock.kind != dsCall.kind || dsBlock.shape != dsCall.shape
    }
} do {
    call pinnedRemoveStaleBlocks(pc = dsCall)
}

for match {
    dlRoot: Realisation { }
    dlRoot.dirty -- dlCall
    dlCall: RealisedCall { }
    require blocked {
        dlBlock: MiddlewareBlock { }
        dlBlock.realised -- dlCall
    }
    dlCaller: AssemblyContext { }
    dlProvider: AssemblyContext { }
    dlCallerContext: AllocationContext { }
    dlProviderContext: AllocationContext { }
    dlContainer: ResourceContainer { }
    dlCall.caller -- dlCaller
    dlCall.provider -- dlProvider
    dlCallerContext.assemblyContext -- dlCaller
    dlProviderContext.assemblyContext -- dlProvider
    dlCallerContext.resourceContainer -- dlContainer
    dlProviderContext.resourceContainer -- dlContainer
} do {
    call pinnedRemoveLocalBlocks(pc = dlCall)
}
