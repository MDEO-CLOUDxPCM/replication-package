using "../../../metamodel/architecture.mm"

// The scope of change-class-mechanisms (DESIGN.md M5): a provider component (assembly; in F's domain
// models one per domain class) drawn uniformly among those called through a site with at least two
// options, and every call site of a call into it (from anywhere, local or remote). Caller and
// provider as in ./pair-sites.mt. Changes nothing.
out sites: List<CallSite>
out providers: Set<AssemblyContext>

for match {
    vaSite: CallSite { }
    vaCall: ExternalCallAction { }
    vaRealised: RealisedCall { }
    vaSite.`call` -- vaCall
    vaRealised.action -- vaCall
    vaProvider: AssemblyContext { }
    vaRealised.logicalProvider -- vaProvider
    require vaChoice {
        vaOne: Mechanism { }
        vaTwo: Mechanism { }
        vaSite.allowed -- vaOne
        vaSite.allowed -- vaTwo
    }
    providers += vaProvider
} do {
}
for match {
    vbSite: CallSite { }
    vbCall: ExternalCallAction { }
    vbRole: OperationRequiredRole { }
    vbConnector: AssemblyConnector { }
    vbSite.`call` -- vbCall
    vbCall.role -- vbRole
    vbConnector.requiredRole -- vbRole
    where vbConnector.entityName == null || vbConnector.entityName!! != "realised"
    forbid vbTraced {
        vbTrace: RealisedCall { }
        vbTrace.action -- vbCall
    }
    vbProvider: AssemblyContext { }
    vbConnector.providingAssemblyContext -- vbProvider
    require vbChoice {
        vbOne: Mechanism { }
        vbTwo: Mechanism { }
        vbSite.allowed -- vbOne
        vbSite.allowed -- vbTwo
    }
    providers += vbProvider
} do {
}
match {
    drawnProvider: AssemblyContext { }
    where providers.includes(drawnProvider)
}
for match {
    vcSite: CallSite { }
    vcCall: ExternalCallAction { }
    vcRealised: RealisedCall { }
    vcSite.`call` -- vcCall
    vcRealised.action -- vcCall
    drawnProvider { }
    vcRealised.logicalProvider -- drawnProvider
    sites += vcSite
} do {
}
for match {
    vdSite: CallSite { }
    vdCall: ExternalCallAction { }
    vdRole: OperationRequiredRole { }
    vdConnector: AssemblyConnector { }
    vdSite.`call` -- vdCall
    vdCall.role -- vdRole
    vdConnector.requiredRole -- vdRole
    where vdConnector.entityName == null || vdConnector.entityName!! != "realised"
    forbid vdTraced {
        vdTrace: RealisedCall { }
        vdTrace.action -- vdCall
    }
    drawnProvider { }
    vdConnector.providingAssemblyContext -- drawnProvider
    sites += vdSite
} do {
}
