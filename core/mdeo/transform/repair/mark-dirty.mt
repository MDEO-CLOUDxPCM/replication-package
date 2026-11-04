using "../../metamodel/architecture.mm"

// The calls a placement repair looks at (Realisation.dirty, DESIGN.md B4.9): every call with an
// end (current or logical) in a moved context (Realisation.moved). Run again after the build
// section, it also marks the calls made there (deliveries: the owner or the copy store moved).

for match {
    mcRoot: Realisation { }
    mcPlacement: RealisedPlacement { }
    mcContext: AllocationContext { }
    mcAssembly: AssemblyContext { }
    mcCall: RealisedCall { }
    mcRoot.moved -- mcPlacement
    mcPlacement.allocation -- mcContext
    mcContext.assemblyContext -- mcAssembly
    mcCall.caller -- mcAssembly
    forbid marked {
        mcRoot.dirty -- mcCall
    }
    create mcRoot.dirty -- mcCall
} do {
}

for match {
    mpRoot: Realisation { }
    mpPlacement: RealisedPlacement { }
    mpContext: AllocationContext { }
    mpAssembly: AssemblyContext { }
    mpCall: RealisedCall { }
    mpRoot.moved -- mpPlacement
    mpPlacement.allocation -- mpContext
    mpContext.assemblyContext -- mpAssembly
    mpCall.provider -- mpAssembly
    forbid marked {
        mpRoot.dirty -- mpCall
    }
    create mpRoot.dirty -- mpCall
} do {
}

for match {
    mlRoot: Realisation { }
    mlPlacement: RealisedPlacement { }
    mlContext: AllocationContext { }
    mlAssembly: AssemblyContext { }
    mlCall: RealisedCall { }
    mlRoot.moved -- mlPlacement
    mlPlacement.allocation -- mlContext
    mlContext.assemblyContext -- mlAssembly
    mlCall.logicalCaller -- mlAssembly
    forbid marked {
        mlRoot.dirty -- mlCall
    }
    create mlRoot.dirty -- mlCall
} do {
}

for match {
    mqRoot: Realisation { }
    mqPlacement: RealisedPlacement { }
    mqContext: AllocationContext { }
    mqAssembly: AssemblyContext { }
    mqCall: RealisedCall { }
    mqRoot.moved -- mqPlacement
    mqPlacement.allocation -- mqContext
    mqContext.assemblyContext -- mqAssembly
    mqCall.logicalProvider -- mqAssembly
    forbid marked {
        mqRoot.dirty -- mqCall
    }
    create mqRoot.dirty -- mqCall
} do {
}

// An effect step whose callerSchema moved (DESIGN.md AB37): whether it joins its caller's transaction depends
// on the database server of the two schemas, not only on the call's ends.
for match {
    msRoot: Realisation { }
    msPlacement: RealisedPlacement { }
    msContext: AllocationContext { }
    msAssembly: AssemblyContext { }
    msSite: CallSite { }
    msCall: RealisedCall { }
    msRoot.moved -- msPlacement
    msPlacement.allocation -- msContext
    msContext.assemblyContext -- msAssembly
    msSite.callerSchema -- msAssembly
    msCall.site -- msSite
    forbid marked {
        msRoot.dirty -- msCall
    }
    create msRoot.dirty -- msCall
} do {
}

// An effect step whose providerSchema moved (DESIGN.md AB37): whether it joins its caller's transaction depends
// on the database server of the two schemas, not only on the call's ends.
for match {
    mtRoot: Realisation { }
    mtPlacement: RealisedPlacement { }
    mtContext: AllocationContext { }
    mtAssembly: AssemblyContext { }
    mtSite: CallSite { }
    mtCall: RealisedCall { }
    mtRoot.moved -- mtPlacement
    mtPlacement.allocation -- mtContext
    mtContext.assemblyContext -- mtAssembly
    mtSite.providerSchema -- mtAssembly
    mtCall.site -- mtSite
    forbid marked {
        mtRoot.dirty -- mtCall
    }
    create mtRoot.dirty -- mtCall
} do {
}
