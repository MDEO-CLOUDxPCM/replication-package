using "../metamodel/architecture.mm"
import "./realise/fixed.mt" as realiseFixed
import "./realise/colocations.mt" as realiseColocations
import "./realise/placements.mt" as realisePlacements
import "./realise/homes.mt" as markHomeCalls
import "./realise/homes-retarget.mt" as retargetHomeCalls
import "./realise/plan.mt" as planCalls
import "./realise/blocks-remove.mt" as removeBlocks
import "./realise/work.mt" as realiseWork
import "./realise/rates.mt" as realiseRates
import "./realise/links.mt" as realiseLinks
import "./realise/publish.mt" as realisePublish
import "./realise/blocks.mt" as addBlocks
import "./realise/deployables.mt" as realiseDeployables
import "./realise/section-teardown.mt" as teardownSection
import "./realise/section-build.mt" as buildSection

// The whole realisation of layer 2 (DESIGN.md B1, B3): idempotent (a second run changes nothing)
// and the reference of the operators' local repairs (../optimize/realised/). Order:
//  1. the fixed parts, once (./realise/fixed.mt), the colocations (containers of assemblies) and
//     the placements (the container of each AllocationContext, for the placement repair);
//  2. the homes (AB41): a Home's call whose applied option is not the chosen one is taken apart (its blocks and
//     structure, as for a changed shape) and re-targeted to the chosen option (./realise/homes.mt);
//     then the plan: each call's shape and middleware kind;
//  3. removals: middleware blocks of a changed shape or kind or of a call no longer remote, then
//     every structure a call has but should not have, orchestrations of workflows no longer
//     orchestrated, notifications without their Notification and calls of removed Deliveries;
//  4. additions: notifications, derived roles, call sites (redirect, composed, cache, async),
//     orchestrations, deliveries, Work demands, the rates of derived demands, middleware links,
//     publishes, middleware blocks, deployables.
// A section that can only change something under a cheap condition (a call whose structure
// differs from its plan, a Notification without its realisation, ...) runs behind an `if match`
// on it, so that a run with nothing to do there costs one match.

call realiseFixed()
call realiseColocations()
call realisePlacements()
call markHomeCalls()
if match {
    rtCall: RealisedCall {
        shape == "retarget"
    }
} then {
    call removeBlocks()
    call teardownSection()
    call retargetHomeCalls()
}
call planCalls()
call removeBlocks()
call teardownSection()
call buildSection()
call realiseWork()
call realiseRates()
call realiseLinks()
call realisePublish()
call addBlocks()
call realiseDeployables()
