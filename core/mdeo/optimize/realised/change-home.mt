using "../../metamodel/architecture.mm"
import "../generic/change-home.mt" as changeHome
import "./home-repair.mt" as repairHome

// The operator change-home with the realised layer 2 (DESIGN.md AB38): the generic operator (another of a
// Home's options), then the home repair (./home-repair.mt: the whole realisation re-targets the calls, AB41).
call changeHome()
call repairHome()
