using "../../../metamodel/architecture.mm"

// The donor's mechanism for one call site of the model (DESIGN.md AC3): the site's counterpart in
// the donor is the site of the same call (ExternalCallAction entityName) in the same operation
// (entityName of its RealisedCall's SEFF's signature) of the same caller (entityName of the
// RealisedCall's logical caller): on F's realised models these three are unique per site and stable
// under every operator (AC1). Mechanisms are shared option objects without a name; the option of
// the model that stands for the donor's mechanism is the allowed one of the same class (exact class:
// `is` compares labels) and, for a ComposedCall,
// with a cache or without one like the donor's (hitRatio set or not: F's models have `join` and
// `joinCache`). `target` is that option of the model. Fails, before any change (it changes
// nothing), when the donor has no counterpart, when the site does not allow the donor's mechanism or
// already has it. Needs a realised model (RealisedCall).
in donor: model
in site: CallSite
out target: Mechanism

match {
    site { }
    dmCall: ExternalCallAction { }
    dmRealised: RealisedCall { }
    dmSeff: ResourceDemandingSEFF { }
    dmSignature: Signature { }
    dmCaller: AssemblyContext { }
    dmCurrent: Mechanism { }
    dmOption: Mechanism { }
    site.`call` -- dmCall
    dmRealised.site -- site
    dmRealised.seff -- dmSeff
    dmSeff.describedService -- dmSignature
    dmRealised.logicalCaller -- dmCaller
    site.mechanism -- dmCurrent
    site.allowed -- dmOption
    in donor {
        dmDonorSite: CallSite { }
        dmDonorCall: ExternalCallAction { }
        dmDonorRealised: RealisedCall { }
        dmDonorSeff: ResourceDemandingSEFF { }
        dmDonorSignature: Signature { }
        dmDonorCaller: AssemblyContext { }
        dmDonorMechanism: Mechanism { }
        dmDonorSite.`call` -- dmDonorCall
        dmDonorRealised.site -- dmDonorSite
        dmDonorRealised.seff -- dmDonorSeff
        dmDonorSeff.describedService -- dmDonorSignature
        dmDonorRealised.logicalCaller -- dmDonorCaller
        dmDonorSite.mechanism -- dmDonorMechanism
    }
    where dmDonorCall.entityName == dmCall.entityName
    where dmDonorSignature.entityName == dmSignature.entityName
    where dmDonorCaller.entityName == dmCaller.entityName
    where (dmDonorMechanism is SyncCall && dmOption is SyncCall) || (dmDonorMechanism is AsyncCall && dmOption is AsyncCall) || (dmDonorMechanism is CachedCall && dmOption is CachedCall) || (dmDonorMechanism is ComposedCall && dmOption is ComposedCall) || (dmDonorMechanism is LocalCopy && dmOption is LocalCopy) || (dmDonorMechanism is InTransaction && dmOption is InTransaction)
    // read only for two ComposedCalls (a ternary is a Gremlin choose: the other branch is not evaluated)
    where (dmOption is ComposedCall) ? ((dmDonorMechanism as ComposedCall).hitRatio == null) == ((dmOption as ComposedCall).hitRatio == null) : true
}
target = dmOption
