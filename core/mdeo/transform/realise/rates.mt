using "../../metamodel/architecture.mm"

// Derived demands follow the base rate of their owner's container (DESIGN.md B1.5): after a
// move across rates the StoEx text is rewritten. A demand whose owner is gone (a removed copy
// store's assembly) goes. (The structures that make derived actions delete their demands.)

for match {
    delete roRealised: RealisedDemand { }
    delete roDemand: ParametricResourceDemand { }
    delete roRealised.demand -- roDemand
    forbid owned {
        roOwner: AssemblyContext { }
        roRealised.owner -- roOwner
    }
} do {
}

for match {
    rcDecisions: ArchitectureDecisions { }
    rcRealised: RealisedDemand {
        kind == "CPU"
        rate = rcContainerRates.cpuRate
    }
    rcDemand: ParametricResourceDemand {
        specification = "Exp(1.0 / ((" + (rcRealised.ms / rcDecisions.msPerTimeUnit) + ") * (" + rcContainerRates.cpuRate + ")))"
    }
    rcOwner: AssemblyContext { }
    rcContext: AllocationContext { }
    rcContainer: ResourceContainer { }
    rcContainerRates: RealisedContainer { }
    rcRealised.demand -- rcDemand
    rcRealised.owner -- rcOwner
    rcContext.assemblyContext -- rcOwner
    rcContext.resourceContainer -- rcContainer
    rcContainerRates.container -- rcContainer
    where rcRealised.rate != rcContainerRates.cpuRate
} do {
}

for match {
    rhDecisions: ArchitectureDecisions { }
    rhRealised: RealisedDemand {
        kind == "HDD"
        rate = rhContainerRates.hddRate!!
    }
    rhDemand: ParametricResourceDemand {
        specification = "Exp(1.0 / ((" + (rhRealised.ms / rhDecisions.msPerTimeUnit) + ") * (" + rhContainerRates.hddRate!! + ")))"
    }
    rhOwner: AssemblyContext { }
    rhContext: AllocationContext { }
    rhContainer: ResourceContainer { }
    rhContainerRates: RealisedContainer { }
    rhRealised.demand -- rhDemand
    rhRealised.owner -- rhOwner
    rhContext.assemblyContext -- rhOwner
    rhContext.resourceContainer -- rhContainer
    rhContainerRates.container -- rhContainer
    where rhContainerRates.hddRate != null && rhRealised.rate != rhContainerRates.hddRate!!
} do {
}
