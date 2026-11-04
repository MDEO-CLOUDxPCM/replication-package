using "../../metamodel/architecture.mm"

// Switch a workflow to another of its allowed coordination styles (choreography or
// orchestration), never to the one it has.

match {
    workflow: Workflow { }
    current: Coordination { }
    next: Coordination { }

    // not the transaction of a home option that is not chosen (DESIGN.md AB38: unreached)
    forbid idle {
        ccIdleSeff: ResourceDemandingSEFF { }
        ccIdleHome: Home { }
        ccIdleOption: HomeOption { }
        ccIdleChosen: HomeOption { }
        workflow.trigger -- ccIdleSeff
        ccIdleOption.seffs -- ccIdleSeff
        ccIdleHome.options -- ccIdleOption
        ccIdleHome.home -- ccIdleChosen
    }

    workflow.allowed -- next

    delete workflow.style -- current
    create workflow.style -- next

    forbid unchanged {
        workflow.style -- next
    }
}
