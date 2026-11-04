/**
 * The `?` popovers' docs: how an objective, constraint or metric is computed. The data is the packet's
 * doc `metrics` (a list of MetricDoc, keyed by the keys of the run contract — Run.objectives / constraints / metrics —
 * plus the design table's and the performance panel's own figures); this module holds its types, the literature
 * helpers and the hooks that read it. A packet without the doc has no popovers.
 *
 * Text conventions: `code` in backticks; formulas are TeX (KaTeX).
 */
import { useDoc } from './packet';

export interface MetricDoc {
  key: string;
  title: string;
  /** O1 … O5, C1 … C5, or empty */
  code?: string;
  kind: 'objective' | 'constraint' | 'metric' | 'design' | 'performance' | 'search';
  unit?: string;
  /** minimised, a violation (0 = met), higher is better, descriptive */
  direction: string;
  /** plain language, one or two sentences */
  summary: string;
  /** TeX, one display line each */
  formula?: string[];
  /** symbol (TeX) → meaning */
  where?: [string, string][];
  /** model elements and functions the value is computed from */
  inputs: string[];
  assumptions?: string[];
  /** function names and documentation sections */
  cite: string[];
  /** decision-layer parameters (metamodel classes) whose values the popover lists from the input model */
  params?: string[];
  /** places in the Model panel (`model=` targets) */
  links?: { label: string; target: string }[];
  /** literature the metric (or its formula) is taken from, based on, or related to; each verified (DOI or URL) */
  refs?: Ref[];
  /** for a construction of this project: where it is defined, e.g. 'project-specific (docs/quality.md, O2)' */
  origin?: string;
}

/**
 * A literature reference of a popover. `relation` says how honest the link is: `source` the metric is taken as
 * defined there, `based on` the formula follows it, `adapted from` the formula follows it with changes (said in
 * `note`), `related` only the concept is discussed there.
 */
export interface Ref {
  /** "Becker, Koziolek, Reussner" (family names) */
  authors: string;
  year: number;
  title: string;
  venue: string;
  /** without the https://doi.org/ prefix */
  doi?: string;
  /** when there is no DOI (books, documentation) */
  url?: string;
  relation: 'source' | 'based on' | 'adapted from' | 'related';
  /** what is taken over or what differs */
  note?: string;
}

export const REF_RELATIONS: Ref['relation'][] = ['source', 'based on', 'adapted from', 'related'];

/** short form for the popover: "Becker et al. 2009" */
export function refShort(r: Ref): string {
  const a = r.authors.split(',').map((x) => x.trim()).filter(Boolean);
  const who = a.length === 1 ? a[0] : a.length === 2 ? `${a[0]} & ${a[1]}` : `${a[0]} et al.`;
  return `${who} ${r.year}`;
}

export const refLink = (r: Ref): string => (r.doi ? `https://doi.org/${r.doi}` : r.url!);

/** the packet's metric docs (doc `metrics`), undefined while the packet loads or when it has none */
export function useMetricDocs(): MetricDoc[] | undefined {
  return useDoc<MetricDoc[]>('metrics');
}

const byKey = new WeakMap<MetricDoc[], ReadonlyMap<string, MetricDoc>>();
const NONE: ReadonlyMap<string, MetricDoc> = new Map();

/** the packet's metric docs by key (one map per loaded doc) */
export function useMetricDocMap(): ReadonlyMap<string, MetricDoc> {
  const docs = useMetricDocs();
  if (!docs) return NONE;
  let m = byKey.get(docs);
  if (!m) byKey.set(docs, m = new Map(docs.map((d) => [d.key, d])));
  return m;
}

/** the doc of one key (undefined: no popover) */
export function useMetricDoc(key: string): MetricDoc | undefined {
  return useMetricDocMap().get(key);
}
