using "../../../metamodel/architecture.mm"

// One service of the donor, transplanted (DESIGN.md AC2): a container of the donor is drawn
// uniformly among those that would give the model something, and every movable component that the
// donor puts there moves to the model's container of the same name, unless it is already there or
// may not run there (its Placement's candidates). Components and containers correlate by
// `entityName` (descendants of one seed keep them; AC1). Components the model already has on that
// container stay (the container receives the donor's group, it is not emptied). Fails, before any
// change, when no donor container would move anything. Each component keeps exactly one container
// (G1). `receivers` are the containers that would have received something, `target` the drawn one.
in donor: model
out receivers: Set<ResourceContainer>
out moved: List<AllocationContext>
out target: ResourceContainer

// the containers of the model that would receive at least one component
for match {
    tsPlacement: Placement { }
    tsAllocation: AllocationContext { }
    tsCurrent: ResourceContainer { }
    tsReceiver: ResourceContainer { }
    tsPlacement.allocation -- tsAllocation
    tsPlacement.candidates -- tsReceiver
    tsAllocation.resourceContainer -- tsCurrent
    in donor {
        tsDonorAllocation: AllocationContext { }
        tsDonorHost: ResourceContainer { }
        tsDonorAllocation.resourceContainer -- tsDonorHost
    }
    where tsAllocation.entityName != null
    where tsDonorAllocation.entityName == tsAllocation.entityName
    where tsDonorHost.entityName == tsReceiver.entityName
    receivers += tsReceiver
} do {
}
// one of them, uniformly (the engine's first match after its shuffle, E3); fails when there is none
match {
    tsDrawn: ResourceContainer { }
    where receivers.includes(tsDrawn)
}
// the donor's group on it that is elsewhere in the model and may run there moves there (each loses
// its container and gets the drawn one, as ../../generic/group/move-all.mt; done here so that the
// operator cannot fail after a change and works with `if call`)
for match {
    tsDrawn { }
    tsMemberPlacement: Placement { }
    tsMember: AllocationContext { }
    tsMemberHost: ResourceContainer { }
    tsMemberPlacement.allocation -- tsMember
    tsMemberPlacement.candidates -- tsDrawn
    tsMember.resourceContainer -- tsMemberHost
    in donor {
        tsDonorMember: AllocationContext { }
        tsDonorMemberHost: ResourceContainer { }
        tsDonorMember.resourceContainer -- tsDonorMemberHost
    }
    where tsMember.entityName != null
    where tsDonorMember.entityName == tsMember.entityName
    where tsDonorMemberHost.entityName == tsDrawn.entityName
    delete tsMember.resourceContainer -- tsMemberHost
    create tsMember.resourceContainer -- tsDrawn
    moved += tsMember
} do {
}
target = tsDrawn
