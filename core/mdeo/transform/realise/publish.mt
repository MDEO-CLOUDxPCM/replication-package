using "../../metamodel/architecture.mm"

// The publish of a published Notification with a broker (DESIGN.md B3): first in its fork, on
// the owner's middleware (publishCpuMs), once per notification.

for match {
    pbRealised: RealisedNotification { }
    pbNotification: Notification {
        published == true
    }
    pbRemote: RemoteCalls { }
    pbBroker: AssemblyContext { }
    pbOwner: AssemblyContext { }
    pbLink: MiddlewareLink {
        kind == "self"
    }
    pbRole: OperationRequiredRole { }
    pbRoot: Realisation { }
    pbInterface: OperationInterface { }
    pbOperation: OperationSignature {
        entityName == "publish"
    }
    pbBody: ForkedBehaviour { }
    pbStart: StartAction { }
    pbNext: AbstractAction { }
    pbRealised.notification -- pbNotification
    pbRemote.broker -- pbBroker
    pbRealised.owner -- pbOwner
    pbLink.source -- pbOwner
    pbLink.role -- pbRole
    pbRoot.middleware -- pbInterface
    pbInterface.signatures -- pbOperation
    pbRealised.body -- pbBody
    pbBody.steps -- pbStart
    delete pbStart.successor -- pbNext
    forbid done {
        pbExisting: ExternalCallAction { }
        pbRealised.publish -- pbExisting
    }
    create pbPublish: ExternalCallAction {
        entityName = "publish"
    }
    create pbBody.steps -- pbPublish
    create pbStart.successor -- pbPublish
    create pbPublish.successor -- pbNext
    create pbPublish.role -- pbRole
    create pbPublish.calledService -- pbOperation
    create pbRealised.publish -- pbPublish
} do {
}
