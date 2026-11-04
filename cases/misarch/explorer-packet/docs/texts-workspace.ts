/**
 * The MiSArch packet's texts of the workspace, its panels and their components (web/src/views, components, help):
 * key -> template (lib/packet.tsx renderTemplate; inline markup through help/Rich.tsx). A docs module: build.ts merges
 * every module's `texts` into the doc `texts`.
 */
export const texts: Record<string, string> = {
  // views/Workspace.tsx: what the Model panel shows next to its title
  'workspace.panel.model.context': "MiSArch as the optimisation's input",

  // components/DesignPanels.tsx OperationsPanel: the operation kinds' tooltips (Domain operation kinds)
  'arch.ops.kind.query': 'GraphQL query',
  'arch.ops.kind.mutation': 'GraphQL mutation',
  'arch.ops.kind.handler': 'event handler',
  'arch.ops.kind.internal': 'resolver / internal',

  // components/DesignPanels.tsx EffectsPanel
  'arch.effects.none': 'This run has no effect steps.',
  'arch.effects.homes.title': 'Homes',
  'arch.effects.about': "An effect step: operation A causes a change at class B (a write of another class, an event reaction, a provider callback). In transaction, it **joins** A's transaction while A and B share a container and their schemas a database server: a direct call, no envelope, commit or message; otherwise it runs as a synchronous step.",

  // views/PerformanceView.tsx Consistency: the simulation differs from the search's
  'perf.consistency.indicative': 'this simulation is not exactly the one the search ran: its figures are indicative',
};
