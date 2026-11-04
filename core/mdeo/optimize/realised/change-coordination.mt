using "../../metamodel/architecture.mm"
import "../generic/change-coordination.mt" as changeCoordination
import "../../transform/repair/coordination.mt" as repairCoordination

// The MiSArch operator change-coordination with the realised layer 2 (DESIGN.md B4).
call changeCoordination()
call repairCoordination()
