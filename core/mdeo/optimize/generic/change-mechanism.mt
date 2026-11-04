using "../../metamodel/architecture.mm"

// Change the mechanism of a call site to another of its allowed mechanisms (never to the one it
// has). Site first (P10, DESIGN.md D58): mdeo takes the first match in a shuffled order, starting
// at the pattern element its planner finds most selective (D52). In one pattern with the options
// that is an option, so sites with options of their own (copy_<provider>) changed far more often
// than others. Here the first match binds only a site with at least two options, drawn uniformly;
// the second then draws one of that site's other options uniformly. The outputs tell a caller what
// changed (the layer-3 repair, DESIGN.md H19): the site and its mechanism before. As an operator
// they are ignored.
out changed: CallSite
out previous: Mechanism

match {
    site: CallSite { }

    require choice {
        one: Mechanism { }
        two: Mechanism { }
        site.allowed -- one
        site.allowed -- two
    }
    // not a site of a home option that is not chosen (DESIGN.md AB38: unreached, a change there changes nothing);
    // the forbid's objects are distinct (injective), so the chosen option is another one
    forbid idle {
        cmIdleCall: RealisedCall { }
        cmIdleSeff: ResourceDemandingSEFF { }
        cmIdleHome: Home { }
        cmIdleOption: HomeOption { }
        cmIdleChosen: HomeOption { }
        cmIdleCall.site -- site
        cmIdleCall.seff -- cmIdleSeff
        cmIdleOption.seffs -- cmIdleSeff
        cmIdleHome.options -- cmIdleOption
        cmIdleHome.home -- cmIdleChosen
    }
}

match {
    site { }
    current: Mechanism { }
    next: Mechanism { }

    site.allowed -- next

    delete site.mechanism -- current
    create site.mechanism -- next

    forbid unchanged {
        site.mechanism -- next
    }

    changed = site
    previous = current
}
