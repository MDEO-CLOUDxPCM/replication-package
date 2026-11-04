using "../../../metamodel/architecture.mm"

// Give `workflow` the style `style` if it has another one; `switched` says whether it changed.
// Never fails.
in workflow: Workflow
in style: Coordination
out switched: boolean

switched = false
if match {
    workflow { }
    style { }
    ssOld: Coordination { }
    workflow.style -- ssOld
    where ssOld != style
    delete workflow.style -- ssOld
    create workflow.style -- style
} then {
    switched = true
}
