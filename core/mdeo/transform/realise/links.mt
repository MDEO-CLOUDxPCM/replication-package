using "../../metamodel/architecture.mm"
import "./links-retarget.mt" as realiseLinkTargets
import "./links-add.mt" as realiseNewLinks
import "./links-teardown.mt" as teardownUnused

// Middleware links (DESIGN.md B1.3): per caller a derived role and connector to the middleware
// of its own container (self) and to the broker (broker), per (caller, provider) one to the
// middleware of the provider's container (peer). Made when first needed, removed when no call needs
// them any more (./links-teardown.mt, DESIGN.md AB22); a move
// re-targets the connectors of self and peer links. Containers reached directly have no
// middleware: no link ends there.

// Leftovers first (./links-teardown.mt), then re-target (moves).
call teardownUnused()
call realiseLinkTargets()
call realiseNewLinks()
