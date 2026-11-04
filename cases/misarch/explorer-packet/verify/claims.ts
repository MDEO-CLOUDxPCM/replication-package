/**
 * The context the MiSArch packet's part builders share (the Verify tab's parts, contract/verify.ts): the inputs, their
 * lookups, links between parts and the documents of a service; and the case's kinds of parts, groups and operation
 * scopes (written into verify/parts.json). parts.ts assembles the parts from the builders (the domain itself in
 * parts.ts; coverage.ts, features.ts, workload.ts).
 */
import type { InputModel } from '../../../../core/explorer/contract/types';
import { cyrb53 } from '../../../../core/explorer/contract/hash';
import type { DocRef, Loc, Part, PartKindDef, ScopeDef, Table, Tok } from '../../../../core/explorer/contract/verify';
import type { AOperation, Extraction, Inventory } from './extraction';
import { files } from '../config';

export type { DocRef, Fact, Loc, Part, Row, Table, Tok } from '../../../../core/explorer/contract/verify';

export type PartKind = 'coverage' | 'class' | 'ref' | 'op' | 'event' | 'join' | 'binding' | 'saga' | 'req' | 'feature' | 'timing' | 'session' | 'profile' | 'workload' | 'param';
export const PART_KINDS: (PartKindDef & { id: PartKind })[] = [
  { id: 'coverage', label: 'coverage', plural: 'Coverage', short: '✓' },
  { id: 'class', label: 'class', plural: 'Classes', short: 'C' },
  { id: 'ref', label: 'reference', plural: 'References', short: 'R' },
  { id: 'op', label: 'operation', plural: 'Operations', short: 'O' },
  { id: 'event', label: 'event', plural: 'Events', short: 'E' },
  { id: 'join', label: 'join', plural: 'Joins', short: 'J' },
  { id: 'binding', label: 'binding', plural: 'Bindings', short: 'B' },
  { id: 'saga', label: 'saga', plural: 'Sagas', short: 'S' },
  { id: 'req', label: 'request type', plural: 'Request types', short: 'Q' },
  { id: 'feature', label: 'feature', plural: 'Features', short: 'F' },
  { id: 'timing', label: 'timing', plural: 'Timings', short: 'T' },
  { id: 'session', label: 'session class', plural: 'Session classes', short: 'U' },
  { id: 'profile', label: 'load profile', plural: 'Load profiles', short: 'L' },
  { id: 'workload', label: 'workload', plural: 'Workload', short: 'W' },
  { id: 'param', label: 'parameter', plural: 'Parameters', short: 'P' },
];
/** groups after the services, in this order */
export const LATE_GROUPS = ['cross-service', 'features', 'workload', 'parameters'];

/** where an operation stands in the optimisation's model (core/generator/derive.py: reach, counted_operations) */
export type OpScope = 'simulated' | 'coupling' | 'copy' | 'trivial' | 'other';
export const OP_SCOPE: Record<OpScope, ScopeDef> = {
  simulated: { label: 'simulated', about: 'reached by the workload: in the model with its SEFF, timing and call sites', inModel: true },
  coupling: { label: 'coupling only', about: 'a domain operation the workload does not reach: in the model with its accesses and calls for C3 (change coupling), no SEFF, no timing (AB25)', inModel: true, badge: 'C3' },
  copy: { label: 'left out: copy maintenance', about: 'keeps a local copy of another service up to date: a realisation of today\'s cut (the copy mechanism), not a domain operation', badge: 'out' },
  trivial: { label: 'left out: trivial', about: 'no access, call or publish', badge: 'out' },
  other: { label: 'left out', about: 'not a domain operation', badge: 'out' },
};

/** the short label of a document's chip, per DocRef kind */
export const DOC_KINDS: Record<DocKind, string> = {
  schema: 'GraphQL', spec: 'spec', fixes: 'fixes', curated: 'curated', event: 'event', subscribe: 'subscribe',
  workload: 'workload', report: 'report', derivation: 'derivation', metamodel: 'metamodel',
};
/** an operation's facts shown above what it causes; the rest under "More" */
export const LEAD_FACTS: Record<string, string[]> = {
  op: ['GraphQL', 'topic', 'HTTP route', 'schedule', 'entry point', 'home class (F2)', 'saga', 'process', 'rate', 'check', 'note'],
};
/** the source trees (config.ts `sources`): misarch-kotlin at the extraction's commit, this project's files */
export const TREE = 'misarch';
export const PROJECT = 'project';

export type DocKind = 'schema' | 'spec' | 'fixes' | 'curated' | 'event' | 'subscribe' | 'workload' | 'report' | 'derivation' | 'metamodel';

export const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const part = (key: string, label: string): Tok => ({ part: key, label });
export const code = (text: string): Tok => ({ code: text });
export const chip = (text: string, tone?: 'muted' | 'warn' | 'ok'): Tok => ({ chip: text, tone });
export const opKey = (id: string) => `op:${id}`;
export const short = (id: string) => id.slice(id.indexOf('.') + 1);
export const val = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : String(v));
export const join = (...xs: (string | undefined | false)[]) => xs.filter(Boolean).join('; ') || undefined;
export const num = (v: number | undefined, d = 3) => (v === undefined || !Number.isFinite(v) ? '–' : Number(v.toPrecision(d)).toString());

/** `path:line` (or a free reference outside misarch-kotlin) */
export function parseEvidence(ev: string | undefined | null, label?: string): Loc[] {
  if (!ev) return [];
  const m = /^(.*):(\d+)$/.exec(ev);
  return [m ? { repo: TREE, path: m[1], line: +m[2], label } : { repo: TREE, path: ev, label }];
}

/** a GraphQL type of the class: the type itself, an interface, or its variants (CategoricalCategoryCharacteristic) */
export const gqlType = (name: string) => `^(?:type|interface|union)\\s+\\w*${esc(name)}\\b`;
/** the GraphQL field of a reference attribute: categoryId -> category, product_variant_id -> productVariant */
export const gqlField = (attr: string) => attr.replace(/_ids?$|Ids?$/, '').replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

/** package C's session model (workload/sessions.json), as far as the Verify tab reads it */
/* eslint-disable @typescript-eslint/no-explicit-any */
export type Workload = Record<string, any>;

export interface Inputs { a: Extraction; model?: InputModel; tree?: Set<string>; inventory?: Inventory; workload?: Workload }

export function makeCtx({ a, model, tree, inventory, workload }: Inputs) {
  const has = (p: string) => !tree || tree.has(p);
  const ops = new Map(a.operations.map((o) => [o.id, o]));
  const mops = new Map((model?.operations ?? []).map((o) => [o.id, o]));
  const classSvc = new Map(a.classes.map((c) => [c.name, c.service]));
  const features = new Map(a.features.map((f) => [f.code, f.name]));
  const pms = new Map(a.persistenceMethods.map((m) => [`${m.service}|${m.method}`, m]));
  const eventTopics = new Set(a.events.map((e) => e.topic));
  const requests = new Set((model?.requests ?? []).map((r) => r.id));
  const opLink = (id: string): Tok => (ops.has(id) ? part(opKey(id), id) : code(id));
  const clsLink = (c: string): Tok => (classSvc.has(c) ? part(`class:${c}`, c) : code(c));
  const topicLink = (t: string): Tok => (eventTopics.has(t) ? part(`event:${t}`, t) : code(t));
  const reqLink = (r: string): Tok => (requests.has(r) ? part(`req:${r}`, r) : code(r));
  const scopeOf = (o: AOperation): OpScope => (mops.has(o.id) ? 'simulated' : o.mechanism === 'copy' ? 'copy' : o.trivial ? 'trivial' : o.domain ? 'coupling' : 'other');
  const listToks = (xs: Tok[]): Tok[] => xs.flatMap((x, i) => (i ? [', ', x] : [x]));
  const project = (path: string): Loc => ({ repo: PROJECT, path });
  const docs = {
    schema: (svc: string, find?: string[]): DocRef[] => (has(`reference/schemas/${svc}.graphql`) ? [{ label: `${svc}.graphql`, kind: 'schema', loc: { repo: TREE, path: `reference/schemas/${svc}.graphql` }, find }] : []),
    sdl: (svc: string, find?: string[]): DocRef[] => (has(`reference/sdl/${svc}.graphql`) ? [{ label: `sdl ${svc}.graphql`, kind: 'schema', loc: { repo: TREE, path: `reference/sdl/${svc}.graphql` }, find }] : []),
    spec: (svc: string, find?: string[]): DocRef[] => (has(`docs/specs/${svc}.md`) ? [{ label: `spec ${svc}.md`, kind: 'spec', loc: { repo: TREE, path: `docs/specs/${svc}.md` }, find }] : []),
    fixes: (svc: string, find?: string[]): DocRef[] => (has(`docs/fixes/${svc}.md`) ? [{ label: `fixes ${svc}.md`, kind: 'fixes', loc: { repo: TREE, path: `docs/fixes/${svc}.md` }, find }] : []),
    curated: (svc: string, find?: string[]): DocRef[] => [{ label: `curated ${svc}.yaml`, kind: 'curated', loc: project(files.docs.curated(svc)), find }],
    project: (kind: DocKind, path: string, find?: string[]): DocRef => ({ label: path.slice(path.lastIndexOf('/') + 1), kind, loc: project(path), find }),
  };
  const out: Part[] = [];
  const add = (p: Omit<Part, 'text' | 'fp'> & { kind: PartKind; scope?: OpScope }) => {
    const claims = { f: p.facts.filter((f) => !f.volatile), t: p.tables.filter((t) => !t.volatile).map((t) => FP_AS.get(t) ?? t), c: p.code };
    out.push({ ...p, text: `${p.key} ${p.title} ${p.subtitle ?? ''} ${p.group}`.toLowerCase(), fp: cyrb53(JSON.stringify(claims)) });
  };
  return { a, model, tree, inventory, workload, has, ops, mops, scopeOf, classSvc, features, pms, eventTopics, opLink, clsLink, topicLink, reqLink, listToks, docs, out, add };
}
export type Ctx = ReturnType<typeof makeCtx>;

/**
 * a table in other words than its fingerprint's: its fingerprint is taken over the older spelling (the value), whose
 * claims are the same, so the marks made on its part stay. Not written into the packet.
 */
export const FP_AS = new WeakMap<Table, Table>();
