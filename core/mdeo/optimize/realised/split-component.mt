using "../../metamodel/architecture.mm"
import "../generic/split-component.mt" as splitComponent
import "../sync/moves.mt" as syncMoves
import "../../transform/repair/placement.mt" as repairPlacement

// The MiSArch operator split-component with the realised layer 2 (DESIGN.md B4): the generic operator,
// the layer-3 repair of a change of placement, the layer-2 repair of a change of placement.
call splitComponent()
call syncMoves()
call repairPlacement()
