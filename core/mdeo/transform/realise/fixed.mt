using "../../metamodel/architecture.mm"
import "./containers.mt" as realiseContainers
import "./middleware.mt" as realiseMiddleware
import "./behaviours.mt" as realiseBehaviours
import "./behaviours-deeper.mt" as realiseDeeperBehaviours
import "./calls.mt" as realiseCalls
import "./workflow-plan.mt" as planWorkflows

// The fixed parts of the realisation (DESIGN.md B3): what no operator changes (base rates,
// sidecars, middleware components, the owned behaviours of base SEFFs, the RealisedCalls of base
// calls, the workflows' plans). They are made once, on the model as written, and marked
// (Realisation.fixed): on a realised model their patterns would also find what the realisation
// derived (forks, branches, middleware calls), and they cost a large part of the whole
// realisation.

if match {
    fxDecisions: ArchitectureDecisions { }
    forbid done {
        fxDone: Realisation {
            fixed == true
        }
        fxDecisions.realisation -- fxDone
    }
} then {
    call realiseContainers()
    call realiseMiddleware()
    call realiseBehaviours()
    call realiseDeeperBehaviours()
    call realiseDeeperBehaviours()
    call realiseCalls()
    call planWorkflows()
    match {
        fxRoot: Realisation {
            fixed = true
        }
    }
}
