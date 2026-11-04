using "../../../metamodel/architecture.mm"

// The call sites of the RealisedCalls whose logical provider is one of `providers` (DESIGN.md AC3;
// the realised branch of ../../generic/group/provider-sites.mt for given providers). Changes
// nothing, never fails.
in providers: List<AssemblyContext>
out sites: List<CallSite>

for match {
    psSite: CallSite { }
    psRealised: RealisedCall { }
    psProvider: AssemblyContext { }
    psRealised.site -- psSite
    psRealised.logicalProvider -- psProvider
    where providers.includes(psProvider)
    sites += psSite
} do {
}
