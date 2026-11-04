using "../../metamodel/architecture.mm"
import "../sync-microservices.mt" as syncMicroservices
import "../../transform/realise.mt" as realise

// The whole-model consistency of a MiSArch model with the realised layer 2 (DESIGN.md B4): the
// layer-3 sync, then the whole realisation of layer 2. The reference of the operators' local
// repairs (harness `pairs`, ARCH_SYNC) and of the check mode (ARCH_CHECK_SYNC).
call syncMicroservices()
call realise()
