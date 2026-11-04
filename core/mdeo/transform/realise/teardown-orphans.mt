using "../../metamodel/architecture.mm"

// Derived roles and middleware links whose target assembly was removed (a copy store's, by the
// layer-3 repair) go with their role and connector (DESIGN.md B4): they are kept once made only
// while their ends exist. After the calls that used them were taken apart.

for match {
    orRealised: RealisedRole { }
    delete orRole: OperationRequiredRole { }
    delete orConnector: AssemblyConnector { }
    delete orRealised.role -- orRole
    delete orRealised.connector -- orConnector
    forbid targeted {
        orTarget: AssemblyContext { }
        orRealised.target -- orTarget
    }
} do {
}

for match {
    delete orDone: RealisedRole { }
    forbid targeted {
        odTarget: AssemblyContext { }
        orDone.target -- odTarget
    }
} do {
}

for match {
    olLink: MiddlewareLink { }
    delete olRole: OperationRequiredRole { }
    delete olConnector: AssemblyConnector { }
    delete olLink.role -- olRole
    delete olLink.connector -- olConnector
    forbid targeted {
        olTarget: AssemblyContext { }
        olLink.target -- olTarget
    }
} do {
}

for match {
    delete olDone: MiddlewareLink { }
    forbid targeted {
        oeTarget: AssemblyContext { }
        olDone.target -- oeTarget
    }
} do {
}
