using "../../../metamodel/architecture.mm"

// The donor's coordination style for one workflow of the model (DESIGN.md AC4): the workflow's
// counterpart in the donor is the one whose trigger SEFF describes the signature of the same name
// (unique per workflow in F's models, stable: no operator changes workflows' triggers); its style
// stands for the allowed style of the model of the same class (Choreographed, Orchestrated: shared
// option objects without a name, AC1). `style` is that style of the model. Fails, before any change
// (it changes nothing), when there is no counterpart, when the workflow does not allow the donor's
// style or already has it.
in donor: model
in workflow: Workflow
out style: Coordination

match {
    workflow { }
    dsTrigger: ResourceDemandingSEFF { }
    dsSignature: Signature { }
    dsCurrent: Coordination { }
    dsOption: Coordination { }
    workflow.trigger -- dsTrigger
    dsTrigger.describedService -- dsSignature
    dsComponent: BasicComponent { }
    dsComponent.serviceEffectSpecifications -- dsTrigger
    workflow.style -- dsCurrent
    workflow.allowed -- dsOption
    in donor {
        dsDonorWorkflow: Workflow { }
        dsDonorTrigger: ResourceDemandingSEFF { }
        dsDonorSignature: Signature { }
        dsDonorStyle: Coordination { }
        dsDonorWorkflow.trigger -- dsDonorTrigger
        dsDonorTrigger.describedService -- dsDonorSignature
        dsDonorComponent: BasicComponent { }
        dsDonorComponent.serviceEffectSpecifications -- dsDonorTrigger
        dsDonorWorkflow.style -- dsDonorStyle
    }
    where dsDonorSignature.entityName == dsSignature.entityName
    // the trigger's component too: the SEFFs of a request at its candidate homes share the signature's name (AB38)
    where dsDonorComponent.entityName == dsComponent.entityName
    where (dsDonorStyle is Choreographed && dsOption is Choreographed) || (dsDonorStyle is Orchestrated && dsOption is Orchestrated)
}
style = dsOption
