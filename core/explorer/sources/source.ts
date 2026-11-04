import type { Packet } from '../server/packets';
import type { Design, DesignDetail, DesignSummary, Domain, Id, InputModel, Run, RunSummary, SourceKind, SourceStatus } from '../contract/types';

/** A place runs come from. The backend merges all configured sources into one index. */
export interface Source {
  readonly id: Id;
  readonly kind: SourceKind;
  /** (re)read the source; must not throw — report problems through status() */
  load(): Promise<void>;
  status(): SourceStatus;
  runs(): RunSummary[];
  domains(): Domain[];
  run(id: Id): Promise<Run | null>;
  /** the run's designs without decisions (a run may hold 50 000+ designs) */
  designs(runId: Id): Promise<DesignSummary[] | null>;
  /** one design with its decisions */
  design(runId: Id, id: Id): Promise<Design | null>;
  /** precomputed detail exported with the run, if any */
  detail(runId: Id, hash: string): Promise<DesignDetail | null>;
  /** the optimisation's input model of a domain (bundles: models/<domainId>.json), if the source has one */
  inputModel?(domainId: Id): InputModel | null;
  /** (1.10.0) the source's data packet (bundles: packet.json, server/packets.ts) */
  packet?(): Packet | null;
}

export interface SourceConfig {
  id: Id;
  kind: SourceKind;
  enabled?: boolean;
  [k: string]: unknown;
}

export function summarize(run: Run): RunSummary {
  const { contract: _c, config: _cfg, metrics: _m, history: _h, hypervolume: _hv, archive: _a, finalPopulation: _f, references: _r, ...summary } = run;
  return summary;
}
