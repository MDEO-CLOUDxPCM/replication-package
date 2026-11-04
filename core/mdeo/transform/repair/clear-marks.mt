using "../../metamodel/architecture.mm"

// The end of a placement repair (DESIGN.md B4.9): the marks go.

for match {
    cmRoot: Realisation { }
    cmPlacement: RealisedPlacement { }
    delete cmRoot.moved -- cmPlacement
} do {
}

for match {
    cdRoot: Realisation { }
    cdCall: RealisedCall { }
    delete cdRoot.dirty -- cdCall
} do {
}
