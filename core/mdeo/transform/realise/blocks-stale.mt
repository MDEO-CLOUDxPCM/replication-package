using "../../metamodel/architecture.mm"

// Removal of middleware blocks whose call's shape or kind is no longer the one they were made for
// (DESIGN.md B3, ./blocks-remove.mt).

// Size 1: stale, then local.
while match {
    delete x1Block: MiddlewareBlock {
        size == 1
    }
    x1Call: RealisedCall { }
    x1Before: AbstractAction { }
    x1After: AbstractAction { }
    delete x1A0: ExternalCallAction { }
    delete x1Block.realised -- x1Call
    delete x1Block.first -- x1A0
    delete x1Block.last -- x1A0
    delete x1Before.successor -- x1A0
    delete x1A0.successor -- x1After
    create x1Before.successor -- x1After
    where x1Block.kind != x1Call.kind || x1Block.shape != x1Call.shape
} do {
}

// Size 3: stale, then local.
while match {
    delete x3Block: MiddlewareBlock {
        size == 3
    }
    x3Call: RealisedCall { }
    x3Before: AbstractAction { }
    x3After: AbstractAction { }
    delete x3A0: ExternalCallAction { }
    delete x3A1: ExternalCallAction { }
    delete x3A2: ExternalCallAction { }
    delete x3Block.realised -- x3Call
    delete x3Block.first -- x3A0
    delete x3Block.last -- x3A2
    delete x3A0.successor -- x3A1
    delete x3A1.successor -- x3A2
    delete x3Before.successor -- x3A0
    delete x3A2.successor -- x3After
    create x3Before.successor -- x3After
    where x3Block.kind != x3Call.kind || x3Block.shape != x3Call.shape
} do {
}

// Size 4: stale, then local.
while match {
    delete x4Block: MiddlewareBlock {
        size == 4
    }
    x4Call: RealisedCall { }
    x4Before: AbstractAction { }
    x4After: AbstractAction { }
    delete x4A0: ExternalCallAction { }
    delete x4A1: ExternalCallAction { }
    delete x4A2: ExternalCallAction { }
    delete x4A3: ExternalCallAction { }
    delete x4Block.realised -- x4Call
    delete x4Block.first -- x4A0
    delete x4Block.last -- x4A3
    delete x4A0.successor -- x4A1
    delete x4A1.successor -- x4A2
    delete x4A2.successor -- x4A3
    delete x4Before.successor -- x4A0
    delete x4A3.successor -- x4After
    create x4Before.successor -- x4After
    where x4Block.kind != x4Call.kind || x4Block.shape != x4Call.shape
} do {
}
