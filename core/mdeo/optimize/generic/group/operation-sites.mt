using "../../../metamodel/architecture.mm"

// The scope of change-operation-mechanisms (DESIGN.md M6): an operation's SEFF drawn uniformly among
// the SEFFs that hold a call through a site with at least two options, and every call site in it.
// On a realised model the SEFF of a base call is the realisation's (RealisedCall.seff: at any depth,
// also after the realisation moved the call into a derived behaviour); on an unrealised model only
// calls directly in the SEFF are found (no trace of nested behaviours there). Changes nothing.
out sites: List<CallSite>
out seffs: Set<ResourceDemandingSEFF>

for match {
    oaSite: CallSite { }
    oaCall: ExternalCallAction { }
    oaRealised: RealisedCall { }
    oaSeff: ResourceDemandingSEFF { }
    oaSite.`call` -- oaCall
    oaRealised.action -- oaCall
    oaRealised.seff -- oaSeff
    require oaChoice {
        oaOne: Mechanism { }
        oaTwo: Mechanism { }
        oaSite.allowed -- oaOne
        oaSite.allowed -- oaTwo
    }
    seffs += oaSeff
} do {
}
for match {
    obSite: CallSite { }
    obCall: ExternalCallAction { }
    obSeff: ResourceDemandingSEFF { }
    obSite.`call` -- obCall
    obSeff.steps -- obCall
    forbid obTraced {
        obTrace: RealisedCall { }
        obTrace.action -- obCall
    }
    require obChoice {
        obOne: Mechanism { }
        obTwo: Mechanism { }
        obSite.allowed -- obOne
        obSite.allowed -- obTwo
    }
    seffs += obSeff
} do {
}
match {
    drawnSeff: ResourceDemandingSEFF { }
    where seffs.includes(drawnSeff)
}
for match {
    ocSite: CallSite { }
    ocCall: ExternalCallAction { }
    ocRealised: RealisedCall { }
    drawnSeff { }
    ocSite.`call` -- ocCall
    ocRealised.action -- ocCall
    ocRealised.seff -- drawnSeff
    sites += ocSite
} do {
}
for match {
    odSite: CallSite { }
    odCall: ExternalCallAction { }
    drawnSeff { }
    odSite.`call` -- odCall
    drawnSeff.steps -- odCall
    forbid odTraced {
        odTrace: RealisedCall { }
        odTrace.action -- odCall
    }
    sites += odSite
} do {
}
