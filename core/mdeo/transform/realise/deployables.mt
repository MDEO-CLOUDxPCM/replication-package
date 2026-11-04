using "../../metamodel/architecture.mm"

// Deployables (DESIGN.md B1.4, rule 3 of the earlier translation): a container with n replicas
// of q cores gets n·⌈q⌉ cores at the limit speed (base) · q / ⌈q⌉ (with `quota`: its base
// speed; its load-dependent speed is the scripts'), its sidecar n·sidecarCores cores. An
// autoscaled container shows one replica: its count depends on the load and is the scripts'
// (resource overrides). RealisedDeployable keeps the count applied; change-replicas changes it.

// The limit speed (fixed: q and the base rate do not change).
for match {
    dsRoot: Realisation { }
    dsDeployable: Deployable { }
    dsContainer: ResourceContainer { }
    dsRates: RealisedContainer { }
    dsCpu: ProcessingResourceSpecification {
        processingRate = "(" + dsRates.cpuRate + ") * " + dsDeployable.cpuPerReplica + " / " + dsDeployable.cpuPerReplica.ceil()
    }
    dsDeployable.container -- dsContainer
    dsRates.container -- dsContainer
    dsRates.cpu -- dsCpu
    where dsDeployable.quota == null || dsDeployable.quota!! == false
    forbid done {
        dsExisting: RealisedDeployable { }
        dsExisting.deployable -- dsDeployable
    }
} do {
}

// The replicas: fixed, or one for an autoscaled container.
for match {
    dfRoot: Realisation { }
    dfDeployable: Deployable { }
    dfOption: ReplicaOption { }
    dfContainer: ResourceContainer { }
    dfRates: RealisedContainer { }
    dfCpu: ProcessingResourceSpecification {
        numberOfReplicas = dfOption.count * dfDeployable.cpuPerReplica.ceil()
    }
    dfDeployable.container -- dfContainer
    dfDeployable.replicas -- dfOption
    dfRates.container -- dfContainer
    dfRates.cpu -- dfCpu
    forbid scaled {
        dfScaling: Autoscaling { }
        dfDeployable.autoscaling -- dfScaling
    }
    forbid done {
        dfExisting: RealisedDeployable {
            replicas == dfOption.count
        }
        dfExisting.deployable -- dfDeployable
    }
} do {
}

for match {
    daRoot: Realisation { }
    daDeployable: Deployable { }
    daScaling: Autoscaling { }
    daContainer: ResourceContainer { }
    daRates: RealisedContainer { }
    daCpu: ProcessingResourceSpecification {
        numberOfReplicas = daDeployable.cpuPerReplica.ceil()
    }
    daDeployable.container -- daContainer
    daDeployable.autoscaling -- daScaling
    daRates.container -- daContainer
    daRates.cpu -- daCpu
    forbid done {
        daExisting: RealisedDeployable { }
        daExisting.deployable -- daDeployable
    }
} do {
}

// The sidecar's cores (sidecarCores, absent: 1, per replica).
for match {
    dcDeployable: Deployable { }
    dcOption: ReplicaOption { }
    dcContainer: ResourceContainer { }
    dcRates: RealisedContainer { }
    dcSidecar: ResourceContainer { }
    dcCpu: ProcessingResourceSpecification {
        activeResourceType == ProcessingResourceType.CPU
        numberOfReplicas = dcOption.count * dcDeployable.sidecarCores!!
    }
    dcDeployable.container -- dcContainer
    dcDeployable.replicas -- dcOption
    dcRates.container -- dcContainer
    dcRates.sidecar -- dcSidecar
    dcSidecar.activeResourceSpecifications -- dcCpu
    where dcDeployable.sidecarCores != null && dcDeployable.sidecarCores!! >= 1
    forbid scaled {
        dcScaling: Autoscaling { }
        dcDeployable.autoscaling -- dcScaling
    }
    forbid done {
        dcExisting: RealisedDeployable {
            replicas == dcOption.count
        }
        dcExisting.deployable -- dcDeployable
    }
} do {
}

for match {
    d1Deployable: Deployable { }
    d1Option: ReplicaOption { }
    d1Container: ResourceContainer { }
    d1Rates: RealisedContainer { }
    d1Sidecar: ResourceContainer { }
    d1Cpu: ProcessingResourceSpecification {
        activeResourceType == ProcessingResourceType.CPU
        numberOfReplicas = d1Option.count
    }
    d1Deployable.container -- d1Container
    d1Deployable.replicas -- d1Option
    d1Rates.container -- d1Container
    d1Rates.sidecar -- d1Sidecar
    d1Sidecar.activeResourceSpecifications -- d1Cpu
    where d1Deployable.sidecarCores == null || d1Deployable.sidecarCores!! < 1
    forbid scaled {
        d1Scaling: Autoscaling { }
        d1Deployable.autoscaling -- d1Scaling
    }
    forbid done {
        d1Existing: RealisedDeployable {
            replicas == d1Option.count
        }
        d1Existing.deployable -- d1Deployable
    }
} do {
}

for match {
    d2Deployable: Deployable { }
    d2Scaling: Autoscaling { }
    d2Container: ResourceContainer { }
    d2Rates: RealisedContainer { }
    d2Sidecar: ResourceContainer { }
    d2Cpu: ProcessingResourceSpecification {
        activeResourceType == ProcessingResourceType.CPU
        numberOfReplicas = d2Deployable.sidecarCores!!
    }
    d2Deployable.container -- d2Container
    d2Deployable.autoscaling -- d2Scaling
    d2Rates.container -- d2Container
    d2Rates.sidecar -- d2Sidecar
    d2Sidecar.activeResourceSpecifications -- d2Cpu
    where d2Deployable.sidecarCores != null && d2Deployable.sidecarCores!! >= 1
    forbid done {
        d2Existing: RealisedDeployable { }
        d2Existing.deployable -- d2Deployable
    }
} do {
}

// (Autoscaled without sidecarCores: the sidecar keeps its one core.)

// Recorded: the count applied (1 when autoscaled).
for match {
    drRoot: Realisation { }
    drDeployable: Deployable { }
    drOption: ReplicaOption { }
    drDeployable.replicas -- drOption
    forbid scaled {
        drScaling: Autoscaling { }
        drDeployable.autoscaling -- drScaling
    }
    forbid done {
        drExisting: RealisedDeployable { }
        drExisting.deployable -- drDeployable
    }
    create drRealised: RealisedDeployable {
        replicas = drOption.count
    }
    create drRoot.deployables -- drRealised
    create drRealised.deployable -- drDeployable
} do {
}

for match {
    duDeployable: Deployable { }
    duOption: ReplicaOption { }
    duRealised: RealisedDeployable {
        replicas != duOption.count
        replicas = duOption.count
    }
    duDeployable.replicas -- duOption
    duRealised.deployable -- duDeployable
    forbid scaled {
        duScaling: Autoscaling { }
        duDeployable.autoscaling -- duScaling
    }
} do {
}

for match {
    dvRoot: Realisation { }
    dvDeployable: Deployable { }
    dvScaling: Autoscaling { }
    dvDeployable.autoscaling -- dvScaling
    forbid done {
        dvExisting: RealisedDeployable { }
        dvExisting.deployable -- dvDeployable
    }
    create dvRealised: RealisedDeployable {
        replicas = 1
    }
    create dvRoot.deployables -- dvRealised
    create dvRealised.deployable -- dvDeployable
} do {
}
