using "../../metamodel/architecture.mm"

// ../realise/rates.mt in a placement repair (DESIGN.md B4.9): the rates of the derived demands whose
// owner moved (Realisation.moved); a move removes no owner.


for match {
    rcDecisions: ArchitectureDecisions { }
    rcRoot: Realisation { }
    rcPlacement: RealisedPlacement { }
    rcRoot.moved -- rcPlacement
    rcPlacement.allocation -- rcContext
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
    rhRoot: Realisation { }
    rhPlacement: RealisedPlacement { }
    rhRoot.moved -- rhPlacement
    rhPlacement.allocation -- rhContext
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
