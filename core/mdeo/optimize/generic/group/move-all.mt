using "../../../metamodel/architecture.mm"

// Moves every component of `members` to `destination` (DESIGN.md G1): each AllocationContext loses
// its container and gets `destination`, so it stays in exactly one container. The callers have
// checked the candidates. Fails (before any change) only if a member already is on `destination`.
in members: List<AllocationContext>
in destination: ResourceContainer

for x in members do {
    match {
        x { }
        destination { }
        old: ResourceContainer { }
        delete x.resourceContainer -- old
        create x.resourceContainer -- destination
    }
}
