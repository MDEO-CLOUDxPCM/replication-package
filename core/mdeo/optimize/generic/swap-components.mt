using "../../metamodel/architecture.mm"

// Swap two movable components between their containers (P10, DESIGN.md D58): each goes to the
// other's container, so the number of containers in use stays the same and only the grouping
// changes. Both must be allowed on the other's container. Matches are injective, so the two
// containers differ.

match {
    first: Placement { }
    second: Placement { }
    a: AllocationContext { }
    b: AllocationContext { }
    here: ResourceContainer { }
    there: ResourceContainer { }

    first.allocation -- a
    second.allocation -- b
    first.candidates -- there
    second.candidates -- here

    delete a.resourceContainer -- here
    delete b.resourceContainer -- there
    create a.resourceContainer -- there
    create b.resourceContainer -- here
}
