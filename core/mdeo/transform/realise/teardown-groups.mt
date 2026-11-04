using "../../metamodel/architecture.mm"

// A composer call's group without composed calls.
// (After ./teardown-calls.mt; DESIGN.md B3.)

while match {
    delete tqGroup: ComposedGroup { }
    delete tqFork: ForkAction { }
    delete tqPoint: SynchronisationPoint { }
    tqAfter: ExternalCallAction { }
    tqNext: AbstractAction { }
    delete tqGroup.after -- tqAfter
    delete tqGroup.fork -- tqFork
    delete tqFork.synchronisingBehaviours -- tqPoint
    delete tqAfter.successor -- tqFork
    delete tqFork.successor -- tqNext
    create tqAfter.successor -- tqNext
    forbid composing {
        tqBranch: ForkedBehaviour { }
        tqPoint.synchronousForkedBehaviours -- tqBranch
    }
} do {
}
