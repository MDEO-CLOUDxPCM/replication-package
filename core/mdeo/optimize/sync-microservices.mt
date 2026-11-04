using "../metamodel/architecture.mm"
import "./sync/fixed-parts.mt" as syncFixedParts
import "./sync/unread-redirects.mt" as removeUnreadRedirects
import "./sync/stale-redirects.mt" as removeStaleRedirects
import "./sync/unread-deliveries.mt" as removeUnreadDeliveries
import "./sync/colocated-deliveries.mt" as removeColocatedDeliveries
import "./sync/stale-deliveries.mt" as removeStaleDeliveries
import "./sync/empty-publications.mt" as removeEmptyPublications
import "./sync/unread-store-assemblies.mt" as removeUnreadStoreAssemblies
import "./sync/store-assemblies.mt" as addStoreAssemblies
import "./sync/redirects.mt" as addRedirects
import "./sync/publications.mt" as addPublications
import "./sync/deliveries.mt" as addDeliveries

// The whole-model copy sync (the former layer 3, DESIGN.md H10-H16, AB49): realises the local copies
// (LocalCopy, CopyFeed, ../metamodel/architecture.mm) in PCM and the completions, which the
// realisation (transform/realise.mt) then realises like any other. The seeds are made with it
// (tools/sync_model.py) and it checks the operators (ARCH_CHECK_SYNC); the operators themselves
// repair locally (./sync/moves.mt, ./sync/site.mt, DESIGN.md H19). It is idempotent: it creates what
// is missing, deletes what no longer applies, and a second run changes nothing. What it made, it
// finds again through the derived references (CopyFeed.copyStore/read/write/redirect/deliveries,
// CopyStore, ArchitectureDecisions.copyStores/feedNotifications).
//
// 1. Fixed parts (./sync/fixed-parts.mt; they depend on the CopyFeeds only).
// 2. Removals: Redirects of calls that no longer read their copy, Deliveries of copies that are
//    not read or whose writer sits in the store's container, Notifications without Deliveries,
//    the assemblies of copy stores whose copies are all unread.
// 3. Additions: an assembly with a Colocation for every copy store with a read copy, a Redirect
//    of every call that reads its copy, a published Notification for every write that feeds a
//    read copy in another container and a Delivery per copy it feeds. (A Home is the
//    realisation's: it re-targets its calls, AB41.)
// Each statement of 2 and 3 is a transformation of its own in ./sync/, so that the repairs of an
// operator run only those its change can affect (./sync/moves.mt, ./sync/site.mt). Those that the
// mechanism repair runs at one site or copy store have an optional input that pins that object of
// their first pattern (mdeo's maybe-bound objects): called without it, as here, they cover the
// whole model. Removals come first, so a second run changes nothing.
//
// Readers' calls and writers sit directly in a SEFF (CopyFeed), and a call site allows one
// LocalCopy option.

call syncFixedParts()

// ═══ 2. Removals ══════════════════════════════════════════════════════════════════════
call removeUnreadRedirects()
call removeStaleRedirects()
call removeUnreadDeliveries()
call removeColocatedDeliveries()
call removeStaleDeliveries()
call removeEmptyPublications()
call removeUnreadStoreAssemblies()

// ═══ 3. Additions ═════════════════════════════════════════════════════════════════════
call addStoreAssemblies()
call addRedirects()
call addPublications()
call addDeliveries()
