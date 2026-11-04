using "../../../metamodel/architecture.mm"

// The scope of change-pair-mechanisms (DESIGN.md M4): a directed pair of containers (X, Y) with
// calls from a component on X to a component on Y, and every call site of such a call (current
// placement). X is drawn uniformly among the containers that make a call through a site with at
// least two options to another container, Y uniformly among the containers X calls so. A call's
// caller and provider are the base connector's ends: the realisation's RealisedCall (logical caller
// and provider) on a realised model, the call's role and base connector otherwise. Derived
// ("realised") allocations and connectors are skipped. Changes nothing.
out sites: List<CallSite>
out sources: Set<ResourceContainer>
out destinations: Set<ResourceContainer>

for match {
    paSite: CallSite { }
    paCall: ExternalCallAction { }
    paRealised: RealisedCall { }
    paSite.`call` -- paCall
    paRealised.action -- paCall
    paCaller: AssemblyContext { }
    paRealised.logicalCaller -- paCaller
    paCallerAlloc: AllocationContext { }
    paCallerAlloc.assemblyContext -- paCaller
    where paCallerAlloc.entityName == null || paCallerAlloc.entityName!! != "realised"
    paFrom: ResourceContainer { }
    paCallerAlloc.resourceContainer -- paFrom
    paProvider: AssemblyContext { }
    paRealised.logicalProvider -- paProvider
    paProviderAlloc: AllocationContext { }
    paProviderAlloc.assemblyContext -- paProvider
    where paProviderAlloc.entityName == null || paProviderAlloc.entityName!! != "realised"
    paTo: ResourceContainer { }
    paProviderAlloc.resourceContainer -- paTo
    require paChoice {
        paOne: Mechanism { }
        paTwo: Mechanism { }
        paSite.allowed -- paOne
        paSite.allowed -- paTwo
    }
    sources += paFrom
} do {
}
for match {
    pbSite: CallSite { }
    pbCall: ExternalCallAction { }
    pbRole: OperationRequiredRole { }
    pbConnector: AssemblyConnector { }
    pbSite.`call` -- pbCall
    pbCall.role -- pbRole
    pbConnector.requiredRole -- pbRole
    where pbConnector.entityName == null || pbConnector.entityName!! != "realised"
    forbid pbTraced {
        pbTrace: RealisedCall { }
        pbTrace.action -- pbCall
    }
    pbCaller: AssemblyContext { }
    pbConnector.requiringAssemblyContext -- pbCaller
    pbCallerAlloc: AllocationContext { }
    pbCallerAlloc.assemblyContext -- pbCaller
    where pbCallerAlloc.entityName == null || pbCallerAlloc.entityName!! != "realised"
    pbFrom: ResourceContainer { }
    pbCallerAlloc.resourceContainer -- pbFrom
    pbProvider: AssemblyContext { }
    pbConnector.providingAssemblyContext -- pbProvider
    pbProviderAlloc: AllocationContext { }
    pbProviderAlloc.assemblyContext -- pbProvider
    where pbProviderAlloc.entityName == null || pbProviderAlloc.entityName!! != "realised"
    pbTo: ResourceContainer { }
    pbProviderAlloc.resourceContainer -- pbTo
    require pbChoice {
        pbOne: Mechanism { }
        pbTwo: Mechanism { }
        pbSite.allowed -- pbOne
        pbSite.allowed -- pbTwo
    }
    sources += pbFrom
} do {
}
match {
    pairSource: ResourceContainer { }
    where sources.includes(pairSource)
}
for match {
    pcSite: CallSite { }
    pcCall: ExternalCallAction { }
    pcRealised: RealisedCall { }
    pcSite.`call` -- pcCall
    pcRealised.action -- pcCall
    pcCaller: AssemblyContext { }
    pcRealised.logicalCaller -- pcCaller
    pcCallerAlloc: AllocationContext { }
    pcCallerAlloc.assemblyContext -- pcCaller
    where pcCallerAlloc.entityName == null || pcCallerAlloc.entityName!! != "realised"
    pairSource { }
    pcCallerAlloc.resourceContainer -- pairSource
    pcProvider: AssemblyContext { }
    pcRealised.logicalProvider -- pcProvider
    pcProviderAlloc: AllocationContext { }
    pcProviderAlloc.assemblyContext -- pcProvider
    where pcProviderAlloc.entityName == null || pcProviderAlloc.entityName!! != "realised"
    pcTo: ResourceContainer { }
    pcProviderAlloc.resourceContainer -- pcTo
    require pcChoice {
        pcOne: Mechanism { }
        pcTwo: Mechanism { }
        pcSite.allowed -- pcOne
        pcSite.allowed -- pcTwo
    }
    destinations += pcTo
} do {
}
for match {
    pdSite: CallSite { }
    pdCall: ExternalCallAction { }
    pdRole: OperationRequiredRole { }
    pdConnector: AssemblyConnector { }
    pdSite.`call` -- pdCall
    pdCall.role -- pdRole
    pdConnector.requiredRole -- pdRole
    where pdConnector.entityName == null || pdConnector.entityName!! != "realised"
    forbid pdTraced {
        pdTrace: RealisedCall { }
        pdTrace.action -- pdCall
    }
    pdCaller: AssemblyContext { }
    pdConnector.requiringAssemblyContext -- pdCaller
    pdCallerAlloc: AllocationContext { }
    pdCallerAlloc.assemblyContext -- pdCaller
    where pdCallerAlloc.entityName == null || pdCallerAlloc.entityName!! != "realised"
    pairSource { }
    pdCallerAlloc.resourceContainer -- pairSource
    pdProvider: AssemblyContext { }
    pdConnector.providingAssemblyContext -- pdProvider
    pdProviderAlloc: AllocationContext { }
    pdProviderAlloc.assemblyContext -- pdProvider
    where pdProviderAlloc.entityName == null || pdProviderAlloc.entityName!! != "realised"
    pdTo: ResourceContainer { }
    pdProviderAlloc.resourceContainer -- pdTo
    require pdChoice {
        pdOne: Mechanism { }
        pdTwo: Mechanism { }
        pdSite.allowed -- pdOne
        pdSite.allowed -- pdTwo
    }
    destinations += pdTo
} do {
}
match {
    pairDestination: ResourceContainer { }
    where destinations.includes(pairDestination)
}
for match {
    peSite: CallSite { }
    peCall: ExternalCallAction { }
    peRealised: RealisedCall { }
    peSite.`call` -- peCall
    peRealised.action -- peCall
    peCaller: AssemblyContext { }
    peRealised.logicalCaller -- peCaller
    peCallerAlloc: AllocationContext { }
    peCallerAlloc.assemblyContext -- peCaller
    where peCallerAlloc.entityName == null || peCallerAlloc.entityName!! != "realised"
    pairSource { }
    peCallerAlloc.resourceContainer -- pairSource
    peProvider: AssemblyContext { }
    peRealised.logicalProvider -- peProvider
    peProviderAlloc: AllocationContext { }
    peProviderAlloc.assemblyContext -- peProvider
    where peProviderAlloc.entityName == null || peProviderAlloc.entityName!! != "realised"
    pairDestination { }
    peProviderAlloc.resourceContainer -- pairDestination
    sites += peSite
} do {
}
for match {
    pfSite: CallSite { }
    pfCall: ExternalCallAction { }
    pfRole: OperationRequiredRole { }
    pfConnector: AssemblyConnector { }
    pfSite.`call` -- pfCall
    pfCall.role -- pfRole
    pfConnector.requiredRole -- pfRole
    where pfConnector.entityName == null || pfConnector.entityName!! != "realised"
    forbid pfTraced {
        pfTrace: RealisedCall { }
        pfTrace.action -- pfCall
    }
    pfCaller: AssemblyContext { }
    pfConnector.requiringAssemblyContext -- pfCaller
    pfCallerAlloc: AllocationContext { }
    pfCallerAlloc.assemblyContext -- pfCaller
    where pfCallerAlloc.entityName == null || pfCallerAlloc.entityName!! != "realised"
    pairSource { }
    pfCallerAlloc.resourceContainer -- pairSource
    pfProvider: AssemblyContext { }
    pfConnector.providingAssemblyContext -- pfProvider
    pfProviderAlloc: AllocationContext { }
    pfProviderAlloc.assemblyContext -- pfProvider
    where pfProviderAlloc.entityName == null || pfProviderAlloc.entityName!! != "realised"
    pairDestination { }
    pfProviderAlloc.resourceContainer -- pairDestination
    sites += pfSite
} do {
}
