using "../../metamodel/architecture.mm"

// The part of the plan that depends on mechanisms and coordination only (DESIGN.md B3,
// ./plan.mt): steps, redirects, caches, asynchronous calls, then the kinds of middleware.

for match {
    psCall: RealisedCall {
        shape != "step"
        shape = "step"
    }
    psAction: ExternalCallAction { }
    psWorkflow: Workflow { }
    psStyle: Orchestrated { }
    psCall.action -- psAction
    psWorkflow.steps -- psAction
    psWorkflow.style -- psStyle
} do {
}

for match {
    prCall: RealisedCall {
        shape != "redirect"
        shape = "redirect"
    }
    prAction: ExternalCallAction { }
    prRedirect: Redirect { }
    prCall.action -- prAction
    prRedirect.`call` -- prAction
    forbid step {
        prWorkflow: Workflow { }
        prStyle: Orchestrated { }
        prWorkflow.steps -- prAction
        prWorkflow.style -- prStyle
    }
} do {
}

for match {
    phCall: RealisedCall {
        shape != "cache"
        shape = "cache"
    }
    phAction: ExternalCallAction { }
    phSite: CallSite { }
    phMechanism: CachedCall { }
    phCall.action -- phAction
    phCall.site -- phSite
    phSite.mechanism -- phMechanism
    forbid step {
        phWorkflow: Workflow { }
        phStyle: Orchestrated { }
        phWorkflow.steps -- phAction
        phWorkflow.style -- phStyle
    }
} do {
}

for match {
    paCall: RealisedCall {
        shape != "async"
        shape = "async"
    }
    paAction: ExternalCallAction { }
    paSite: CallSite { }
    paMechanism: AsyncCall { }
    paCall.action -- paAction
    paCall.site -- paSite
    paSite.mechanism -- paMechanism
    forbid step {
        paWorkflow: Workflow { }
        paStyle: Orchestrated { }
        paWorkflow.steps -- paAction
        paWorkflow.style -- paStyle
    }
} do {
}

// ═══ Kinds ════════════════════════════════════════════════════════════════════════════
for match {
    kpCall: RealisedCall {
        kind != "published"
        kind = "published"
    }
    kpDelivery: Delivery { }
    kpNotification: Notification { }
    where kpNotification.published != null && kpNotification.published!! == true
    kpRemote: RemoteCalls { }
    kpBroker: AssemblyContext { }
    kpCall.delivery -- kpDelivery
    kpNotification.deliveries -- kpDelivery
    kpRemote.broker -- kpBroker
} do {
}

for match {
    krCall: RealisedCall {
        shape == "step"
        kind != "reply"
        kind = "reply"
    }
    krSite: CallSite { }
    krMechanism: AsyncCall { }
    krRemote: RemoteCalls { }
    krBroker: AssemblyContext { }
    krCall.site -- krSite
    krSite.mechanism -- krMechanism
    krRemote.broker -- krBroker
} do {
}

for match {
    kaCall: RealisedCall {
        shape == "async"
        kind != "async"
        kind = "async"
    }
    kaRemote: RemoteCalls { }
    kaBroker: AssemblyContext { }
    kaRemote.broker -- kaBroker
} do {
}

for match {
    ksCall: RealisedCall {
        kind != "sync"
        kind = "sync"
    }
    forbid published {
        ksDelivery: Delivery { }
        ksNotification: Notification { }
        where ksNotification.published != null && ksNotification.published!! == true
        ksRemote: RemoteCalls { }
        ksBroker: AssemblyContext { }
        ksCall.delivery -- ksDelivery
        ksNotification.deliveries -- ksDelivery
        ksRemote.broker -- ksBroker
    }
    forbid reply {
        where ksCall.shape == "step"
        ksSite: CallSite { }
        ksMechanism: AsyncCall { }
        ksReplyRemote: RemoteCalls { }
        ksReplyBroker: AssemblyContext { }
        ksCall.site -- ksSite
        ksSite.mechanism -- ksMechanism
        ksReplyRemote.broker -- ksReplyBroker
    }
    forbid asynchronous {
        where ksCall.shape == "async"
        ksAsyncRemote: RemoteCalls { }
        ksAsyncBroker: AssemblyContext { }
        ksAsyncRemote.broker -- ksAsyncBroker
    }
} do {
}
