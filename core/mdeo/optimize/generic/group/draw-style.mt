using "../../../metamodel/architecture.mm"

// The coordination style that change-workflow-mechanisms gives its workflow together with the new
// mechanism (DESIGN.md M3): drawn uniformly among the workflow's allowed styles, its current one
// included (with two styles the style switches in half of the applications). Changes nothing.
in workflow: Workflow
out style: Coordination

match {
    workflow { }
    dsDrawn: Coordination { }
    workflow.allowed -- dsDrawn
}
style = dsDrawn
