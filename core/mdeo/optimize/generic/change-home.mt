using "../../metamodel/architecture.mm"

// Change the home of an operation (DESIGN.md AB38): a Home with at least two options (the classes the
// operation writes in its transaction) takes another of its options, drawn uniformly (never the one it
// has). Home first, as change-mechanism draws the site first. `changed` and `previous` tell a caller what
// changed (the repair, ../realised/change-home.mt); as an operator they are ignored.
out changed: Home
out previous: HomeOption

match {
    home: Home { }

    require choice {
        one: HomeOption { }
        two: HomeOption { }
        home.options -- one
        home.options -- two
    }
}

match {
    home { }
    current: HomeOption { }
    next: HomeOption { }

    home.options -- next

    delete home.home -- current
    create home.home -- next

    forbid unchanged {
        home.home -- next
    }

    changed = home
    previous = current
}
