/**
 * Exporter of the optimisation's input model (docs/model.md §3): how MiSArch enters the optimisation.
 * Writes <out>/models/<domainId>.json (contract `InputModel`, served at GET /api/domains/:id/model).
 *
 *   pnpm export:model [--build <build>] [--neutral <realised>.model.json] [--today …] [--monolith …]
 *       [--domain misarch-kotlin-derived] [--out <packet>]        (part of pnpm packet:misarch, build.ts)
 *
 * Every path comes from config.ts. Read (never written): package A's extraction (domain/misarch-domain.json), package C's workload
 * (workload/sessions.json), the timing campaign's parts (timing/parts.json), the committed realised seeds of the
 * derived model (models/domain-<seed>-realised.m, written by core/tools/realise-seeds.sh; converted to model data by the
 * harness's exporter, the platform's parser, cached in config `harness.cache`; --build reads a build's
 * realised/<seed>.model.json instead, --neutral etc. one seed's model data) (neutral for the SEFF structure and the domain section, today and monolith
 * for their mechanisms, today also for the load profile, C1's policy and budgets) and the metamodel
 * files (metamodel/*.mm, parsed here). Every input is recorded with its content hash, a realised seed also with the
 * model it was realised from: the backend serves the model with its freshness and exports again when an input
 * changed (server/model-sync.ts).
 *
 * The SEFFs are read as the base model: every action of a SEFF in order (predecessor chain), branch
 * probabilities and loop counts as multiplicities, asynchronous forks marked; calls are the base
 * calls the realisation records (`RealisedCall.action`), so the middleware blocks the realisation
 * adds are left out (docs/model.md §5); demands are the mean of their StoEx in ms of one full core
 * (`RealisedDemand.ms` where the realisation made one).
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ConsistencyLevel, HomeRef, Id, InputModel, JoinBlocker, ModelCall, ModelInput, Metamodel, MmClass, ModelAccess, ModelBinding, ModelClass, ModelEvent, ModelOperation, ModelOperationKind, ModelOrigin,
  ModelEnvelope, ModelParameter, ModelProcess, ModelProfile, ModelReference, ModelRequest, ModelSeff, ModelSession, ModelSite, ModelTopic, SeffPart,
} from '../../../core/explorer/contract/types';
import { CONTRACT_VERSION } from '../../../core/explorer/contract/types';
import { modelFingerprint } from '../../../core/explorer/contract/hash';
import { parseMetamodel, supertypes } from '../../../core/explorer/contract/metamodel';
import { loadMisarchDomain, LOAD_FACTOR } from './domain-a';
import { fromWorkload, stoexMean } from './workload-c';
import { modelEvaluation, profilePhases } from './evaluation-setup';
import { dirs, files as CASE, harness, origin as ORIGIN_ALL, packet, rel } from './config';

/* eslint-disable @typescript-eslint/no-explicit-any */
const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const PROJECT = dirs.project;
const sha256 = (f: string) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
/**
 * a list read off a seed in a fixed order: the seed's instances and links follow its generation, and a regenerated
 * seed may list the same sites, accesses and home options in another order, which would change the Verify tab's
 * fingerprints
 */
const canon = <T,>(xs: T[], key: (x: T) => string = (x) => JSON.stringify(x)) => xs.sort((x, y) => key(x).localeCompare(key(y)));

/**
 * the committed realised seeds as model data: the case's mdeo/seeds/<seed>-realised.m through the harness's exporter
 * on the staged project (the mdeo worktree of core/tools/run-domain.sh, ARCH_WT), once per content (a .sha256 beside each converted file)
 */
const SEEDS = ['domain-neutral', 'domain-today', 'domain-monolith'] as const;
function fromModels(): Record<(typeof SEEDS)[number], string> {
  const cache = harness.cache;
  const out = Object.fromEntries(SEEDS.map((s) => [s, path.join(cache, `${s}-realised.model.json`)])) as Record<(typeof SEEDS)[number], string>;
  const todo = SEEDS.filter((s) => {
    const m = CASE.seeds[s];
    if (!fs.existsSync(m)) return false;
    const stamp = `${out[s]}.sha256`;
    return !(fs.existsSync(out[s]) && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === sha256(m));
  });
  if (todo.length) {
    fs.mkdirSync(cache, { recursive: true });
    // the staged MDEO project (the seeds' `using` lines are relative to its layout)
    const project = execFileSync('python3', harness.stage, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
    execFileSync('node', ['export.mjs', project, cache, ...harness.args,
      '--models', todo.map((s) => path.basename(CASE.seeds[s])).join(',')], { cwd: harness.dir, stdio: ['ignore', 'ignore', 'inherit'] });
    for (const s of todo) fs.writeFileSync(`${out[s]}.sha256`, sha256(CASE.seeds[s]));
  }
  return out;
}
const BUILD = opt('build');
const seeds = BUILD || opt('neutral') || opt('today') || opt('monolith') ? null : fromModels();
/** the file a seed is read from: the committed .m (converted), or a build's model data */
const seedData = (s: (typeof SEEDS)[number]) => {
  const given = opt(s.replace('domain-', ''));
  if (given) return path.resolve(given);
  return seeds ? seeds[s] : path.resolve(BUILD ?? '', 'realised', `${s}.model.json`);
};
const seedFile = (s: (typeof SEEDS)[number]) => (seeds ? CASE.seeds[s] : seedData(s));
const files = {
  a: CASE.extraction,
  w: CASE.workload,
  neutral: seedData('domain-neutral'),
  today: seedData('domain-today'),
  monolith: seedData('domain-monolith'),
};
const OUT = path.resolve(opt('out') ?? packet.out);
const DOMAIN_ID = opt('domain') ?? packet.domainId;
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));
const notes: string[] = [];
/**
 * (contract 1.12.0) the domain JSON's plan `via` in the explorer's words: its `local` (resolved in the
 * subgraph that resolves the parent; derive.py and cache_hits.py read it so, unchanged) is `service`, never a mechanism
 */
const planViaOf = (v: string) => (v === 'local' ? 'service' : v);
const round = (v: number, d = 6) => (Number.isFinite(v) ? Math.round(v * 10 ** d) / 10 ** d : v);

// ---------------------------------------------------------------- model index
interface Inst { name: string; className: string; properties: Record<string, any> }
class Model {
  inst = new Map<string, Inst>();
  out = new Map<string, [string, string][]>();
  byClass = new Map<string, Inst[]>();
  constructor(m: { instances: Inst[]; links: { sourceName: string; sourceProperty: string; targetName: string }[] }) {
    for (const i of m.instances) {
      this.inst.set(i.name, i);
      if (!this.byClass.has(i.className)) this.byClass.set(i.className, []);
      this.byClass.get(i.className)!.push(i);
    }
    for (const l of m.links) {
      if (!this.out.has(l.sourceName)) this.out.set(l.sourceName, []);
      this.out.get(l.sourceName)!.push([l.sourceProperty, l.targetName]);
    }
  }
  links(n: string, p: string): string[] { return (this.out.get(n) ?? []).filter(([q]) => q === p).map(([, t]) => t); }
  link(n: string, p: string): string | undefined { return this.links(n, p)[0]; }
  all(c: string): Inst[] { return this.byClass.get(c) ?? []; }
  prop(n: string, p: string): any { const v = this.inst.get(n)?.properties?.[p]; return v && typeof v === 'object' && 'enum' in v ? v.enum : v; }
}

const A = readJson(files.a);
const W = readJson(files.w);
const N = new Model(readJson(files.neutral));
const T = fs.existsSync(files.today) ? new Model(readJson(files.today)) : null;
const M = fs.existsSync(files.monolith) ? new Model(readJson(files.monolith)) : null;
if (!T) notes.push(`no today seed at ${rel(files.today)}: today's mechanisms missing`);
// today's realised model carries the load profile, C1's policy and the budgets
const evals = T ? [readJson(files.today)].map((m) => { const ev = modelEvaluation(m); return { id: ev.profile, file: files.today, ev }; }) : [];
const domain = loadMisarchDomain(A, W);

/** gen_domain.py's ident(): a model name from an operation or request id */
const ident = (s: string) => s.replace(/[^A-Za-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');

// ---------------------------------------------------------------- domain section (domain.mm instances)
const classOf = new Map<string, Id>(); // DomainClass instance -> class id
for (const c of N.all('DomainClass')) classOf.set(c.name, c.properties.name);
const opOf = new Map<string, Id>(); // Operation instance -> op id
for (const o of N.all('Operation')) opOf.set(o.name, o.properties.name);
// the operations of the model (a glue resolver is none)
const modelOps = new Set(opOf.values());
const aOps = new Map<Id, any>(A.operations.map((o: any) => [o.id, o]));
const aClasses = new Map<Id, any>(A.classes.map((c: any) => [c.name, c]));
const aRefs = new Map<Id, any>(A.references.map((r: any) => [r.id, r]));

const classes: ModelClass[] = N.all('DomainClass').map((c) => {
  const id = c.properties.name as string;
  const a = aClasses.get(id) ?? {};
  return {
    id, service: a.service ?? '?', table: a.table, storage: a.storage, attributes: a.attributes ?? [], rowBytes: c.properties.rowBytes ?? a.rowBytes,
    evidence: a.evidence, note: a.note, component: N.link(c.name, 'component'), schema: N.link(c.name, 'schema'),
    placement: Object.fromEntries(([['neutral', N], ['today', T], ['monolith', M]] as const).filter(([, m]) => m).map(([k, m]) => [k, {
      container: m!.link(`alloc_${N.link(c.name, 'component')}`, 'resourceContainer') ?? '?', server: m!.link(`alloc_${N.link(c.name, 'schema')}`, 'resourceContainer') ?? '?',
    }])),
  };
}).sort((x, y) => x.id.localeCompare(y.id));

const references: ModelReference[] = [];
for (const c of N.all('DomainClass')) {
  for (const r of N.links(c.name, 'references')) {
    const p = N.inst.get(r)!.properties;
    const a = aRefs.get(p.name) ?? {};
    references.push({
      // named by the source's field (Product.categories)
      id: p.name, from: c.properties.name, to: classOf.get(N.link(r, 'target')!)!, name: String(p.name).split('.').slice(1).join('.'),
      kind: String(N.prop(r, 'kind')).toLowerCase() as 'composition' | 'association', upper: p.upper, snapshot: !!p.snapshot,
      storage: a.storage, ...(p.table ? { table: true } : {}), ...(a.inverse ? { inverse: a.inverse } : {}),
      crossServiceToday: a.crossServiceToday, evidence: a.evidence,
    });
  }
}

// ---------------------------------------------------------------- SEFFs as timed parts
const sigName = (sig: string) => (N.prop(sig, 'entityName') as string) ?? sig;
const seffOwner = new Map<string, string>();
for (const comp of N.all('BasicComponent')) for (const s of N.links(comp.name, 'serviceEffectSpecifications')) seffOwner.set(s, comp.properties.entityName ?? comp.name);
const seffBySig = new Map<string, string>();
for (const s of N.all('ResourceDemandingSEFF')) { const sig = N.link(s.name, 'describedService'); if (sig && !seffBySig.has(sig)) seffBySig.set(sig, s.name); }
const baseCalls = new Set(N.all('RealisedCall').map((r) => N.link(r.name, 'action')!).filter(Boolean));
// (1.4.0) a joined call is re-pointed to the step's work in the realised seed: read it as written, into the step form
const joinedFrom = new Map(N.all('RealisedCall').filter((r) => N.prop(r.name, 'shape') === 'joined' && N.link(r.name, 'originalService'))
  .map((r) => [N.link(r.name, 'action')!, N.link(r.name, 'originalService')!]));
const siteOfAction = new Map<string, string>();
for (const s of N.all('CallSite')) { const a = N.link(s.name, 'call'); if (a) siteOfAction.set(a, s.name); }
const realisedMs = new Map<string, number>();
for (const d of N.all('RealisedDemand')) { const x = N.link(d.name, 'demand'); if (x) realisedMs.set(x, d.properties.ms); }
const classIds = new Set(classes.map((c) => c.id));
// (1.11.0) the receiving envelopes: per signature of a ReceivingEnvelope's services the envelope a synchronous call
// across containers pays in the callee's container (the realisation's `envelope` block after the call)
const recvOf = new Map<string, { id: string; ms: number; estimate: boolean }>();
for (const e of N.all('ReceivingEnvelope')) {
  for (const sg of N.links(e.name, 'services')) recvOf.set(sg, { id: e.name, ms: Number(e.properties.cpuMs ?? 0), estimate: !!e.properties.estimate });
}

// ---------------------------------------------------------------- timing source (cases/misarch/timing/README.md)
// the timing campaign's parts (schema version 3, with the measured `envelope`; core/generator/derive.py reads them)
const PARTS = (() => { try { return readJson(CASE.timing); } catch { return {}; } })();
if (Number(PARTS.version) !== 3 || !PARTS.envelope) notes.push(`${rel(CASE.timing)}: not parts schema version 3 with an \`envelope\` (the timing source below assumes it)`);
/** an operation's home class: the class component whose SEFF it is */
const homeOf = (o: string) => N.links(o, 'seffs').map((s) => seffOwner.get(s)).find((c) => c && classIds.has(c)) ?? classes[0].id;
/**
 * mapping CPU of the home class's own accesses per execution: folded into the operation's `work` action; per SEFF, by
 * the class whose SEFF it is (an alternative home's SEFF folds that class's mapping, not today's home's)
 */
const homeMapMs = new Map<string, number>();
for (const o of N.all('Operation')) {
  const accs = N.links(o.name, 'accesses');
  for (const s of N.links(o.name, 'seffs')) {
    const home = seffOwner.get(s);
    if (!home || !classIds.has(home)) continue;
    const ms = accs.filter((x) => classOf.get(N.link(x, 'target')!) === home).reduce((t, x) => t + Number(N.inst.get(x)!.properties.cpuMs ?? 0), 0);
    if (ms > 0) homeMapMs.set(s, ms);
  }
}

/** mean of a demand's StoEx: Exp(rate) → 1/rate, a literal, a constant expression */
function demandMs(spec: string): number {
  const s = spec.trim();
  const e = /^Exp\((.*)\)$/.exec(s);
  const evalConst = (x: string) => (/^[\d\s.+\-*/()eE]+$/.test(x) ? Number(Function(`"use strict";return (${x})`)()) : NaN);
  if (e) return 1 / evalConst(e[1]);
  const v = stoexMean(s);
  return v || evalConst(s);
}

function orderedSteps(beh: string): string[] {
  const steps = N.links(beh, 'steps');
  const next = new Map<string, string>();
  let start: string | undefined;
  for (const a of steps) {
    const p = N.link(a, 'predecessor');
    if (p) next.set(p, a);
    if (N.inst.get(a)?.className === 'StartAction') start = a;
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (let a = start; a && !seen.has(a); a = next.get(a)) { seen.add(a); out.push(a); }
  // actions off the chain (none expected): keep them, in link order
  for (const a of steps) if (!seen.has(a)) out.push(a);
  return out;
}

// (1.4.0) the effect steps' step forms and commits (docs/model.md, Call sites): CallSite.stepService's SEFFs, their
// `commit` calls' SEFFs; also a home option's step form: the signature of the same name on the option's interface
const stepSigs = new Set(N.all('CallSite').map((c) => N.link(c.name, 'stepService')).filter((x): x is string => !!x));
const stepNames = new Set([...stepSigs].map((g) => N.prop(g, 'entityName')).filter(Boolean));
const stepSeffs = new Set(N.all('ResourceDemandingSEFF').filter((s) => {
  const sig = N.link(s.name, 'describedService');
  return !!sig && (stepSigs.has(sig) || stepNames.has(N.prop(sig, 'entityName')));
}).map((s) => s.name));

function callKind(entity: string, toComponent: string | undefined): SeffPart['kind'] {
  if (entity === 'root') return 'root';
  if (entity === 'work' || entity === 'commit') return entity;
  if (entity === 'db') return 'db';
  if (/^(read|write)/.test(entity)) return toComponent?.endsWith('Db') && !classIds.has(toComponent) ? 'db' : 'access';
  for (const k of ['event', 'callback', 'call', 'field'] as const) if (entity.startsWith(k)) return k;
  return 'other';
}

/** calls joined in the neutral seed: a request's work follows them into the step's work only (no envelope, no commit) */
const joinedParts = new WeakSet<SeffPart>();
function walk(beh: string, p: number, async: boolean, parts: SeffPart[], depth = 0) {
  if (depth > 12) return;
  for (const a of orderedSteps(beh)) {
    const i = N.inst.get(a);
    if (!i) continue;
    const ent = (i.properties.entityName as string) ?? a;
    switch (i.className) {
      case 'InternalAction':
        for (const d of N.links(a, 'resourceDemand')) {
          const resource = String(N.prop(d, 'requiredResource') ?? 'CPU');
          // a DELAY resource has processing rate 1: its demand is in seconds (the latency-only waits)
          const ms = realisedMs.get(d) ?? demandMs(String(N.prop(d, 'specification') ?? '0')) * (resource === 'DELAY' ? 1000 : 1);
          if (ms > 0) parts.push({ t: 'work', name: ent, ms: round(ms), resource, p: round(p), ...(async ? { async } : {}) });
        }
        break;
      case 'ExternalCallAction': {
        if (!baseCalls.has(a)) break; // a middleware block of the realisation
        const sig = joinedFrom.get(a) ?? N.link(a, 'calledService');
        const to = sig ? seffBySig.get(sig) : undefined;
        const part: SeffPart = { t: 'call', name: ent, kind: callKind(ent, to && seffOwner.get(to)), to, p: round(p) };
        if (async) part.async = true;
        const recv = sig ? recvOf.get(sig) : undefined;
        if (recv) { part.envelopeMs = round(recv.ms); if (recv.estimate) part.estimate = true; }
        const site = siteOfAction.get(a);
        if (site) part.site = site;
        if (joinedFrom.has(a)) joinedParts.add(part);
        parts.push(part);
        break;
      }
      case 'BranchAction':
        for (const t of N.links(a, 'branches')) {
          const pr = Number(N.prop(t, 'branchProbability') ?? 1);
          const body = N.link(t, 'branchBehaviour');
          if (body && pr > 0) walk(body, p * pr, async, parts, depth + 1);
        }
        break;
      case 'LoopAction': {
        const body = N.link(a, 'bodyBehaviour');
        const n = stoexMean(N.prop(a, 'iterationCount') ?? 1);
        if (body) walk(body, p * n, async, parts, depth + 1);
        break;
      }
      case 'ForkAction':
        for (const f of N.links(a, 'asynchronousForkedBehaviours')) walk(f, p, true, parts, depth + 1);
        for (const sp of N.links(a, 'synchronisingBehaviours')) for (const f of N.links(sp, 'synchronousForkedBehaviours')) walk(f, p, async, parts, depth + 1);
        break;
      default:
        break;
    }
  }
}

// requests of the usage model (gen_domain.py Domain.__init__: A's plan when it is the request's, else C's operations)
const aPlans = new Map<string, any[]>(A.requests.map((r: any) => [r.type, r.plan]));
const reqKeys = Object.keys(W.requests).filter((k) => k !== 'login');
const reqByIdent = new Map(reqKeys.map((k) => [ident(k), k]));

const seffOp = new Map<string, Id>();
const seffReq = new Map<string, Id>();
const seffFieldReq = new Map<string, Id>();
for (const o of N.all('Operation')) for (const s of N.links(o.name, 'seffs')) {
  seffOp.set(s, o.properties.name);
  const sig = sigName(N.link(s, 'describedService') ?? '');
  if (sig.startsWith('req_')) { const r = reqByIdent.get(sig.slice(4)); if (r) seffReq.set(s, r); }
  // (1.8.0) a field with fields of its own has a SEFF per request (`<field>_req_<request>`)
  else { const m = /_req_(\w+)$/.exec(sig); const r = m ? reqByIdent.get(m[1]) : undefined; if (r) seffFieldReq.set(s, r); }
}

// (1.4.0) the SEFFs of the home options: Home {operation}, HomeOption {cls} with `seffs` (the work, a
// reaction's step form, a request's root SEFF); `written` = today's
const homeRefOf = new Map<string, HomeRef>();
for (const h of N.all('Home')) {
  const w = N.link(h.name, 'written');
  for (const o of N.links(h.name, 'options')) {
    for (const sf of N.links(o, 'seffs')) homeRefOf.set(sf, { op: String(h.properties.operation ?? ''), class: String(N.inst.get(o)?.properties.cls ?? '?'), written: o === w });
  }
}
const seffs = new Map<string, ModelSeff>();
function seffOf(id: string): ModelSeff {
  let s = seffs.get(id);
  if (s) return s;
  const component = seffOwner.get(id) ?? '?';
  const signature = sigName(N.link(id, 'describedService') ?? '');
  const kind: ModelSeff['kind'] = stepSeffs.has(id) ? 'step' : component === 'Gateway' ? 'gateway' : seffReq.has(id) ? 'request' : seffOp.has(id) ? 'operation'
    : component.endsWith('Db') && classIds.has(component.slice(0, -2)) ? 'db' : classIds.has(component) ? 'access' : 'other';
  s = { id, component, signature, kind, parts: [] };
  if (seffOp.has(id)) s.op = seffOp.get(id);
  if (seffReq.has(id)) s.request = seffReq.get(id);
  if (seffFieldReq.has(id)) s.request = seffFieldReq.get(id);
  if (component === 'Gateway') s.request = reqByIdent.get(signature);
  if (kind === 'db') s.class = component.slice(0, -2);
  if (kind === 'access' || kind === 'step') s.class = component;
  seffs.set(id, s);
  walk(id, 1, false, s.parts);
  // the home class's mapping CPU as a part of its own: the model folds it into `work`, the trace's Access.cpuMs give it
  const map = homeMapMs.get(id);
  const w = map ? s.parts.findIndex((pt) => pt.t === 'work' && pt.name === 'work' && pt.resource === 'CPU') : -1;
  if (map && w >= 0) {
    const own = s.parts[w].ms! - map;
    if (own >= -1e-6) s.parts.splice(w, 1, { ...s.parts[w], ms: round(Math.max(0, own)) }, { ...s.parts[w], name: 'map', ms: round(map), split: true });
    else notes.push(`SEFF ${id}: its work ${s.parts[w].ms} ms is less than the home accesses' mapping CPU ${round(map)} ms; not split`);
  }
  const hr = homeRefOf.get(id);
  if (hr) s.home = hr;
  for (const pt of s.parts) if (pt.to) seffOf(pt.to);
  // an access part's SEFF belongs to the operation that makes it
  for (const pt of s.parts) if (pt.to && pt.kind === 'access') { const t = seffs.get(pt.to)!; t.op ??= s.op; }
  return s;
}
for (const s of N.all('ResourceDemandingSEFF')) if (seffOwner.get(s.name) === 'Gateway' || seffOp.has(s.name)) seffOf(s.name);
// (1.11.0) the receiving envelopes' SEFFs (kind envelope): reached only through the realisation's envelope blocks
const envelopes: ModelEnvelope[] = [];
for (const e of N.all('ReceivingEnvelope')) {
  const sig = N.link(e.name, 'envelope');
  const seff = sig ? seffBySig.get(sig) : undefined;
  if (seff) { const x = seffOf(seff); x.kind = 'envelope'; x.class = x.component; }
  else notes.push(`receiving envelope ${e.name}: its envelope ${sig} has no SEFF`);
  const component = seff ? seffOwner.get(seff) ?? '?' : '?';
  const service = classes.find((c) => c.id === component)?.service;
  envelopes.push({
    id: e.name, component, ...(service ? { service } : {}), ms: round(Number(e.properties.cpuMs ?? 0)), estimate: !!e.properties.estimate,
    ...(seff ? { seff } : {}), services: N.links(e.name, 'services').map(sigName),
  });
}
canon(envelopes, (x) => x.id);
// (1.4.0) a step form's commit; a step's operation: a reaction's own, a write's the writer's (its work then too)
for (let round_ = 0; round_ < 3; round_++) {
  for (const s of seffs.values()) {
    if (s.kind !== 'step') continue;
    for (const pt of s.parts) {
      const t = pt.to ? seffs.get(pt.to) : undefined;
      if (!t) continue;
      if (pt.kind === 'commit') { t.kind = 'commit'; t.op ??= s.op; }
      if (pt.kind === 'work') { if (t.kind === 'operation') s.op = t.op; else t.op ??= s.op; }
    }
  }
  for (const s of seffs.values()) for (const pt of s.parts) if (pt.to && pt.kind === 'access') { const t = seffs.get(pt.to)!; t.op ??= s.op; }
}

// ---------------------------------------------------------------- call sites
const MECH = (m: Model | null, site: string) => (m ? m.link(site, 'mechanism') : undefined);
const sites: ModelSite[] = [];
const stepOf = new Map<string, NonNullable<NonNullable<ModelSite['effect']>['step']>>();
const partOfSite = new Map<string, { seff: ModelSeff; part: SeffPart }>();
for (const s of seffs.values()) for (const pt of s.parts) if (pt.site) partOfSite.set(pt.site, { seff: s, part: pt });
/** a schema assembly's class: `Assembly_<Class>Db` */
const schemaClass = (asm: string | undefined) => asm?.replace(/^Assembly_/, '').replace(/Db$/, '');
/** (1.4.0) whether a site's call joins the caller's transaction in a realised seed, else why not (plan-placement.mt `pj`) */
function joinState(m: Model, site: string, external: boolean): true | JoinBlocker {
  const rc = m.all('RealisedCall').find((r) => m.link(r.name, 'site') === site && m.link(r.name, 'action') === m.link(site, 'call'));
  if (rc && m.prop(rc.name, 'shape') === 'joined') return true;
  if (external) return 'external';
  if (m.inst.get(m.link(site, 'mechanism') ?? '')?.className !== 'InTransaction') return 'chosen';
  const at = (asm: string | undefined) => (asm ? m.link(`alloc_${asm}`, 'resourceContainer') : undefined);
  if (rc && at(m.link(rc.name, 'logicalCaller')) !== at(m.link(rc.name, 'logicalProvider'))) return 'apart';
  if (at(m.link(site, 'callerSchema')) !== at(m.link(site, 'providerSchema'))) return 'servers';
  return 'orchestrated';
}
for (const cs of N.all('CallSite')) {
  const at = partOfSite.get(cs.name);
  const reached = at?.part.to ? seffs.get(at.part.to) : undefined;
  // (1.4.0) an effect step's call reaches its step form: the site's target is the step's work
  const workPart = reached?.kind === 'step' ? reached.parts.find((pt) => pt.kind === 'work') : undefined;
  const target = workPart?.to ? seffs.get(workPart.to) : reached;
  const kind = at?.part.kind ?? 'other';
  const site: ModelSite = {
    id: cs.name, op: at?.seff.op, request: at?.seff.request, kind,
    allowed: N.links(cs.name, 'allowed'), neutral: MECH(N, cs.name), today: MECH(T, cs.name), monolith: MECH(M, cs.name),
  };
  if (cs.properties.writes) site.writes = true;
  if (at?.seff.home) site.home = at.seff.home;
  if (reached?.kind === 'step' && target) {
    const env = reached.parts.find((pt) => pt.t === 'work' && pt.name === 'envelope');
    const commitPart = reached.parts.find((pt) => pt.kind === 'commit');
    const commit = commitPart?.to ? seffs.get(commitPart.to) : undefined;
    const callerSchema = N.link(cs.name, 'callerSchema'), providerSchema = N.link(cs.name, 'providerSchema');
    stepOf.set(cs.name, {
      seff: reached.id, work: target.id, ...(commit ? { commit: commit.id } : {}), envelopeMs: round(env?.ms ?? 0),
      ...(commit ? { commitMs: round(commit.parts.filter((pt) => pt.t === 'work').reduce((x, pt) => x + (pt.ms ?? 0) * (pt.p ?? 1), 0)) } : {}),
      estimate: !!env?.estimate, ...(callerSchema ? { callerSchema: schemaClass(callerSchema) } : {}), ...(providerSchema ? { providerSchema: schemaClass(providerSchema) } : {}),
      ...(classIds.has(at!.seff.component) ? { callerClass: at!.seff.component } : {}), providerClass: reached.component,
    });
  }
  // (1.1.0) the site's own cache values and the provider's cache as built
  if (typeof cs.properties.hitRatio === 'number') site.hitRatio = round(cs.properties.hitRatio);
  if (typeof cs.properties.staleShare === 'number') site.staleShare = round(cs.properties.staleShare);
  const cached = N.link(cs.name, 'cachedService');
  if (cached) {
    const seff = seffBySig.get(cached);
    site.cachedService = sigName(cached);
    if (seff) { const c = seffOf(seff); c.kind = 'cache'; c.class = c.component; site.cachedSeff = seff; }
    else notes.push(`call site ${cs.name}: its cachedService ${cached} has no SEFF`);
  }
  // (1.7.0) the federation fetch: the glue resolver's work, then the field
  const fetch = N.link(cs.name, 'fetchService');
  if (fetch) {
    const seff = seffBySig.get(fetch);
    site.fetchService = sigName(fetch);
    if (seff) { const c = seffOf(seff); c.kind = 'fetch'; c.class = c.component; site.fetchSeff = seff; }
    else notes.push(`call site ${cs.name}: its fetchService ${fetch} has no SEFF`);
  }
  if (kind === 'access') { site.class = target?.class; site.mode = /^write/.test(at!.part.name) ? 'write' : 'read'; }
  else if (target?.op) site.callee = target.op;
  if (!at) notes.push(`call site ${cs.name}: its call is not in a SEFF of an operation or request`);
  sites.push(site);
}
canon(sites, (s) => s.id);

// ---------------------------------------------------------------- operations
const rates = new Map<Id, number>(domain.requests.map((r) => [r.id, r.rate ?? 0]));
const reach = new Map<Id, Map<Id, number>>(); // op -> request -> visits
const requests: ModelRequest[] = [];
for (const k of reqKeys) {
  const gw = [...seffs.values()].find((s) => s.kind === 'gateway' && s.request === k);
  if (!gw) { notes.push(`request ${k}: no gateway SEFF in the model`); continue; }
  const work = { gateway: 0, app: 0, db: 0, map: 0, wait: 0 };
  const visit = (id: string, m: number, depth: number) => {
    const s = seffs.get(id);
    if (!s || depth > 30) return;
    if (s.op) {
      if (!reach.has(s.op)) reach.set(s.op, new Map());
      const r = reach.get(s.op)!;
      if (s.kind === 'operation' || s.kind === 'request') r.set(k, (r.get(k) ?? 0) + m);
    }
    for (const pt of s.parts) {
      if (pt.t === 'work') {
        const v = m * (pt.p ?? 1) * (pt.ms ?? 0);
        if (pt.resource === 'DELAY') work.wait += v;
        else if (s.kind === 'gateway') work.gateway += v; else if (s.kind === 'db') work.db += v; else work.app += v;
        if (pt.name === 'map' && s.kind !== 'db') work.map += v;
      } else if (pt.to) {
        const to = joinedParts.has(pt) ? seffs.get(pt.to)?.parts.find((x) => x.kind === 'work')?.to ?? pt.to : pt.to;
        visit(to, m * (pt.p ?? 1), depth + 1);
      }
    }
  };
  visit(gw.id, 1, 0);
  const wr = W.requests[k];
  const written = (aPlans.has(wr.roundTwoRequest) && JSON.stringify(aPlans.get(wr.roundTwoRequest)!.map((x: any) => x.op)) === JSON.stringify(wr.operations))
    ? aPlans.get(wr.roundTwoRequest)!.map((x: any) => ({ op: x.op, via: planViaOf(x.via) }))
    : (wr.operations as string[]).map((op, i) => ({ op, via: i === 0 ? 'root' : 'service' }));
  // (1.7.0) the plan as the model has it: a subgraph's glue resolver is no operation (its work is the fetch of the
  // field after it), and a field is a gateway fetch when its site joins today
  const kept = written.filter((x) => modelOps.has(x.op));
  // (1.8.0) a tree: the parent is the entry whose SEFF holds the field's call (the root's request SEFF, or a
  // field's SEFF for this request)
  const plan = kept.map((x, i) => {
    if (x.via === 'root') return x;
    const s = sites.find((y) => y.kind === 'field' && y.request === k && y.callee === x.op);
    const p = s?.op ? kept.findIndex((y, j) => j < i && y.op === s.op) : -1;
    return { ...x, ...(s && (s.today === 'join' || s.today === 'joinCache') ? { via: 'gateway' } : {}), parent: p >= 0 ? p : 0 };
  });
  requests.push({
    id: k, msa: wr.msa, document: domain.requests.find((r) => r.id === k)?.document, plan, rate: round(rates.get(k) ?? 0, 4),
    budgets: evals.flatMap(({ id, ev }) => {
      const b = ev.budgets.get(ident(k));
      return b ? [{ profile: id, statistic: ev.latency.statistic, referenceMs: b.referenceMs !== undefined ? round(b.referenceMs, 4) : undefined, referenceCount: b.referenceCount, budgetMs: b.budgetMs !== undefined ? round(b.budgetMs, 4) : undefined }] : [];
    }),
    seff: gw.id,
    work: { gateway: round(work.gateway, 4), app: round(work.app, 4), db: round(work.db, 4), ...(work.map ? { map: round(work.map, 4) } : {}), ...(work.wait ? { wait: round(work.wait, 4) } : {}) },
  });
}

const reactsTo = new Map<Id, Id>();
const events: ModelEvent[] = N.all('DomainEvent').map((e) => {
  const reactions = N.links(e.name, 'reactions').map((o) => opOf.get(o)!).filter(Boolean);
  for (const r of reactions) reactsTo.set(r, e.properties.name);
  return { id: e.properties.name, name: e.properties.name, payload: N.links(e.name, 'payload').map((c) => classOf.get(c)!), publishers: [], reactions };
});
const eventById = new Map(events.map((e) => [e.id, e]));
const bindings: ModelBinding[] = N.all('Binding').map((b) => ({
  id: b.name.replace(/^binding_/, ''), kind: N.prop(b.name, 'kind'), classes: N.links(b.name, 'classes').map((c) => classOf.get(c)!), operations: N.links(b.name, 'operations').map((o) => opOf.get(o)!),
}));
const featureOf = new Map<Id, Id>();
for (const f of N.all('Feature')) for (const o of N.links(f.name, 'operations')) featureOf.set(opOf.get(o)!, f.properties.code);
const procRole = new Map<Id, { id: Id; role: 'trigger' | 'step' | 'compensation' }>();
const processes: ModelProcess[] = N.all('Process').map((p) => {
  const id = p.properties.name as string;
  const trigger = opOf.get(N.link(p.name, 'trigger')!)!;
  const steps = N.links(p.name, 'steps').map((o) => opOf.get(o)!);
  const compensations = N.links(p.name, 'compensations').map((o) => opOf.get(o)!);
  for (const s of steps) procRole.set(s, { id, role: 'step' });
  for (const s of compensations) procRole.set(s, { id, role: 'compensation' });
  procRole.set(trigger, { id, role: 'trigger' });
  const wf = `saga_${id}`;
  return { id, trigger, steps, compensations, styles: N.links(wf, 'allowed'), today: T?.link(wf, 'style'), neutral: N.link(wf, 'style'), workflow: wf };
});
// (1.3.0) the transaction workflows (docs/model.md, Workflows): triggered by a SEFF, its transaction-bound writes as steps
{
  const siteById = new Map(sites.map((s) => [s.id, s]));
  for (const w of N.all('Workflow')) {
    if (w.properties.transactional !== true) continue;
    const seff = N.link(w.name, 'trigger')!;
    const trigger = seffOp.get(seff);
    const steps = N.links(w.name, 'steps').map((a) => siteOfAction.get(a)).filter((s): s is string => !!s);
    if (!trigger) { notes.push(`transaction workflow ${w.name}: its trigger ${seff} is no SEFF of an operation`); continue; }
    if (steps.length < N.links(w.name, 'steps').length) notes.push(`transaction workflow ${w.name}: a step without a call site`);
    processes.push({
      id: w.name, trigger, steps: [], compensations: [], styles: N.links(w.name, 'allowed'), today: T?.link(w.name, 'style'), neutral: N.link(w.name, 'style'), workflow: w.name,
      transaction: { seff, ...(seffReq.has(seff) ? { request: seffReq.get(seff) } : {}), ...(homeRefOf.has(seff) ? { home: homeRefOf.get(seff) } : {}), sites: steps, writes: [...new Set(steps.map((s) => siteById.get(s)?.class).filter((c): c is Id => !!c))] },
    });
  }
}

const kindOf = (a: any): ModelOperationKind => {
  const t = a?.trigger ?? {};
  if (t.graphql?.startsWith('Query.')) return 'query';
  if (t.graphql?.startsWith('Mutation.')) return 'mutation';
  if (t.graphql) return 'resolver';
  if (t.topic) return 'reaction';
  if (t.http) return 'callback';
  return 'job';
};

/** (1.13.0) domain.mm's ConsistencyLevel as the contract's */
const levelOfModel = (v: unknown): ConsistencyLevel | undefined => (v === 'STRICT' ? 'strict' : v === 'STALE_OK' ? 'stale-ok' : v === 'IMMUTABLE' ? 'immutable' : undefined);
/**
 * the curated rules and reasons (package A's `consistency`, curated/consistency.yaml) of the statements at a read's or
 * call's level, in their order; none for a level no curated statement has (a read that is not strong: stale-ok)
 */
function curated(level: ConsistencyLevel, cs: ({ level: string; rules: string[]; reason: string } | undefined)[]): { rules?: string[]; reason?: string } {
  const at = cs.filter((c): c is NonNullable<typeof c> => !!c && c.level === level);
  if (!at.length) return {};
  return { rules: [...new Set(at.flatMap((c) => c.rules))], reason: [...new Set(at.map((c) => c.reason))].join('\n') };
}

/**
 * the invocation of another operation whose query resolves `callee` on the objects of `parent` (its `to` lists
 * both, `parents` links them): the model calls the field from the parent's SEFF for that call
 */
function nestedIn(parent: Id, callee: Id): { from: Id; call: any } | undefined {
  for (const x of A.operations) for (const c of x.calls ?? []) {
    const to = [c.to].flat(), i = to.indexOf(callee);
    if (i > 0 && c.parents?.[i] != null && to[c.parents[i]] === parent) return { from: x.id, call: c };
  }
  return undefined;
}

const traceMismatch: string[] = [];
// the operations of the simulated system (with SEFFs); the model's other domain operations (no SEFF)
// only carry accesses for C3's affinity graph
const operations: ModelOperation[] = N.all('Operation').filter((o) => N.links(o.name, 'seffs').length > 0).map((o) => {
  const id = o.properties.name as string;
  const a = aOps.get(id) ?? {};
  const home = homeOf(o.name);
  const mapCpuMs = homeMapMs.get(N.links(o.name, 'seffs').find((x) => seffOwner.get(x) === home) ?? '');
  const accesses: ModelAccess[] = N.links(o.name, 'accesses').map((x) => {
    const p = N.inst.get(x)!.properties;
    const cls = classOf.get(N.link(x, 'target')!)!;
    const mode = String(N.prop(x, 'mode')).toLowerCase() as 'read' | 'write';
    const via = N.link(x, 'via');
    const ref = via ? N.inst.get(via)?.properties.name : undefined;
    // the statements of the model Access: same class, mode and reference; an access of the operation's
    // own data in a copy table (`own`) is one of its home class's rows, today local (its own service's store)
    const mine = (y: any) => y.mode === mode && (y.own ? cls === home && ref === undefined : y.class === cls && (y.reference ?? undefined) === ref);
    const today = [...new Set((a.accesses ?? []).filter(mine).map((y: any) => (y.own ? 'local' : y.today) as string))] as string[];
    // the derivation trace's Access.sites should be the sites of this class's calls
    for (const s of N.links(x, 'sites')) {
      const site = sites.find((y) => y.id === s);
      if (site && site.class && site.class !== cls) traceMismatch.push(`${x} → ${s}`);
    }
    // (1.13.0) a read's level is the model's (the strictest of its statements; it decides the site's mechanisms); the curated rules
    // and reasons are those of its statements at that level (the statements of the model Access: same class, mode and
    // reference, not through a call nor from a payload, as derive's access groups)
    const level = mode === 'read' ? levelOfModel(N.prop(x, 'level')) : undefined;
    const stmts = (a.accesses ?? []).filter((y: any) => mine(y) && y.today !== 'call' && y.today !== 'payload');
    return {
      class: cls, mode, shape: N.prop(x, 'shape'), count: p.count, rows: p.rows, ...(level ? { level, ...curated(level, stmts.map((y: any) => y.consistency)) } : {}),
      ...(mode === 'read' && stmts.some((y: any) => y.op === 'lock') ? { lock: true } : {}), cpuMs: round(p.cpuMs ?? 0), dbMs: round(p.dbMs),
      local: cls === home, ...(today.length ? { today } : {}), ...(ref ? { via: ref } : {}),
    };
  });
  canon(accesses);
  const calls: ModelCall[] = canon(N.links(o.name, 'calls').map((c) => {
    const callee = opOf.get(N.link(c, 'callee')!)!;
    const level = levelOfModel(N.prop(c, 'level'));
    // the code's call: the callee is its first field (an invocation into nested fields calls the first); else a
    // field resolved on this operation's objects in another operation's invocation, whose level it has
    const ac = (a.calls ?? []).filter((y: any) => [y.to].flat()[0] === callee);
    const nest = ac.length ? undefined : nestedIn(id, callee);
    return { callee, count: N.prop(c, 'count'), ...(level ? { level, ...curated(level, (nest ? [nest.call] : ac).map((y: any) => y.consistency)) } : {}), ...(nest ? { nestedIn: nest.from } : {}) };
  }));
  // (1.13.0) effect calls: registrations with an external provider, sync only (E1)
  const effectCalls = (a.calls ?? []).filter((y: any) => y.effect).map((y: any) => ({ to: String([y.to].flat()[0]), rules: ['E1'], ...(y.purpose ? { reason: `${y.purpose}${y.when ? ` (when ${y.when})` : ''}` } : {}) }));
  const raises = canon(N.links(o.name, 'raises').map((r) => ({ event: N.prop(N.link(r, 'event')!, 'name') as string, probability: N.prop(r, 'probability') as number })));
  for (const r of raises) eventById.get(r.event)?.publishers.push(id);
  const rch = [...(reach.get(id) ?? new Map()).entries()].map(([request, visits]) => ({ request, visits: round(visits, 6) })).sort((x, y) => (rates.get(y.request) ?? 0) * y.visits - (rates.get(x.request) ?? 0) * x.visits);
  const t = a.trigger ?? {};
  return {
    id, name: id.slice(id.indexOf('.') + 1), service: a.service ?? '?', kind: kindOf(a), modelKind: N.prop(o.name, 'kind'),
    trigger: t.graphql ?? t.topic ?? t.http ?? t.schedule, entry: a.entry, feature: featureOf.get(id), homeClass: home,
    cpuMs: round(o.properties.cpuMs), ...(o.properties.envelopeMs ? { envelopeMs: round(o.properties.envelopeMs) } : {}), ...(mapCpuMs ? { mapCpuMs: round(mapCpuMs) } : {}), accesses, calls, ...(effectCalls.length ? { effectCalls } : {}), raises, reactsTo: reactsTo.get(id),
    bindings: bindings.filter((b) => b.operations.includes(id)).map((b) => b.id), process: procRole.get(id),
    seffs: N.links(o.name, 'seffs'), reach: rch, rate: round(rch.reduce((s, r) => s + (rates.get(r.request) ?? 0) * r.visits, 0), 5),
    note: a.note ? String(a.note) : undefined,
  };
}).sort((x, y) => x.id.localeCompare(y.id));

if (traceMismatch.length) {
  notes.push(`domain.mm trace: ${traceMismatch.length} Access.sites links name a call site of another class (e.g. ${traceMismatch[0]}): a model whose trace links every call of the access's mode; regenerate it (export-run.ts and core/mdeo/transform/metrics.fn take Access.sites as they are). This export takes each site from its call instead.`);
}

// ---------------------------------------------------------------- call sites: their raise, plan entry and copy feed (0.4.0)
{
  const opById = new Map(operations.map((o) => [o.id, o]));
  const reqById = new Map(requests.map((r) => [r.id, r]));
  // the SEFF an action sits in (writers sit directly in a SEFF: architecture.mm CopyFeed)
  const stepParent = new Map<string, string>();
  for (const [src, ls] of N.out) for (const [p, t] of ls) if (p === 'steps') stepParent.set(t, src);
  const seffOfAction = (a: string) => { let x: string | undefined = a; for (let i = 0; x && i < 20 && !seffs.has(x); i++) x = stepParent.get(x); return x && seffs.has(x) ? seffs.get(x) : undefined; };
  const feeds = new Map<string, { op: Id; request?: Id }[]>();
  for (const f of N.all('CopyFeed')) {
    const site = N.link(f.name, 'site');
    if (!site) continue;
    const ws: { op: Id; request?: Id }[] = [];
    for (const a of N.links(f.name, 'writers')) {
      const sf = seffOfAction(a);
      if (!sf?.op) { notes.push(`copy feed ${f.name}: writer ${a} is not in a SEFF of an operation`); continue; }
      if (!ws.some((w) => w.op === sf.op && w.request === sf.request)) ws.push(sf.request ? { op: sf.op, request: sf.request } : { op: sf.op });
    }
    feeds.set(site, [...(feeds.get(site) ?? []), ...ws]);
  }
  for (const s of sites) {
    if (s.kind === 'event' && s.callee) {
      const ev = opById.get(s.callee)?.reactsTo;
      if (ev && opById.get(s.op ?? '')?.raises.some((r) => r.event === ev)) s.event = ev;
      else notes.push(`event site ${s.id}: no raise of ${s.op} matches the reaction ${s.callee}`);
    }
    if (s.kind === 'field' && s.request && s.callee) {
      const e = reqById.get(s.request)?.plan.find((x) => x.op === s.callee && x.via !== 'root');
      if (e) s.planVia = e.via; else notes.push(`field site ${s.id}: ${s.callee} is not in the plan of ${s.request}`);
    }
    if (s.allowed.includes('copy')) s.copyFeed = { writers: feeds.get(s.id) ?? [] };
  }
}

// ---------------------------------------------------------------- call sites: family, effect attributes, copy topics (1.2.0)
// a fetch gets data of another class (the caller needs the answer), an effect runs a step of the work in
// another class (it does not). Derived from package A and the model; the generator records none of it.
const topics: ModelTopic[] = (A.events ?? []).map((e: any) => ({
  id: e.topic, role: e.role,
  publishers: [...new Set<Id>((e.publishers ?? []).map((p: any) => p.op))],
  payload: [...new Set<Id>((e.publishers ?? []).flatMap((p: any) => p.payload ?? []))],
  subscribers: (e.subscribers ?? []).map((x: any) => ({ op: x.op, service: x.service, copy: !!x.copy })),
}));
{
  const roleOf = new Map(topics.map((t) => [t.id, t.role]));
  const opById = new Map(operations.map((o) => [o.id, o]));
  // the classes an operation writes in one transaction (gen_domain.py Domain.tx_classes)
  const txClasses = (op: Id) => new Set<Id>((A.transactions ?? []).filter((t: any) => t.op === op && t.multiClass)
    .flatMap((t: any) => (t.domainClassesWritten?.length ? t.domainClassesWritten : t.classes)));
  for (const s of sites) {
    const write = s.kind === 'access' && s.mode === 'write';
    if (write || s.kind === 'event' || s.kind === 'callback') {
      s.family = 'effect';
      const home = s.op ? opById.get(s.op)?.homeClass : undefined;
      const tx = s.op ? txClasses(s.op) : new Set<Id>();
      const callee = s.callee ? opById.get(s.callee) : undefined;
      s.effect = {
        bound: write && !!home && !!s.class && tx.has(home) && tx.has(s.class),
        p: round(partOfSite.get(s.id)?.part.p ?? 1, 6),
        ...(callee ? { cascades: { sites: sites.filter((x) => x.op === callee.id).length, raises: callee.raises.map((r) => r.event) } } : {}),
        external: s.kind === 'callback',
        ...(stepOf.has(s.id) ? { step: stepOf.get(s.id) } : {}),
      };
      // (1.4.0) joined in the seeds, else why not
      const joined: NonNullable<typeof s.effect.joined> = {};
      for (const [k, m] of [['today', T], ['neutral', N], ['monolith', M]] as const) if (m) joined[k] = joinState(m, s.id, s.kind === 'callback');
      s.effect.joined = joined;
      // (1.13.0) a call of another operation that is not sync only (stale-ok: sync or a cache) fetches an answer too
    } else if (s.kind === 'field' || s.kind === 'call' || (s.kind === 'access' && s.mode === 'read')) s.family = 'fetch';
    if (s.allowed.includes('copy') && s.class) {
      const svc = s.op ? aOps.get(s.op)?.service : undefined;
      const fed = (A.copies ?? []).filter((c: any) => c.service === svc && c.copyOf && s.class! in c.copyOf).flatMap((c: any) => c.fedBy ?? []) as Id[];
      const carry = topics.filter((t) => t.payload.includes(s.class!)).map((t) => t.id);
      s.copyTopics = fed.length
        ? [...new Set(fed)].map((t) => ({ topic: t, role: roleOf.get(t) ?? 'unsubscribed', today: true }))
        : carry.map((t) => ({ topic: t, role: roleOf.get(t)!, today: false }));
    }
  }
}

// ---------------------------------------------------------------- (1.4.0) homes as a decision (docs/model.md, Homes)
const homes: NonNullable<InputModel['homes']> = N.all('Home').map((h) => {
  const opt = (m: Model | null) => { const o = m?.link(h.name, 'home'); return o ? String(m!.inst.get(o)?.properties.cls ?? '') || undefined : undefined; };
  const options = canon(N.links(h.name, 'options').map((o) => { const sf = N.links(o, 'seffs'); return { class: String(N.inst.get(o)?.properties.cls ?? '?'), ...(sf.length ? { seff: sf[0], seffs: sf } : {}) }; }), (o) => o.class);
  const w = N.link(h.name, 'written');
  return { op: String(h.properties.operation ?? ''), decision: h.name, options, written: w ? String(N.inst.get(w)?.properties.cls ?? '?') : '?', today: opt(T), neutral: opt(N), monolith: opt(M) };
}).sort((x, y) => x.op.localeCompare(y.op));

// ---------------------------------------------------------------- workload: sessions
const reqRate = new Map<Id, number>();
for (const m of A.msaMapping?.operations ?? []) if (m.request) reqRate.set(m.request, (reqRate.get(m.request) ?? 0) + (m.rate ?? 0) * LOAD_FACTOR);
const wl = fromWorkload(W, reqRate, new Set(A.operations.filter((o: any) => o.domain).map((o: any) => o.id)), new Map());
const sessions: ModelSession[] = domain.sessions.map((s) => {
  const visits = s.steps.map((st) => ({ request: st.request, visits: (st.probability ?? 1) * (st.repeat ?? 1) }));
  let perS = wl.designSessions * s.share;
  if (s.share === 0) {
    // admin: a constant rate (C2), its requests at their round-2 rates
    const v = visits.reduce((x, y) => x + y.visits, 0) || 1;
    perS = visits.reduce((x, y) => x + (rates.get(y.request) ?? 0), 0) / v;
  }
  return { id: s.id, name: s.name, description: s.description, share: s.share, sessionsPerS: round(perS, 4), thinkTimeS: s.thinkTimeS, visits };
});

// ---------------------------------------------------------------- parameters of the decision layer
// what the evaluation reads (docs/quality.md); the LoadSteps are the Workload tab's profile chart
const PARAM_CLASSES = ['ArchitectureDecisions', 'CostModel', 'ContainerPrice', 'Reliability', 'ChangeUnit', 'ChangeCoupling', 'Consistency', 'PeakCapacity',
  'Latency', 'LatencyBudgetPolicy', 'Autoscaling', 'Deployable', 'ReplicaOption', 'RemoteCalls', 'SyncCall', 'AsyncCall', 'InTransaction', 'CachedCall', 'ComposedCall', 'LocalCopy',
  'Choreographed', 'Orchestrated', 'LoadProfile'];
const PARAM_LINKS = new Set(['containers', 'container', 'components', 'autoscaling', 'direct', 'broker']);
const P = T ?? N;
// per class by name, links sorted: a seed realised again may list the same instances in another order, which would
// change the Verify tab's parameter parts' fingerprints (as for sites and accesses, canon above)
const parameters: ModelParameter[] = PARAM_CLASSES.flatMap((c) => canon(P.all(c).map((i) => {
  const props: ModelParameter['properties'] = {};
  for (const [k, v] of Object.entries(i.properties)) props[k] = v && typeof v === 'object' && 'enum' in v ? v.enum : v ?? null;
  const links: Record<string, string[]> = {};
  for (const [k, t] of P.out.get(i.name) ?? []) if (PARAM_LINKS.has(k)) (links[k] ??= []).push(t);
  for (const k of Object.keys(links)) links[k].sort();
  return { class: c, name: i.name, properties: props, ...(Object.keys(links).length ? { links } : {}) };
}), (x) => x.name));

// ---------------------------------------------------------------- the load profile (cases/misarch/workload/WORKLOAD.md §5)
const profiles: ModelProfile[] = evals.map(({ id, file, ev }) => {
  const { phases, about } = profilePhases(W, id);
  return {
    id, model: rel(file), warmUpS: ev.warmUpS, endS: ev.endS, seed: ev.seed, usageStreams: ev.usageStreams, maxPods: ev.maxPods, about, phases,
    // the session classes by name, whatever order the realised seed lists its scenarios in
    steps: ev.steps, baseRates: Object.fromEntries(canon(Object.entries(ev.baseRates), ([k]) => k).map(([k, v]) => [k, round(v, 4)])),
    latency: { statistic: ev.latency.statistic, factor: ev.latency.factor, minCompletions: ev.latency.minCompletions },
  };
});
if (!profiles.length) notes.push(`no realised today's model in ${rel(path.dirname(files.today))}: no load profiles, no budgets`);

// ---------------------------------------------------------------- metamodels (parsed from the .mm files)
const MMS: { id: Id; title: string; layer: string; files: string[] }[] = CASE.metamodels.map((m) => ({ ...m, files: m.files.map(rel) }));
const importId = (f: string) => MMS.find((m) => m.files.some((x) => path.basename(x) === path.basename(f)))?.id ?? f;
const metamodels: Metamodel[] = MMS.map((mm) => {
  const parsed = mm.files.map((f) => parseMetamodel(fs.readFileSync(path.join(PROJECT, f), 'utf8')));
  const own = new Set(mm.files.map((f) => path.basename(f)));
  return {
    id: mm.id, title: mm.title, layer: mm.layer, files: mm.files, description: parsed[0].description,
    imports: [...new Set(parsed.flatMap((p) => p.imports).filter((i) => !own.has(path.basename(i))).map(importId))],
    enums: parsed.flatMap((p) => p.enums), classes: parsed.flatMap((p) => p.classes), references: parsed.flatMap((p) => p.references),
    views: parsed.flatMap((p) => p.views), sections: [...new Set(parsed.flatMap((p) => p.sections))],
  };
});
// instances per class (and its subclasses) in today's realised seed
{
  const all = new Map<string, MmClass>();
  for (const mm of metamodels) for (const c of mm.classes) all.set(c.name, c);
  const count = new Map<string, number>();
  for (const [cls, list] of P.byClass) {
    for (const c of [cls, ...supertypes(cls, all)]) count.set(c, (count.get(c) ?? 0) + list.length);
  }
  for (const c of all.values()) c.used = count.get(c.name) ?? 0;
}

// ---------------------------------------------------------------- origin
const ORIGIN: ModelOrigin[] = ORIGIN_ALL;
const origin = ORIGIN.filter((o) => fs.existsSync(path.resolve(PROJECT, o.path)));

// ---------------------------------------------------------------- timing source (1.1.0)
const appCpu = requests.reduce((s, r) => s + r.rate * r.work.app, 0);
const timing: NonNullable<InputModel['timing']> = {
  source: 'campaign-v3', label: 'campaign v3, k_c applied', kApplied: true,
  ...(appCpu > 0 ? { mapShare: round(requests.reduce((s, r) => s + r.rate * (r.work.map ?? 0), 0) / appCpu, 4) } : {}),
  note: "the timing campaign (timing/parts.json, timing/README.md, timing/RESULTS.md): per operation its own CPU (counters), the request overhead on the request's root resolver, per (class, mode) access its database CPU and the mapping CPU (app-side persistence), × k_c of the container that ran it today (the order path's cardinality term before k_c); mechanism parameters from RESULTS §5, not scaled",
  envelope: { source: 'measured-v3', file: rel(CASE.timing), note: "measured by the timing campaign (timing/parts.json `envelope`, timing/README.md §6): a reaction's envelope is its handler's counter remainder per delivery (countersRemainderCpuMs) on top of its counter-measured work, a write's the callee envelope of its service" },
};

function input(label: string, f: string, note?: string): ModelInput {
  return { label, path: rel(f), ...(note ? { note } : {}), hash: sha256(f) };
}
/**
 * a realised seed with the model it was realised from (its `// Source: <path> sha256 <hex>` line,
 * core/platform/realised_to_m.py) and what that model was generated from (`// Input:` lines, core/generator/derive.py)
 */
function seedInput(label: string, s: (typeof SEEDS)[number], note?: string): ModelInput {
  const f = seedFile(s);
  const head = f.endsWith('.m') ? fs.readFileSync(f, 'utf8').slice(0, 20000) : '';
  const src = /^\/\/ Source: (\S+) sha256 ([0-9a-f]+)$/m.exec(head);
  const gen = [...head.matchAll(/^\/\/ Input: (\S+) sha256 ([0-9a-f]+)$/gm)].map((m) => ({ path: m[1], hash: m[2] }));
  if (f.endsWith('.m') && !src) notes.push(`${rel(f)} names no source model (written before core/platform/realised_to_m.py recorded it)`);
  const data = s === 'domain-neutral' ? files.neutral : s === 'domain-today' ? files.today : files.monolith;
  return { ...input(label, f, note), fingerprint: modelFingerprint(readJson(data)), ...(src ? { source: { path: src[1], hash: src[2] } } : {}), ...(gen.length ? { generatedFrom: gen } : {}) };
}

const model: InputModel = {
  contract: CONTRACT_VERSION, domainId: DOMAIN_ID, generatedAt: new Date().toISOString(), commit: A.meta?.commit, timing,
  inputs: [
    input("package A's extraction", files.a, `misarch-kotlin @ ${String(A.meta?.commit ?? '').slice(0, 12)}`),
    input("package C's workload", files.w, `version ${W.version}`),
    ...(fs.existsSync(CASE.timing) ? [input("the timing campaign's parts", CASE.timing, `version ${PARTS.version ?? '?'}`)] : []),
    seedInput('realised neutral seed (SEFFs, domain section)', 'domain-neutral', `timing: ${timing.label}`),
    ...(T ? [seedInput("realised today's seed (today's mechanisms, parameters, instance counts, load profile, C1 policy and budgets)", 'domain-today')] : []),
    ...(M ? [seedInput('realised monolith seed (its mechanisms)', 'domain-monolith')] : []),
    ...MMS.flatMap((m) => m.files.map((f) => input(`metamodel ${m.id}`, path.join(PROJECT, f)))),
    // the exporter itself: a change of how the model is exported exports it again
    ...[...['export-model.ts', 'evaluation-setup.ts', 'domain-a.ts', 'workload-c.ts', 'config.ts'].map((f) => path.join(dirs.builder, f)),
      ...['contract/metamodel.ts', 'contract/hash.ts'].map((f) => path.join(dirs.explorer, f))]
      .map((f) => input('the exporter', f)),
  ],
  exportArgs: args,
  origin, classes, references, operations, events, bindings, processes, requests, sessions,
  designSessionsPerS: round(wl.designSessions, 4), profiles, seffs: [...seffs.values()], sites, topics, ...(homes.length ? { homes } : {}), ...(envelopes.length ? { envelopes } : {}), parameters,
  // (1.13.0) the curated levels' and rules' texts (package A's top-level `consistency`)
  ...(A.consistency ? { consistency: { levels: A.consistency.levels ?? {}, rules: A.consistency.rules ?? {}, ...(A.consistency.source ? { source: A.consistency.source } : {}) } } : {}),
  metamodels,
  notes: [...new Set(notes)],
};

fs.mkdirSync(path.join(OUT, 'models'), { recursive: true });
const file = path.join(OUT, 'models', `${DOMAIN_ID}.json`);
// in one step: the backend may read the model at any time
fs.writeFileSync(`${file}.tmp`, JSON.stringify(model));
fs.renameSync(`${file}.tmp`, file);
console.log(`${file}: ${classes.length} classes, ${references.length} references, ${operations.length} operations, ${requests.length} requests, ${sessions.length} sessions, ${seffs.size} SEFFs, ${sites.length} sites, ${parameters.length} parameters, ${metamodels.map((m) => `${m.id} ${m.classes.length}`).join(', ')}; ${model.notes!.length} notes, ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
for (const n of model.notes!.slice(0, 12)) console.log(`  note: ${n}`);
