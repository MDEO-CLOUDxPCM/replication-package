using "../../metamodel/architecture.mm"
import "./plan-placement.mt" as planPlacement
import "./plan-sites.mt" as planSites

// The plan (DESIGN.md B3): before the realisation changes anything, every call gets the shape it
// should have and the kind of middleware it needs across containers. Shapes, by precedence (the
// earlier translation's order of rules): gone (a delivery whose Delivery was removed), step (a
// step of an orchestrated workflow: rule 1 leaves it alone), redirect, composed or composedCache
// (a ComposedCall with a composer whose caller and provider sit in different containers), cache,
// async, plain. Kinds: published (a delivery of a published Notification, with a broker), reply
// (an asynchronous step, with a broker), async (an asynchronous call, with a broker), sync.

call planPlacement()
call planSites()
