using "../../metamodel/architecture.mm"

// Part 1 of the copy sync (../sync-microservices.mt, DESIGN.md H14, H19): what depends on the
// CopyFeeds only, not on decisions: a copy store per consumer assembly that keeps copies
// (CopyStore: a component with an interface of its own), its read and write operation per copy
// (SEFFs whose InternalAction has the LocalCopy's times as Work). No operator changes them, so the
// local repairs (./moves.mt, ./site.mt) leave this part out.

// Only when something is missing (the parts do not depend on decisions, so normally nothing is):
// the guards are cheap, the patterns below are not.
if match {
    gcFeed: CopyFeed { }
    forbid complete {
        gcWrite: OperationSignature { }
        gcFeed.write -- gcWrite
    }
} then {
    // A consumer assembly that keeps copies gets a copy store (one per assembly, so one at a time).
    while match {
        csDecisions: ArchitectureDecisions { }
        csRepository: Repository { }
        csFeed: CopyFeed { }
        csConsumer: AssemblyContext { }
        csFeed.store -- csConsumer

        forbid hasStore {
            csExisting: CopyStore { }
            csExisting.store -- csConsumer
        }

        create csStore: CopyStore { }
        create csCopies: OperationInterface {
            entityName = csConsumer.entityName + "_copies"
        }
        create csComponent: BasicComponent {
            entityName = csConsumer.entityName + "_copyStore"
        }
        create csProvides: OperationProvidedRole {
            entityName = csConsumer.entityName + "_copyStore_provides"
        }
        create csDecisions.copyStores -- csStore
        create csStore.store -- csConsumer
        create csStore.component -- csComponent
        create csStore.copies -- csCopies
        create csRepository.interfaces -- csCopies
        create csRepository.components -- csComponent
        create csComponent.providedRoles -- csProvides
        create csProvides.providedInterface -- csCopies
    } do {
    }

    // Every CopyFeed knows the copy store of its consumer.
    for match {
        lsFeed: CopyFeed { }
        lsStore: CopyStore { }
        lsConsumer: AssemblyContext { }
        lsFeed.store -- lsConsumer
        lsStore.store -- lsConsumer

        forbid linked {
            lsOther: CopyStore { }
            lsFeed.copyStore -- lsOther
        }

        create lsFeed.copyStore -- lsStore
    } do {
    }

    // The read and write operation of every copy, with readCpuMs: read = readCpuMs and readDbMs,
    // write = writeCpuMs and writeDbMs, as Work in ms (the plugin turns them into demands at the
    // rates of the container where the copy store sits).
    for match {
        opFeed: CopyFeed { }
        opStore: CopyStore { }
        opComponent: BasicComponent { }
        opCopies: OperationInterface { }
        opSite: CallSite { }
        opCall: ExternalCallAction { }
        opSeff: ResourceDemandingSEFF { }
        opOperation: OperationSignature { }
        opCopy: LocalCopy { }
        opDecisions: ArchitectureDecisions { }

        opFeed.copyStore -- opStore
        opStore.component -- opComponent
        opStore.copies -- opCopies
        opFeed.site -- opSite
        opSite.`call` -- opCall
        opSeff.steps -- opCall
        opSeff.describedService -- opOperation
        opSite.allowed -- opCopy
        where opCopy.readCpuMs != null

        forbid done {
            opDone: OperationSignature { }
            opFeed.read -- opDone
        }

        var opName = opOperation.entityName + "_" + opCall.entityName

        create opRead: OperationSignature {
            entityName = "read_" + opName
        }
        create opReadSeff: ResourceDemandingSEFF { }
        create opReadStart: StartAction { }
        create opReadAction: InternalAction {
            entityName = "readCopy"
        }
        create opReadWork: Work {
            cpuMs = opCopy.readCpuMs!!
            hddMs = opCopy.readDbMs
        }
        create opReadStop: StopAction { }
        create opWrite: OperationSignature {
            entityName = "write_" + opName
        }
        create opWriteSeff: ResourceDemandingSEFF { }
        create opWriteStart: StartAction { }
        create opWriteAction: InternalAction {
            entityName = "writeCopy"
        }
        create opWriteWork: Work {
            cpuMs = opCopy.writeCpuMs
            hddMs = opCopy.writeDbMs
        }
        create opWriteStop: StopAction { }

        create opCopies.signatures -- opRead
        create opCopies.signatures -- opWrite
        create opFeed.read -- opRead
        create opFeed.write -- opWrite
        create opComponent.serviceEffectSpecifications -- opReadSeff
        create opReadSeff.describedService -- opRead
        create opReadSeff.steps -- opReadStart
        create opReadSeff.steps -- opReadAction
        create opReadSeff.steps -- opReadStop
        create opReadStart.successor -- opReadAction
        create opReadAction.successor -- opReadStop
        create opDecisions.work -- opReadWork
        create opReadWork.action -- opReadAction
        create opComponent.serviceEffectSpecifications -- opWriteSeff
        create opWriteSeff.describedService -- opWrite
        create opWriteSeff.steps -- opWriteStart
        create opWriteSeff.steps -- opWriteAction
        create opWriteSeff.steps -- opWriteStop
        create opWriteStart.successor -- opWriteAction
        create opWriteAction.successor -- opWriteStop
        create opDecisions.work -- opWriteWork
        create opWriteWork.action -- opWriteAction
    } do {
    }

    // The same without readCpuMs: the read is HDD only.
    for match {
        oqFeed: CopyFeed { }
        oqStore: CopyStore { }
        oqComponent: BasicComponent { }
        oqCopies: OperationInterface { }
        oqSite: CallSite { }
        oqCall: ExternalCallAction { }
        oqSeff: ResourceDemandingSEFF { }
        oqOperation: OperationSignature { }
        oqCopy: LocalCopy { }
        oqDecisions: ArchitectureDecisions { }

        oqFeed.copyStore -- oqStore
        oqStore.component -- oqComponent
        oqStore.copies -- oqCopies
        oqFeed.site -- oqSite
        oqSite.`call` -- oqCall
        oqSeff.steps -- oqCall
        oqSeff.describedService -- oqOperation
        oqSite.allowed -- oqCopy
        where oqCopy.readCpuMs == null

        forbid done {
            oqDone: OperationSignature { }
            oqFeed.read -- oqDone
        }

        var oqName = oqOperation.entityName + "_" + oqCall.entityName

        create oqRead: OperationSignature {
            entityName = "read_" + oqName
        }
        create oqReadSeff: ResourceDemandingSEFF { }
        create oqReadStart: StartAction { }
        create oqReadAction: InternalAction {
            entityName = "readCopy"
        }
        create oqReadWork: Work {
            hddMs = oqCopy.readDbMs
        }
        create oqReadStop: StopAction { }
        create oqWrite: OperationSignature {
            entityName = "write_" + oqName
        }
        create oqWriteSeff: ResourceDemandingSEFF { }
        create oqWriteStart: StartAction { }
        create oqWriteAction: InternalAction {
            entityName = "writeCopy"
        }
        create oqWriteWork: Work {
            cpuMs = oqCopy.writeCpuMs
            hddMs = oqCopy.writeDbMs
        }
        create oqWriteStop: StopAction { }

        create oqCopies.signatures -- oqRead
        create oqCopies.signatures -- oqWrite
        create oqFeed.read -- oqRead
        create oqFeed.write -- oqWrite
        create oqComponent.serviceEffectSpecifications -- oqReadSeff
        create oqReadSeff.describedService -- oqRead
        create oqReadSeff.steps -- oqReadStart
        create oqReadSeff.steps -- oqReadAction
        create oqReadSeff.steps -- oqReadStop
        create oqReadStart.successor -- oqReadAction
        create oqReadAction.successor -- oqReadStop
        create oqDecisions.work -- oqReadWork
        create oqReadWork.action -- oqReadAction
        create oqComponent.serviceEffectSpecifications -- oqWriteSeff
        create oqWriteSeff.describedService -- oqWrite
        create oqWriteSeff.steps -- oqWriteStart
        create oqWriteSeff.steps -- oqWriteAction
        create oqWriteSeff.steps -- oqWriteStop
        create oqWriteStart.successor -- oqWriteAction
        create oqWriteAction.successor -- oqWriteStop
        create oqDecisions.work -- oqWriteWork
        create oqWriteWork.action -- oqWriteAction
    } do {
    }
}
