using "../../metamodel/architecture.mm"

// Fixed part of the realisation (DESIGN.md B1): the trace root, and per container with a CPU its
// base rates as written, before rule 3 changes the CPU's rate (B1.5).

if match {
    rtDecisions: ArchitectureDecisions { }
    forbid rooted {
        rtExisting: Realisation { }
        rtDecisions.realisation -- rtExisting
    }
} then {
    match {
        rtDecisions { }
        create rtRoot: Realisation { }
        create rtDecisions.realisation -- rtRoot
    }
}

for match {
    rcRoot: Realisation { }
    rcContainer: ResourceContainer { }
    rcCpu: ProcessingResourceSpecification {
        activeResourceType == ProcessingResourceType.CPU
    }
    rcContainer.activeResourceSpecifications -- rcCpu

    forbid known {
        rcExisting: RealisedContainer { }
        rcExisting.container -- rcContainer
    }
    forbid derived {
        rcOwner: RealisedContainer { }
        rcOwner.sidecar -- rcContainer
    }

    create rcRealised: RealisedContainer {
        cpuRate = rcCpu.processingRate!!
    }
    create rcRoot.containers -- rcRealised
    create rcRealised.container -- rcContainer
    create rcRealised.cpu -- rcCpu
} do {
}

// The HDD's base rate, where the container has one.
for match {
    rhRealised: RealisedContainer {
        hddRate = rhHdd.processingRate
    }
    rhContainer: ResourceContainer { }
    rhHdd: ProcessingResourceSpecification {
        activeResourceType == ProcessingResourceType.HDD
    }
    rhRealised.container -- rhContainer
    rhContainer.activeResourceSpecifications -- rhHdd
} do {
}
