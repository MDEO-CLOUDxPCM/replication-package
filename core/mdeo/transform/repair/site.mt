using "../../metamodel/architecture.mm"
import "../realise/colocations.mt" as realiseColocations
import "../realise/plan.mt" as planCalls
import "./stale-blocks.mt" as repairStaleBlocks
import "../realise/section-teardown.mt" as teardownSection
import "../realise/section-build.mt" as buildSection
import "../realise/work.mt" as realiseWork
import "../realise/rates.mt" as realiseRates
import "../realise/links.mt" as realiseLinks
import "../realise/publish.mt" as realisePublish
import "./add-blocks.mt" as repairAddBlocks

// The layer-2 repair after a call site's mechanism changed (DESIGN.md B4), after the layer-3
// repair (which adds or removes Redirects, copy-store assemblies with their Colocations,
// Notifications and Deliveries): the parts of the whole realisation that depend on mechanisms,
// in its order. Placement is unchanged, so no block becomes local. Stale and new blocks go per call
// (./stale-blocks.mt, ./add-blocks.mt: one scan finds the calls; DESIGN.md S3 c).

call realiseColocations()
call planCalls()
call repairStaleBlocks()
call teardownSection()
call buildSection()
call realiseWork()
call realiseRates()
call realiseLinks()
call realisePublish()
call repairAddBlocks()
