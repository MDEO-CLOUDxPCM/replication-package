using "../../metamodel/architecture.mm"

// ../realise/plan-sites.mt for the calls marked dirty only (DESIGN.md B4.9, B4.10): the plan of a
// mechanism repair through declared objects (a pinned `pc { shape = .. }` writes the wrong
// property on domain.mm, B4.10).

for match {
    psRoot: Realisation { }
    psCall: RealisedCall {
        shape != "step"
        shape = "step"
    }
    psRoot.dirty -- psCall
    psAction: ExternalCallAction { }
    psWorkflow: Workflow { }
    psStyle: Orchestrated { }
    psCall.action -- psAction
    psWorkflow.steps -- psAction
    psWorkflow.style -- psStyle
} do {
}

for match {
    prRoot: Realisation { }
    prCall: RealisedCall {
        shape != "redirect"
        shape = "redirect"
    }
    prRoot.dirty -- prCall
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
    phRoot: Realisation { }
    phCall: RealisedCall {
        shape != "cache"
        shape = "cache"
    }
    phRoot.dirty -- phCall
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
    paRoot: Realisation { }
    paCall: RealisedCall {
        shape != "async"
        shape = "async"
    }
    paRoot.dirty -- paCall
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
    kpRoot: Realisation { }
    kpCall: RealisedCall {
        kind != "published"
        kind = "published"
    }
    kpRoot.dirty -- kpCall
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
    krRoot: Realisation { }
    krCall: RealisedCall {
        shape == "step"
        kind != "reply"
        kind = "reply"
    }
    krRoot.dirty -- krCall
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
    kaRoot: Realisation { }
    kaCall: RealisedCall {
        shape == "async"
        kind != "async"
        kind = "async"
    }
    kaRoot.dirty -- kaCall
    kaRemote: RemoteCalls { }
    kaBroker: AssemblyContext { }
    kaRemote.broker -- kaBroker
} do {
}

for match {
    ksRoot: Realisation { }
    ksCall: RealisedCall {
        kind != "sync"
        kind = "sync"
    }
    ksRoot.dirty -- ksCall
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
