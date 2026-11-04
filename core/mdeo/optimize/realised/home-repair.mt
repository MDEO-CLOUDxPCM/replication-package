using "../../metamodel/architecture.mm"
import "../../transform/realise.mt" as realise

// The repair after Home decisions changed (DESIGN.md AB38, AB41; ./change-home.mt, ../crossover/take-home.mt): the
// whole realisation, which re-targets every call of a Home whose applied option is not the chosen one
// (transform/realise/homes.mt) and then realises its mechanism against the new target. The whole realisation is the
// reference (sync-all.mt), so this is history independent by construction.
call realise()
