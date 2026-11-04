/**
 * The MiSArch packet's vocabulary (packet.json `vocabulary`): the mechanisms, styles and operation kinds as the UI
 * names them. A docs module: build.ts merges every module's `vocabulary` and `docs` (texts merged by key).
 */
import type { Vocabulary } from '../../../../core/explorer/contract/packet';

export const vocabulary: Vocabulary = {
  mechanisms: [
    { id: 'sync', label: 'sync' },
    { id: 'async', label: 'async' },
    { id: 'inTx', label: 'in transaction' },
    { id: 'cache', label: 'cache' },
    { id: 'copy', label: 'copy' },
    { id: 'join', label: 'join' },
    { id: 'joinCache', label: 'join + cache' },
    { id: 'saga', label: 'saga' },
  ],
  styles: [
    { id: 'choreography', label: 'choreography' },
    { id: 'orchestration', label: 'orchestration' },
  ],
  operationKinds: [
    { id: 'query', label: 'query', short: 'Q' },
    { id: 'mutation', label: 'mutation', short: 'M' },
    { id: 'resolver', label: 'field resolver', short: 'R' },
    { id: 'reaction', label: 'event reaction', short: 'E' },
    { id: 'callback', label: 'provider callback', short: 'C' },
    { id: 'job', label: 'scheduled job', short: 'J' },
  ],
  // the architecture graph's edge layers: legend, mechanism badges, edge tooltips (an access within one service has no
  // mechanism and no edge: its placement is "no hop")
  edges: [
    { id: 'sync', label: 'sync call', about: 'synchronous call to the owning service' },
    { id: 'copy', label: 'local copy', about: 'read a local copy fed by events' },
    { id: 'cache', label: 'cache', about: 'cache in front of a synchronous call' },
    { id: 'join', label: 'gateway join', about: 'the gateway fetches it from the owner' },
    { id: 'saga', label: 'async / saga step', about: 'an asynchronous call to another service (an async write or event, or an asynchronous saga step)' },
    { id: 'feed', label: 'copy feed', about: "the owner's events feed a copy" },
    { id: 'event', label: 'domain event', about: 'a published event handled in another service' },
    { id: 'reference', label: 'reference', about: 'class reference in the domain model' },
  ],
};
