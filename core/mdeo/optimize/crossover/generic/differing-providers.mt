using "../../../metamodel/architecture.mm"
import "./donor-keys.mt" as donorKeys

// The scope draw of take-mechanisms (DESIGN.md AC3): the provider components (logical providers
// of the RealisedCalls, as ../../generic/group/provider-sites.mt; in F's models one per domain
// class) that are called through a site whose mechanism the donor would change
// (./donor-mechanism.mt), and `count` of them drawn uniformly without repetition (fewer when there
// are fewer). Fails, before any change (it changes nothing), when there is none.
in donor: model
in count: int = 1
out candidates: Set<AssemblyContext>
out providers: List<AssemblyContext>

// The condition of ./donor-mechanism.mt for every site at once, as a hash join by hand: per mechanism
// option of the model, the keys of the donor's sites whose mechanism stands for it (./donor-keys.mt),
// then the model's sites that allow that option, do not have it, and whose key is among them. A
// cross-model `where` between pattern objects has no index: a call of donor-mechanism per site scanned
// the donor's 1 013 ExternalCallActions each time (1-2 s per application; DESIGN.md AC9). Two passes
// per option, since pattern objects of one class are injective: calls between two components, then
// calls of a component to itself (5 sites in F's models).
for match {
    dpOption: Mechanism { }
} do {
    call donorKeys(donor = donor, option = dpOption) -> (keys: dpKeys)
    for match {
        dpOption { }
        dpSite: CallSite { }
        dpRealised: RealisedCall { }
        dpProvider: AssemblyContext { }
        dpCall: ExternalCallAction { }
        dpSeff: ResourceDemandingSEFF { }
        dpSignature: Signature { }
        dpCaller: AssemblyContext { }
        dpCurrent: Mechanism { }
        dpSite.allowed -- dpOption
        dpSite.mechanism -- dpCurrent
        dpRealised.site -- dpSite
        dpRealised.logicalProvider -- dpProvider
        dpSite.`call` -- dpCall
        dpRealised.seff -- dpSeff
        dpSeff.describedService -- dpSignature
        dpRealised.logicalCaller -- dpCaller
        where dpCurrent != dpOption
        where dpKeys.includes(dpCall.entityName + "|" + dpSignature.entityName + "|" + dpCaller.entityName)
        candidates += dpProvider
    } do {
    }
    for match {
        dpOption { }
        dqSite: CallSite { }
        dqRealised: RealisedCall { }
        dqProvider: AssemblyContext { }
        dqCall: ExternalCallAction { }
        dqSeff: ResourceDemandingSEFF { }
        dqSignature: Signature { }
        dqCurrent: Mechanism { }
        dqSite.allowed -- dpOption
        dqSite.mechanism -- dqCurrent
        dqRealised.site -- dqSite
        dqRealised.logicalProvider -- dqProvider
        dqSite.`call` -- dqCall
        dqRealised.seff -- dqSeff
        dqSeff.describedService -- dqSignature
        dqRealised.logicalCaller -- dqProvider
        where dqCurrent != dpOption
        where dpKeys.includes(dqCall.entityName + "|" + dqSignature.entityName + "|" + dqProvider.entityName)
        candidates += dqProvider
    } do {
    }
}
match {
    dpFirst: AssemblyContext { }
    where candidates.includes(dpFirst)
}
providers += dpFirst
if (count > 1) {
    for dpRound in 2.to(count) do {
        if match {
            dpNext: AssemblyContext { }
            where candidates.includes(dpNext)
            where !providers.includes(dpNext)
        } then {
            providers += dpNext
        }
    }
}
