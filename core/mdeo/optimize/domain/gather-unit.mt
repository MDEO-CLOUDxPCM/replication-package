using "../../metamodel/architecture.mm"
import "../generic/gather-unit.mt" as gatherUnit
import "../sync/moves.mt" as syncMoves
import "../../transform/repair/placement.mt" as repairPlacement

// G's unit operator gather-unit with the realised layer 2 (DESIGN.md I6), wrapped as B's placement
// operators (optimize/realised/move-component.mt): the generic operator, the layer-3 repair of a
// change of placement, the layer-2 repair of a change of placement. Needs UnitGroups in the model.
call gatherUnit()
call syncMoves()
call repairPlacement()
