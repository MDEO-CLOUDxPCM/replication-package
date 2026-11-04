using "../../metamodel/architecture.mm"
import "./colocated-deliveries.mt" as removeColocatedDeliveries
import "./empty-publications.mt" as removeEmptyPublications
import "./publications.mt" as addPublications
import "./deliveries.mt" as addDeliveries

// The copy repair after a change of placement (DESIGN.md H19): the statements of the whole-model
// copy sync (../sync-microservices.mt) that depend on placement, in its order, and only those. The
// copies depend on placement only through pairs that sit together or apart: a writer and the
// consumer of its copy (Deliveries, the writer's published Notification). Copy stores follow their
// consumer (Colocation), Redirects and the fixed parts do not depend on it. The statements run
// whole-model: pinned to what moved, a move would need one match per affected writer or feed (up
// to 56), and with mdeo's fixed cost per match that is slower than the four whole-model
// statements. A new copy concept that depends on placement must be added here; the check mode
// (ARCH_CHECK_SYNC) finds what is missing.

call removeColocatedDeliveries()
call removeEmptyPublications()
call addPublications()
call addDeliveries()
