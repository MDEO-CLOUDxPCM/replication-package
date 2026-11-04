using "../../metamodel/architecture.mm"
import "../realise/plan.mt" as planCalls
import "./stale-blocks.mt" as repairStaleBlocks
import "../realise/section-teardown.mt" as teardownSection
import "../realise/section-build.mt" as buildSection
import "../realise/links-add.mt" as realiseNewLinks
import "./add-blocks.mt" as repairAddBlocks
import "../realise/links-teardown.mt" as teardownUnused

// The layer-2 repair after a workflow's coordination changed (DESIGN.md B4): its steps' shapes
// and kinds (the whole plan: a step that is no longer one may become plain, composed, ...), their
// blocks, the orchestration taken apart or built, links of the orchestrator, blocks. Whole-model
// sections: a workflow changes many calls at once, for which the per-call pinned statements
// (B4.5) cost more; only the stale blocks and the new blocks go per call (one scan finds the calls,
// the guarded pinned statements are cheap since DESIGN.md S3; S3 c). Layer 3 does not depend on coordination; placement is unchanged (no link is
// re-targeted).

call planCalls()
call repairStaleBlocks()
call teardownSection()
call buildSection()
call teardownUnused()
call realiseNewLinks()
call repairAddBlocks()
