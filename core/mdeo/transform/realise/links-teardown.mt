using "../../metamodel/architecture.mm"

// Derived roles that no decision needs any more go (DESIGN.md AB22): the realisation is a function of
// the decisions, not of the path the search took. A middleware link exists exactly while
// ./links-add.mt would make it (self: its source calls and its container has middleware; peer: a
// call from its source to its target, whose container has middleware; broker: its source has a
// self link); a RealisedRole exactly while a call is re-pointed to it (./roles.mt makes one for a
// call it is about to re-point) or a re-pointed call goes back to it (its RealisedCall.originalRole:
// a Home's call re-targeted to a derived role, then re-pointed again as an orchestrated step,
// redirect or composed call, AB66). Each goes with its role and connector. After the calls were taken
// apart and built (no block uses the link of a pair without a call, every re-pointed call uses its
// role), before the new links.

// RealisedRoles no call is re-pointed to (a redirect, composition, orchestration or delivery undone)
// and no re-pointed call returns to
for match {
    delete tuRealised: RealisedRole { }
    delete tuRole: OperationRequiredRole { }
    delete tuConnector: AssemblyConnector { }
    delete tuRealised.role -- tuRole
    delete tuRealised.connector -- tuConnector
    forbid used {
        tuAction: ExternalCallAction { }
        tuAction.role -- tuRole
    }
    forbid restored {
        tuCall: RealisedCall { }
        tuCall.originalRole -- tuRole
    }
} do {
}

// peer links of a pair without a call
for match {
    delete tpLink: MiddlewareLink {
        kind == "peer"
    }
    tpSource: AssemblyContext { }
    tpTarget: AssemblyContext { }
    delete tpRole: OperationRequiredRole { }
    delete tpConnector: AssemblyConnector { }
    delete tpLink.source -- tpSource
    delete tpLink.target -- tpTarget
    delete tpLink.role -- tpRole
    delete tpLink.connector -- tpConnector
    forbid calling {
        tpCall: RealisedCall { }
        tpCall.caller -- tpSource
        tpCall.provider -- tpTarget
    }
} do {
}

// peer links whose target's container has no middleware (reached directly)
for match {
    delete tdLink: MiddlewareLink {
        kind == "peer"
    }
    tdTarget: AssemblyContext { }
    delete tdRole: OperationRequiredRole { }
    delete tdConnector: AssemblyConnector { }
    delete tdLink.target -- tdTarget
    delete tdLink.role -- tdRole
    delete tdLink.connector -- tdConnector
    forbid middleware {
        tdContext: AllocationContext { }
        tdContainer: ResourceContainer { }
        tdMiddleware: RealisedContainer { }
        tdAssembly: AssemblyContext { }
        tdContext.assemblyContext -- tdTarget
        tdContext.resourceContainer -- tdContainer
        tdMiddleware.container -- tdContainer
        tdMiddleware.assembly -- tdAssembly
    }
} do {
}

// self links of a source that calls nothing
for match {
    delete tsLink: MiddlewareLink {
        kind == "self"
    }
    tsSource: AssemblyContext { }
    delete tsRole: OperationRequiredRole { }
    delete tsConnector: AssemblyConnector { }
    delete tsLink.source -- tsSource
    delete tsLink.role -- tsRole
    delete tsLink.connector -- tsConnector
    forbid calling {
        tsCall: RealisedCall { }
        tsCall.caller -- tsSource
    }
} do {
}

// self links whose source's container has no middleware
for match {
    delete tmLink: MiddlewareLink {
        kind == "self"
    }
    tmSource: AssemblyContext { }
    delete tmRole: OperationRequiredRole { }
    delete tmConnector: AssemblyConnector { }
    delete tmLink.source -- tmSource
    delete tmLink.role -- tmRole
    delete tmLink.connector -- tmConnector
    forbid middleware {
        tmContext: AllocationContext { }
        tmContainer: ResourceContainer { }
        tmMiddleware: RealisedContainer { }
        tmAssembly: AssemblyContext { }
        tmContext.assemblyContext -- tmSource
        tmContext.resourceContainer -- tmContainer
        tmMiddleware.container -- tmContainer
        tmMiddleware.assembly -- tmAssembly
    }
} do {
}

// broker links of a source without a self link
for match {
    delete tbLink: MiddlewareLink {
        kind == "broker"
    }
    tbSource: AssemblyContext { }
    delete tbRole: OperationRequiredRole { }
    delete tbConnector: AssemblyConnector { }
    delete tbLink.source -- tbSource
    delete tbLink.role -- tbRole
    delete tbLink.connector -- tbConnector
    forbid linked {
        tbSelf: MiddlewareLink {
            kind == "self"
        }
        tbSelf.source -- tbSource
    }
} do {
}
