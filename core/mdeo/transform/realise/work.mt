using "../../metamodel/architecture.mm"

// Work (DESIGN.md B1.2, B1.5): exponential demands of its InternalAction, CPU then HDD, in ms of
// one full core of the container its component's assembly sits in, as StoEx text over that
// container's base rate. A component without an assembly never runs: its Work waits.

for match {
    wcRoot: Realisation { }
    wcDecisions: ArchitectureDecisions { }
    wcWork: Work { }
    wcAction: InternalAction { }
    wcBehaviour: ResourceDemandingBehaviour { }
    wcOwned: OwnedBehaviour { }
    wcSeff: ResourceDemandingSEFF { }
    wcComponent: BasicComponent { }
    wcAssembly: AssemblyContext { }
    wcContext: AllocationContext { }
    wcContainer: ResourceContainer { }
    wcRealised: RealisedContainer { }
    wcWork.action -- wcAction
    wcBehaviour.steps -- wcAction
    wcOwned.behaviour -- wcBehaviour
    wcOwned.seff -- wcSeff
    wcComponent.serviceEffectSpecifications -- wcSeff
    wcAssembly.encapsulatedComponent -- wcComponent
    wcContext.assemblyContext -- wcAssembly
    wcContext.resourceContainer -- wcContainer
    wcRealised.container -- wcContainer
    where wcWork.cpuMs != null && wcWork.cpuMs!! > 0.0
    forbid done {
        wcExisting: RealisedDemand {
            kind == "CPU"
        }
        wcExisting.work -- wcWork
    }
    create wcDemand: ParametricResourceDemand {
        specification = "Exp(1.0 / ((" + (wcWork.cpuMs!! / wcDecisions.msPerTimeUnit) + ") * (" + wcRealised.cpuRate + ")))"
        requiredResource = ProcessingResourceType.CPU
    }
    create wcRealisedDemand: RealisedDemand {
        ms = wcWork.cpuMs!!
        kind = "CPU"
        rate = wcRealised.cpuRate
    }
    create wcAction.resourceDemand -- wcDemand
    create wcRoot.demands -- wcRealisedDemand
    create wcRealisedDemand.demand -- wcDemand
    create wcRealisedDemand.owner -- wcAssembly
    create wcRealisedDemand.work -- wcWork
} do {
}

for match {
    whRoot: Realisation { }
    whDecisions: ArchitectureDecisions { }
    whWork: Work { }
    whAction: InternalAction { }
    whBehaviour: ResourceDemandingBehaviour { }
    whOwned: OwnedBehaviour { }
    whSeff: ResourceDemandingSEFF { }
    whComponent: BasicComponent { }
    whAssembly: AssemblyContext { }
    whContext: AllocationContext { }
    whContainer: ResourceContainer { }
    whRealised: RealisedContainer { }
    whWork.action -- whAction
    whBehaviour.steps -- whAction
    whOwned.behaviour -- whBehaviour
    whOwned.seff -- whSeff
    whComponent.serviceEffectSpecifications -- whSeff
    whAssembly.encapsulatedComponent -- whComponent
    whContext.assemblyContext -- whAssembly
    whContext.resourceContainer -- whContainer
    whRealised.container -- whContainer
    where whWork.hddMs != null && whWork.hddMs!! > 0.0
    forbid done {
        whExisting: RealisedDemand {
            kind == "HDD"
        }
        whExisting.work -- whWork
    }
    create whDemand: ParametricResourceDemand {
        specification = "Exp(1.0 / ((" + (whWork.hddMs!! / whDecisions.msPerTimeUnit) + ") * (" + whRealised.hddRate!! + ")))"
        requiredResource = ProcessingResourceType.HDD
    }
    create whRealisedDemand: RealisedDemand {
        ms = whWork.hddMs!!
        kind = "HDD"
        rate = whRealised.hddRate!!
    }
    create whAction.resourceDemand -- whDemand
    create whRoot.demands -- whRealisedDemand
    create whRealisedDemand.demand -- whDemand
    create whRealisedDemand.owner -- whAssembly
    create whRealisedDemand.work -- whWork
} do {
}
