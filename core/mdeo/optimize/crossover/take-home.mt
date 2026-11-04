using "../../metamodel/architecture.mm"
import "../realised/home-repair.mt" as repairHome

// Crossover take-home (DESIGN.md AB38): one Home on which the donor differs takes the donor's home (the
// option of the same class; Homes match by their operation's name). Repaired as change-home
// (../realised/home-repair.mt). Fails, before any change, when the donor agrees on every Home.
in donor: model

match {
    thHome: Home { }
    thWant: HomeOption { }
    thHome.options -- thWant
    forbid same {
        thHome.home -- thWant
    }
    in donor {
        thDonorHome: Home { }
        thDonorOption: HomeOption { }
        thDonorHome.home -- thDonorOption
    }
    where thDonorHome.operation == thHome.operation
    where thDonorOption.cls == thWant.cls
}

match {
    thHome { }
    thWant { }
    thCurrent: HomeOption { }
    delete thHome.home -- thCurrent
    create thHome.home -- thWant
}

call repairHome()
