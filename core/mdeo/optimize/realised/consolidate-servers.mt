using "../../metamodel/architecture.mm"
import "../generic/consolidate-servers.mt" as consolidateServers
import "../sync/moves.mt" as syncMoves
import "../../transform/repair/placement.mt" as repairPlacement

// The MiSArch operator consolidate-servers with the realised layer 2 (DESIGN.md B4): the generic operator,
// the layer-3 repair of a change of placement, the layer-2 repair of a change of placement.
call consolidateServers()
call syncMoves()
call repairPlacement()
