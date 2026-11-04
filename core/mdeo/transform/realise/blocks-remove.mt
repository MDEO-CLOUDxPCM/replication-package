using "../../metamodel/architecture.mm"
import "./blocks-stale.mt" as removeStaleBlocks
import "./blocks-local.mt" as removeLocalBlocks

// Removal of middleware blocks (DESIGN.md B1.3, B3), right after the plan: a block goes when its
// call's shape or kind is no longer the one it was made for, or when the call is no longer
// remote (its caller and provider sit in one container). Its actions leave the chain, which is
// closed again (`while`: blocks may follow each other). One statement per block size and reason
// (1: ahead, 3: before, 4: reply).

call removeStaleBlocks()
call removeLocalBlocks()
