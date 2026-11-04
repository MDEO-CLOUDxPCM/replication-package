using "../../metamodel/architecture.mm"
import "../pinned/blocks-stale.mt" as pinnedRemoveStaleBlocks
import "../pinned/blocks-local.mt" as pinnedRemoveLocalBlocks

// The removal of middleware blocks in a repair (DESIGN.md B4.5): ../realise/blocks-remove.mt's
// statements pinned to each call that has a stale block (its shape or kind changed) or a block
// although it is no longer remote; one scan of the blocks finds them.

for match {
    dsCall: RealisedCall { }
    dsBlock: MiddlewareBlock { }
    dsBlock.realised -- dsCall
    where dsBlock.kind != dsCall.kind || dsBlock.shape != dsCall.shape
} do {
    call pinnedRemoveStaleBlocks(pc = dsCall)
}
for match {
    dlCall: RealisedCall { }
    dlBlock: MiddlewareBlock { }
    dlCaller: AssemblyContext { }
    dlProvider: AssemblyContext { }
    dlCallerContext: AllocationContext { }
    dlProviderContext: AllocationContext { }
    dlContainer: ResourceContainer { }
    dlBlock.realised -- dlCall
    dlCall.caller -- dlCaller
    dlCall.provider -- dlProvider
    dlCallerContext.assemblyContext -- dlCaller
    dlProviderContext.assemblyContext -- dlProvider
    dlCallerContext.resourceContainer -- dlContainer
    dlProviderContext.resourceContainer -- dlContainer
} do {
    call pinnedRemoveLocalBlocks(pc = dlCall)
}
