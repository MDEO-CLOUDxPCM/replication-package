using "../../../metamodel/architecture.mm"

// The donor's call sites whose mechanism stands for `option` (a mechanism option object of the model;
// the correspondence of ./donor-mechanism.mt: same class, for a ComposedCall with a cache or without
// one like it), as keys: call (ExternalCallAction entityName), operation (entityName of the
// RealisedCall's SEFF's signature), caller (entityName of the RealisedCall's logical caller), joined
// by "|" (DESIGN.md AC1, AC9). The class is chosen here, once, so that the match itself only checks
// labels (a per-site test of the class in a `where` cost milliseconds per site). Changes nothing,
// never fails.
in donor: model
in option: Mechanism
out keys: Set<string>

if (option is SyncCall) {
    for match {
        in donor {
            k1Site: CallSite { }
            k1Call: ExternalCallAction { }
            k1Realised: RealisedCall { }
            k1Seff: ResourceDemandingSEFF { }
            k1Signature: Signature { }
            k1Caller: AssemblyContext { }
            k1Mechanism: SyncCall { }
            k1Site.`call` -- k1Call
            k1Realised.site -- k1Site
            k1Realised.seff -- k1Seff
            k1Seff.describedService -- k1Signature
            k1Realised.logicalCaller -- k1Caller
            k1Site.mechanism -- k1Mechanism
        }
        var k1Key = k1Call.entityName + "|" + k1Signature.entityName + "|" + k1Caller.entityName
        keys += k1Key
    } do {
    }
} else {
if (option is AsyncCall) {
    for match {
        in donor {
            k2Site: CallSite { }
            k2Call: ExternalCallAction { }
            k2Realised: RealisedCall { }
            k2Seff: ResourceDemandingSEFF { }
            k2Signature: Signature { }
            k2Caller: AssemblyContext { }
            k2Mechanism: AsyncCall { }
            k2Site.`call` -- k2Call
            k2Realised.site -- k2Site
            k2Realised.seff -- k2Seff
            k2Seff.describedService -- k2Signature
            k2Realised.logicalCaller -- k2Caller
            k2Site.mechanism -- k2Mechanism
        }
        var k2Key = k2Call.entityName + "|" + k2Signature.entityName + "|" + k2Caller.entityName
        keys += k2Key
    } do {
    }
} else {
if (option is InTransaction) {
    for match {
        in donor {
            k8Site: CallSite { }
            k8Call: ExternalCallAction { }
            k8Realised: RealisedCall { }
            k8Seff: ResourceDemandingSEFF { }
            k8Signature: Signature { }
            k8Caller: AssemblyContext { }
            k8Mechanism: InTransaction { }
            k8Site.`call` -- k8Call
            k8Realised.site -- k8Site
            k8Realised.seff -- k8Seff
            k8Seff.describedService -- k8Signature
            k8Realised.logicalCaller -- k8Caller
            k8Site.mechanism -- k8Mechanism
        }
        var k8Key = k8Call.entityName + "|" + k8Signature.entityName + "|" + k8Caller.entityName
        keys += k8Key
    } do {
    }
} else {
if (option is CachedCall) {
    for match {
        in donor {
            k3Site: CallSite { }
            k3Call: ExternalCallAction { }
            k3Realised: RealisedCall { }
            k3Seff: ResourceDemandingSEFF { }
            k3Signature: Signature { }
            k3Caller: AssemblyContext { }
            k3Mechanism: CachedCall { }
            k3Site.`call` -- k3Call
            k3Realised.site -- k3Site
            k3Realised.seff -- k3Seff
            k3Seff.describedService -- k3Signature
            k3Realised.logicalCaller -- k3Caller
            k3Site.mechanism -- k3Mechanism
        }
        var k3Key = k3Call.entityName + "|" + k3Signature.entityName + "|" + k3Caller.entityName
        keys += k3Key
    } do {
    }
} else {
if (option is LocalCopy) {
    for match {
        in donor {
            k5Site: CallSite { }
            k5Call: ExternalCallAction { }
            k5Realised: RealisedCall { }
            k5Seff: ResourceDemandingSEFF { }
            k5Signature: Signature { }
            k5Caller: AssemblyContext { }
            k5Mechanism: LocalCopy { }
            k5Site.`call` -- k5Call
            k5Realised.site -- k5Site
            k5Realised.seff -- k5Seff
            k5Seff.describedService -- k5Signature
            k5Realised.logicalCaller -- k5Caller
            k5Site.mechanism -- k5Mechanism
        }
        var k5Key = k5Call.entityName + "|" + k5Signature.entityName + "|" + k5Caller.entityName
        keys += k5Key
    } do {
    }
} else {
if (option is ComposedCall) {
    if ((option as ComposedCall).hitRatio == null) {
        for match {
        in donor {
            k6Site: CallSite { }
            k6Call: ExternalCallAction { }
            k6Realised: RealisedCall { }
            k6Seff: ResourceDemandingSEFF { }
            k6Signature: Signature { }
            k6Caller: AssemblyContext { }
            k6Mechanism: ComposedCall { }
            k6Site.`call` -- k6Call
            k6Realised.site -- k6Site
            k6Realised.seff -- k6Seff
            k6Seff.describedService -- k6Signature
            k6Realised.logicalCaller -- k6Caller
            k6Site.mechanism -- k6Mechanism
        }
        where k6Mechanism.hitRatio == null
        var k6Key = k6Call.entityName + "|" + k6Signature.entityName + "|" + k6Caller.entityName
        keys += k6Key
    } do {
    }
    } else {
        for match {
        in donor {
            k7Site: CallSite { }
            k7Call: ExternalCallAction { }
            k7Realised: RealisedCall { }
            k7Seff: ResourceDemandingSEFF { }
            k7Signature: Signature { }
            k7Caller: AssemblyContext { }
            k7Mechanism: ComposedCall { }
            k7Site.`call` -- k7Call
            k7Realised.site -- k7Site
            k7Realised.seff -- k7Seff
            k7Seff.describedService -- k7Signature
            k7Realised.logicalCaller -- k7Caller
            k7Site.mechanism -- k7Mechanism
        }
        where k7Mechanism.hitRatio != null
        var k7Key = k7Call.entityName + "|" + k7Signature.entityName + "|" + k7Caller.entityName
        keys += k7Key
    } do {
    }
    }
}
}
}
}
}
}
