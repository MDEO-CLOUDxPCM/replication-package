using "../../metamodel/architecture.mm"
import "../generic/move-group.mt" as moveGroup
import "../sync/moves.mt" as syncMoves
import "../../transform/repair/placement.mt" as repairPlacement

// G's group operator move-group with the realised layer 2 (DESIGN.md I1), wrapped as B's placement
// operators (optimize/realised/move-component.mt): the generic operator, the layer-3 repair of a
// change of placement, the layer-2 repair of a change of placement.
call moveGroup()
call syncMoves()
call repairPlacement()
