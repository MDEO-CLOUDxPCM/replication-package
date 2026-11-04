/**
 * Exporter: a run of the domain problem (a headless run of core/tools/run-domain.sh, or a
 * platform execution converted by core/platform/to_run.py: every design evaluated by SimOxide simulations under the
 * model's load profile) + its build -> an explorer bundle in build/explorer-sim (the packet).
 *
 *   pnpm export:run --run ../../build/<build>/runs/<name> [--domain misarch-kotlin-derived]
 *       [--seed <build>/realised/domain-neutral.model.json]   (default: the run's seed in front.json)
 *       [--ref today=<build>/realised/domain-today.model.json --ref monolith=...]  (default: both, as far as the build has them)
 *       [--config optimize/domain/<config>]   (default: the one <build>/config-<name>.log validated)
 *       [--values <build>/eval/values.json] [--out ../../build/explorer-sim] [--id <run id>] [--name <label>]
 *       [--description <text>] [--tag <tag> ...] [--box '{"ideal":[..],"nadir":[..],"label":".."}']  (hypervolume box shared by runs)
 *
 * Inputs of the run directory: designs.jsonl (ARCH_DESIGNS=1: every evaluated design, its decisions as
 * the links that differ from the seed), front.json, history_batch0.json, archive.json, log.txt; of its
 * build (<build>/runs/<name>): the realised seeds, eval/values.json (the references' values),
 * plugin-manifest.json (the plugin version). The run's evaluation (config.evaluation: load profile,
 * window, phases, C1's policy and budgets, C2's containers and limit) is read from the seed.
 *
 * Decisions from the model (domain.mm's derivation trace):
 *   service cut      class -> container of `alloc_Assembly_<Class>`; a service = a container, named
 *                    by it when it holds its namesake class, else "<first class> +<n>"
 *   databases        schema `alloc_Assembly_<Class>Db` -> database server
 *   mechanisms       per Access (operation, class, mode) the mechanism of its CallSites, listed
 *                    when the class lives in another service than the operation's home class;
 *                    SyncCall -> sync, AsyncCall -> saga (an asynchronous saga step / async write),
 *                    LocalCopy -> copy, CachedCall -> cache, ComposedCall (join, joinCache) -> join
 *   sagas            `saga_<Process>.style` for the processes whose steps span services; `tx_<SEFF>.style` for the
 *                    transaction workflows while a step's class sits in another service than the trigger
 *   replicas         the HPA of the Deployables (Autoscaling: min, max, target utilisation; SimOxide's
 *                    HPA scales them in the simulation)
 *   operationPlacement  where the model's home class differs from the explorer domain's home class
 */
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Access, ConsistencyLevel, Decisions, Design, Domain, EffectMechanism, EffectSite, EffectState, EvaluationSetup, Generation, Id, Mechanism, MetricDef, ObjectiveDef, ConstraintDef, Run } from '../../../core/explorer/contract/types';
import { CONTRACT_VERSION } from '../../../core/explorer/contract/types';
import { cyrb53, modelFingerprint } from '../../../core/explorer/contract/hash';
import { levelOf } from '../../../core/explorer/contract/consistency';
import { bounds, hypervolume, minForm, ranks } from '../../../core/explorer/contract/pareto';
import { writeDesignsJsonl } from '../../../core/explorer/contract/jsonl';
import { loadMisarchDomain } from './domain-a';
import { ident, modelEvaluation, profilePhases } from './evaluation-setup';
import { files as CASE, packet } from './config';

/* eslint-disable @typescript-eslint/no-explicit-any */
const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const all = (k: string) => args.flatMap((a, i) => (a === `--${k}` ? [args[i + 1]] : []));
const runDir = path.resolve(opt('run') ?? '');
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, 'utf8'));
// the run's build (core/tools/run-domain.sh ARCH_DIR: <build>/runs/<name>): its seeds, references' values, plugin;
// the detail simulator rebuilds designs with its transformations, scripts and plugin (core/tools/design_detail.sh DETAIL_BUILD)
const runBuild = path.basename(path.dirname(runDir)) === 'runs' ? path.dirname(path.dirname(runDir)) : undefined;
// a run still going has no front.json: its seed is the model its config names (core/tools/run-domain.sh: `-realised` dropped)
const configJson = runBuild ? path.join(runBuild, `config-${path.basename(runDir)}.json`) : '';
const configSeed = configJson && fs.existsSync(configJson)
  ? `realised/${path.basename(String(readJson(configJson).problem?.modelPath ?? ''), '.m').replace(/-realised$/, '')}.model.json` : undefined;
const frontSeed = fs.existsSync(path.join(runDir, 'front.json')) ? readJson(path.join(runDir, 'front.json')).seed as string | undefined : configSeed;
const seedFile = path.resolve(opt('seed') ?? (runBuild ? path.join(runBuild, frontSeed ?? 'realised/domain-neutral.model.json') : ''));
const out = path.resolve(opt('out') ?? packet.out);
const runId = opt('id') ?? `domain-${path.basename(runDir)}`;
const buildDir = path.basename(path.dirname(seedFile)) === 'realised' ? path.dirname(path.dirname(seedFile)) : runBuild;
if (!buildDir) throw new Error(`no build directory for ${runDir} (expected <build>/runs/<name> or --seed <build>/realised/...)`);
const valuesFile = path.resolve(opt('values') ?? path.join(buildDir, 'eval/values.json'));
// --domain: the input model the run's Model panel shows (export-model.ts --domain)
const DOMAIN_ID = opt('domain') ?? packet.domainId;

// ---------------------------------------------------------------- domain (A + C, as the explorer reads them)
const domain: Domain = {
  ...loadMisarchDomain(readJson(CASE.extraction), readJson(CASE.workload)),
  id: DOMAIN_ID,
  name: DOMAIN_ID === packet.domainId ? packet.domainName : `${packet.domainName} (${DOMAIN_ID.replace(`${packet.domainId}-`, '')})`,
};
domain.source += '; operations placed by the model\'s home class (models/domain-*.m)';

// ---------------------------------------------------------------- the model's trace (from the seed)
interface Trace {
  classes: string[];
  /** model home class per operation id */
  home: Map<Id, string>;
  /** accesses: op id, class, mode, sites */
  accesses: { op: Id; cls: string; mode: 'read' | 'write'; sites: string[]; count: number; level?: ConsistencyLevel }[];
  mechanismKind: Map<string, Mechanism>;
  /** the transaction workflows: trigger operation and the classes its steps write */
  transactions: { id: Id; trigger: Id; writes: string[]; home?: Id }[];
  /** (1.4.0) the effect steps with the workflows whose step each one is */
  effectSites: (EffectSite & { workflows: Id[]; homeOp?: Id })[];
  /** the operations whose home is a decision: the Home instance, its options (HomeOption -> class), the written option */
  homes: { name: string; op: Id; options: Map<string, Id>; written: Id }[];
  /** the call sites in a home option's SEFF: inert unless that option is chosen */
  siteHome: Map<string, { op: Id; cls: Id }>;
  effectMechanism: Map<string, EffectMechanism>;
  orchestrated: Set<string>;
  autoscaling: { min: number; max: number; target: number };
}

function linkMap(m: any, props: Set<string>): Map<string, string> {
  const r = new Map<string, string>();
  for (const l of m.links) if (props.has(l.sourceProperty)) r.set(`${l.sourceName}.${l.sourceProperty}`, l.targetName);
  return r;
}

/** (contract 1.13.0) domain.mm's ConsistencyLevel as the contract's */
const LEVEL: Record<string, ConsistencyLevel> = { STRICT: 'strict', STALE_OK: 'stale-ok', IMMUTABLE: 'immutable' };

function traceOf(m: any): Trace {
  const inst = new Map<string, any>(m.instances.map((i: any) => [i.name, i]));
  const out = new Map<string, [string, string][]>();
  const owner = new Map<string, string>();
  for (const l of m.links) {
    if (!out.has(l.sourceName)) out.set(l.sourceName, []);
    out.get(l.sourceName)!.push([l.sourceProperty, l.targetName]);
    if (l.sourceProperty === 'serviceEffectSpecifications') owner.set(l.targetName, l.sourceName);
  }
  const links = (n: string, p: string) => (out.get(n) ?? []).filter(([q]) => q === p).map(([, t]) => t);
  const classes: string[] = [];
  const classOf = new Map<string, string>();
  for (const i of m.instances) if (i.className === 'DomainClass') { classes.push(i.properties.name); classOf.set(i.name, i.properties.name); }
  const home = new Map<Id, string>();
  const accesses: Trace['accesses'] = [];
  for (const i of m.instances) {
    if (i.className !== 'Operation') continue;
    const id = i.properties.name as string;
    const seffs = links(i.name, 'seffs');
    const comp = seffs.map((s) => owner.get(s)).find((c) => c && classes.includes(c));
    // an operation without SEFF (not reached by the workload) is not part of the simulated system
    if (!comp) continue;
    home.set(id, comp);
    for (const a of links(i.name, 'accesses')) {
      const ai = inst.get(a);
      const cls = classOf.get(links(a, 'target')[0]);
      if (!cls) continue;
      accesses.push({ op: id, cls, mode: ai.properties.mode?.enum === 'WRITE' ? 'write' : 'read', sites: links(a, 'sites'),
        count: ai.properties.count ?? 1, ...(LEVEL[ai.properties.level?.enum] ? { level: LEVEL[ai.properties.level.enum] } : {}) });
    }
  }
  // InTransaction across containers is a synchronous step; co-located accesses are local anyway
  const kinds: Record<string, Mechanism> = { SyncCall: 'sync', AsyncCall: 'saga', InTransaction: 'sync', LocalCopy: 'copy', CachedCall: 'cache', ComposedCall: 'join' };
  const mechanismKind = new Map<string, Mechanism>();
  for (const i of m.instances) if (kinds[i.className]) mechanismKind.set(i.name, kinds[i.className]);
  // a transaction workflow's trigger is a SEFF of the operation, its steps are the write calls of its sites
  const opOfSeff = new Map<string, Id>();
  for (const i of m.instances) if (i.className === 'Operation') for (const s of links(i.name, 'seffs')) opOfSeff.set(s, i.properties.name);
  const siteOfCall = new Map<string, string>();
  for (const i of m.instances) if (i.className === 'CallSite') siteOfCall.set(links(i.name, 'call')[0], i.name);
  const homeSeffCls = new Map<string, Id>();
  for (const h of m.instances) if (h.className === 'Home') for (const o of links(h.name, 'options')) { const [sf] = links(o, 'seff'); if (sf) homeSeffCls.set(sf, String(inst.get(o)?.properties?.cls ?? '?')); }
  const transactions = m.instances.filter((i: any) => i.className === 'Workflow' && i.properties?.transactional === true).flatMap((w: any) => {
    const trigger = opOfSeff.get(links(w.name, 'trigger')[0]);
    if (!trigger) return [];
    const sites = links(w.name, 'steps').map((a) => siteOfCall.get(a));
    const writes = [...new Set(accesses.filter((a) => a.op === trigger && a.mode === 'write' && a.sites.some((s) => sites.includes(s))).map((a) => a.cls))];
    // a workflow of a home option's SEFF: acts only while that option is chosen
    const hs = homeSeffCls.get(links(w.name, 'trigger')[0]);
    return [{ id: w.name as Id, trigger, writes, ...(hs ? { home: hs } : {}) }];
  });
  // (1.4.0) effect steps: the sites with a step form, and the provider callbacks (external, async only)
  const effectMechanism = new Map<string, EffectMechanism>();
  const EM: Record<string, EffectMechanism> = { InTransaction: 'inTx', SyncCall: 'sync', AsyncCall: 'async' };
  for (const i of m.instances) if (EM[i.className]) effectMechanism.set(i.name, EM[i.className]);
  const orchestrated = new Set<string>(m.instances.filter((i: any) => i.className === 'Orchestrated').map((i: any) => i.name));
  // the SEFF a base call sits in (also inside branches and forks): its RealisedCall's `seff`
  const seffOfCall = new Map<string, string>();
  for (const i of m.instances) if (i.className === 'RealisedCall') { const [a] = links(i.name, 'action'); const [sf] = links(i.name, 'seff'); if (a && sf && !seffOfCall.has(a)) seffOfCall.set(a, sf); }
  const seffOfAction = (a: string) => seffOfCall.get(a);
  const seffBySig = new Map<string, string>();
  for (const i of m.instances) if (i.className === 'ResourceDemandingSEFF') { const [sg] = links(i.name, 'describedService'); if (sg && !seffBySig.has(sg)) seffBySig.set(sg, i.name); }
  const workflowsOf = new Map<string, Id[]>();
  for (const w of m.instances) if (w.className === 'Workflow') for (const a of links(w.name, 'steps')) workflowsOf.set(a, [...(workflowsOf.get(a) ?? []), w.name]);
  const schemaClass = (asm: string | undefined) => asm?.replace(/^Assembly_/, '').replace(/Db$/, '');
  // the SEFF of each home option: its sites are inert while another option is chosen
  const homeOfSeff = new Map<string, { op: Id; cls: Id }>();
  for (const h of m.instances) if (h.className === 'Home') for (const o of links(h.name, 'options')) {
    const [sf] = links(o, 'seff');
    if (sf) homeOfSeff.set(sf, { op: String(h.properties?.operation ?? ''), cls: String(inst.get(o)?.properties?.cls ?? '?') });
  }
  const siteHome: Trace['siteHome'] = new Map();
  for (const i of m.instances) if (i.className === 'CallSite') { const sf = seffOfAction(links(i.name, 'call')[0]); if (sf && homeOfSeff.has(sf)) siteHome.set(i.name, homeOfSeff.get(sf)!); }
  const effectSites: Trace['effectSites'] = [];
  for (const i of m.instances) {
    if (i.className !== 'CallSite') continue;
    const [call] = links(i.name, 'call');
    const ent = String(inst.get(call)?.properties?.entityName ?? '');
    const [stepSig] = links(i.name, 'stepService');
    const kind = ent.startsWith('callback') ? 'callback' as const : !stepSig ? undefined : ent.startsWith('event') ? 'event' as const : 'write' as const;
    if (!kind) continue;
    const seff = seffOfAction(call);
    const op = seff ? opOfSeff.get(seff) : undefined;
    if (!op) continue;
    const callerClass = seff ? owner.get(seff) : undefined;
    const target = kind === 'callback' ? seffBySig.get(links(call, 'calledService')[0]) : seffBySig.get(links(i.name, 'joinedService')[0] ?? '');
    const providerClass = kind === 'callback' ? (target ? owner.get(target) : undefined) : (stepSig ? owner.get(seffBySig.get(stepSig) ?? '') : undefined);
    const callee = kind !== 'write' && target ? opOfSeff.get(target) : undefined;
    effectSites.push({
      id: i.name, op, kind, class: providerClass ?? '?', ...(callee ? { callee } : {}),
      allowed: links(i.name, 'allowed').map((x) => effectMechanism.get(x)).filter((x): x is EffectMechanism => !!x),
      ...(links(i.name, 'callerSchema')[0] ? { callerSchema: schemaClass(links(i.name, 'callerSchema')[0]) } : {}),
      ...(links(i.name, 'providerSchema')[0] ? { providerSchema: schemaClass(links(i.name, 'providerSchema')[0]) } : {}),
      ...(callerClass && classes.includes(callerClass) ? { callerClass } : {}),
      ...(seff && homeOfSeff.has(seff) ? { home: homeOfSeff.get(seff)!.cls, homeOp: homeOfSeff.get(seff)!.op } : {}),
      workflows: workflowsOf.get(call) ?? [],
    });
  }
  // Home {operation}, HomeOption {cls}: the home as a decision (link `home`)
  const homes: Trace['homes'] = m.instances.filter((i: any) => i.className === 'Home').map((h: any) => {
    const options = new Map<string, Id>(links(h.name, 'options').map((o) => [o, String(inst.get(o)?.properties?.cls ?? '?')]));
    return { name: h.name, op: String(h.properties?.operation ?? ''), options, written: options.get(links(h.name, 'written')[0]) ?? '?' };
  });
  const as = m.instances.find((i: any) => i.className === 'Autoscaling')?.properties ?? {};
  return { classes, home, accesses, mechanismKind, transactions, effectSites, effectMechanism, orchestrated, homes, siteHome, autoscaling: { min: as.minReplicas ?? 1, max: as.maxReplicas ?? 16, target: as.targetUtilisation ?? 0.7 } };
}

/** a design's decision links that differ from the seed, without the resource environment's list */
const modelDiff = (d: Record<string, string> | Map<string, string>) =>
  Object.fromEntries([...(d instanceof Map ? d : new Map(Object.entries(d)))].filter(([k]) => !k.startsWith('environment.')).sort());

const modelHash = (raw: Record<string, string>) => cyrb53(JSON.stringify(Object.entries(raw)));

const seedModel = readJson(seedFile);
const trace = traceOf(seedModel);
// how every design of the run was evaluated (the seed's profile, C1's policy and budgets, C2; docs/quality.md)
const ev = modelEvaluation(seedModel);
const profile = ev.profile;
const workloadC = readJson(CASE.workload);
const pluginVersion = fs.existsSync(path.join(buildDir, 'plugin-manifest.json')) ? String(readJson(path.join(buildDir, 'plugin-manifest.json')).version ?? '') || undefined : undefined;
const reqByIdent = new Map(domain.requests.map((r) => [ident(r.id), r.id]));
const evaluation: EvaluationSetup = {
  profile, warmUpS: ev.warmUpS, endS: ev.endS, binS: ev.binS, seed: ev.seed, usageStreams: ev.usageStreams, maxPods: ev.maxPods,
  phases: profilePhases(workloadC, profile).phases, latency: ev.latency,
  budgets: Object.fromEntries([...ev.budgets].flatMap(([sig, b]) => (b.budgetMs && reqByIdent.has(sig) ? [[reqByIdent.get(sig)!, { budgetMs: b.budgetMs, referenceMs: b.referenceMs, referenceCount: b.referenceCount }]] : []))),
  peakCapacity: ev.peakCapacity, pluginVersion,
};
// the domain as the model has it: only the operations the workload reaches, each with the model's
// home class and the model's accesses (one per operation, class and mode), so the explorer draws
// exactly the accesses the model realises
{
  const inModel = new Set(trace.home.keys());
  // (contract 1.13.0) a read's level as the model has it (absent: stale-ok), the curated rules and reasons from package A
  const acc = new Map<Id, Access[]>();
  const fromA = new Map(domain.operations.map((o) => [o.id, o]));
  for (const a of trace.accesses) {
    const ax = fromA.get(a.op)?.accesses.find((x) => x.class === a.cls && x.mode === a.mode);
    const cur = a.level && ax && levelOf(ax) === a.level ? { ...(ax.rules ? { rules: ax.rules } : {}), ...(ax.reason ? { reason: ax.reason } : {}) } : {};
    acc.set(a.op, [...(acc.get(a.op) ?? []), { class: a.cls, mode: a.mode, perExecution: a.count, ...(a.level && a.level !== 'stale-ok' ? { level: a.level } : {}), ...cur, ...(ax?.lock ? { lock: true } : {}) }]);
  }
  domain.operations = domain.operations.filter((o) => inModel.has(o.id)).map((o) => {
    const joined = new Set(o.accesses.filter((x) => x.joined).map((x) => `${x.class}|${x.mode}`));
    return { ...o, homeClass: trace.home.get(o.id)!, accesses: (acc.get(o.id) ?? []).map((x) => ({ ...x, joined: joined.has(`${x.class}|${x.mode}`) || undefined })) };
  });
  const keep = (xs: Id[]) => xs.filter((x) => inModel.has(x));
  domain.features = domain.features.map((f) => ({ ...f, operations: keep(f.operations) }));
  domain.processes = domain.processes.map((p) => ({ ...p, steps: keep(p.steps) }));
  // the transaction workflows: the trigger's transaction, its bound writes as steps
  for (const t of trace.transactions) domain.processes.push({ id: t.id, name: `${t.trigger} (transaction)`, trigger: t.trigger, steps: [], transaction: { writes: t.writes, ...(t.home ? { home: t.home } : {}) } });
  domain.events = domain.events.map((e) => ({ ...e, publishers: keep(e.publishers), subscribers: keep(e.subscribers) }));
  domain.requests = domain.requests.map((r) => ({ ...r, operations: keep(r.operations) }));
  domain.source += `; ${domain.operations.length} operations of the derived model (those the workload reaches)`;
  // (1.4.0) the effect steps; an event step names the event its reaction subscribes to
  if (trace.homes.length) domain.homes = trace.homes.map((h) => ({ op: h.op, options: [...new Set(h.options.values())], written: h.written }));
  if (trace.effectSites.length) {
    const eventOf = new Map<Id, Id>();
    for (const e of domain.events) for (const x of e.subscribers) eventOf.set(x, e.id);
    domain.effectSites = trace.effectSites.map(({ workflows: _w, homeOp: _h, ...e }) => (e.kind === 'event' && e.callee && eventOf.has(e.callee) ? { ...e, event: eventOf.get(e.callee) } : e));
  }
}
const domainOps = new Map(domain.operations.map((o) => [o.id, o]));
const DECISION_PROPS = new Set(['resourceContainer', 'mechanism', 'style', 'home']);
const seedLinks = linkMap(seedModel, DECISION_PROPS);

/** the design's decisions: the seed's decision links overlaid with the design's differences */
function decisionsOf(diff: Record<string, string> | Map<string, string>): { decisions: Decisions; metrics: Record<string, number> } {
  const d = diff instanceof Map ? diff : new Map(Object.entries(diff));
  const get = (k: string) => d.get(k) ?? seedLinks.get(k);
  const containerOf = new Map<string, string>();
  const dbOf = new Map<string, string>();
  for (const c of trace.classes) {
    containerOf.set(c, get(`alloc_Assembly_${c}.resourceContainer`) ?? 'unplaced');
    dbOf.set(c, get(`alloc_Assembly_${c}Db.resourceContainer`) ?? 'unplaced');
  }
  // services: one per container in use; named by the container when it holds its namesake class
  const byContainer = new Map<string, string[]>();
  for (const c of trace.classes) byContainer.set(containerOf.get(c)!, [...(byContainer.get(containerOf.get(c)!) ?? []), c]);
  const dbServers = new Map<string, Set<string>>();
  for (const c of trace.classes) {
    const s = dbOf.get(c)!;
    if (!dbServers.has(s)) dbServers.set(s, new Set());
    dbServers.get(s)!.add(containerOf.get(c)!);
  }
  const services = [...byContainer.entries()].map(([container, classes]) => {
    const namesake = container.replace(/Service$/, '');
    const count = new Map<string, number>();
    for (const c of classes) count.set(dbOf.get(c)!, (count.get(dbOf.get(c)!) ?? 0) + 1);
    const database = [...count.entries()].sort((a, b) => b[1] - a[1])[0][0];
    return {
      id: container,
      // a container that does not hold its namesake class is named after its classes (its container
      // name would mislead, e.g. "OrderItemService" holding TaxRate and TaxRateVersion)
      name: classes.includes(namesake) || container === 'MonolithService' ? container
        : `${[...classes].sort()[0]}${classes.length > 1 ? ` +${classes.length - 1}` : ''}`,
      classes,
      replicas: { mode: 'hpa' as const, min: trace.autoscaling.min, max: trace.autoscaling.max, targetUtilisation: trace.autoscaling.target },
      database,
    };
  });
  const databases = [...dbServers.entries()].map(([id, svcs]) => ({ id, name: id, placement: (svcs.size > 1 ? 'shared' : 'own') as 'shared' | 'own', services: [...svcs] }));
  // the chosen home of the operations whose home is a decision
  const homes: Record<Id, Id> = {};
  for (const h of trace.homes) { const c = h.options.get(get(`${h.name}.home`) ?? ''); if (c && h.op) homes[h.op] = c; }
  // where each operation runs: the model's home class (the chosen one)
  const opService = (op: Id) => {
    const h = homes[op] ?? trace.home.get(op) ?? domainOps.get(op)?.homeClass;
    return h ? containerOf.get(h) : undefined;
  };
  const operationPlacement: Record<Id, Id> = {};
  for (const [op, h0] of trace.home) {
    const h = homes[op] ?? h0;
    const dop = domainOps.get(op);
    if (dop && dop.homeClass !== h && containerOf.get(dop.homeClass) !== containerOf.get(h)) operationPlacement[op] = containerOf.get(h)!;
  }
  const mechanisms: Record<string, Mechanism> = {};
  let crossSync = 0, crossAsync = 0, copies = 0;
  for (const a of trace.accesses) {
    const from = opService(a.op);
    const to = containerOf.get(a.cls);
    if (!from || from === to) continue;
    const votes = new Map<Mechanism, number>();
    for (const s of a.sites) {
      // only the chosen home's sites act
      const sh = trace.siteHome.get(s);
      if (sh && (homes[sh.op] ?? trace.homes.find((h) => h.op === sh.op)?.written) !== sh.cls) continue;
      const k = trace.mechanismKind.get(get(`${s}.mechanism`) ?? '') ?? 'sync';
      votes.set(k, (votes.get(k) ?? 0) + 1);
    }
    const m: Mechanism = votes.size ? [...votes.entries()].sort((x, y) => y[1] - x[1])[0][0] : 'sync';
    mechanisms[`${a.op}|${a.cls}|${a.mode}`] = m;
    if (m === 'sync') crossSync++;
    if (m === 'saga') crossAsync++;
    if (m === 'copy') copies++;
  }
  // (1.4.0) the effect steps: joined while caller and provider share a container and the two schemas a database
  // server and the step is no orchestrated workflow step (transform/realise/plan-placement.mt `pj`); else why not
  const effects: Record<Id, EffectState> = {};
  for (const e of trace.effectSites) {
    // a step in a home option not chosen is inert (not reached): no state
    if (e.home && e.homeOp && (homes[e.homeOp] ?? trace.homes.find((h) => h.op === e.homeOp)?.written) !== e.home) continue;
    const mm = trace.effectMechanism.get(get(`${e.id}.mechanism`) ?? '') ?? (e.kind === 'callback' ? 'async' : 'sync');
    const together = !!e.callerClass && containerOf.get(e.callerClass) === containerOf.get(e.class);
    const st: EffectState = { m: mm, ...(together ? { together: true as const } : {}) };
    if (e.kind === 'callback') st.why = 'external';
    else if (mm !== 'inTx') st.why = 'chosen';
    else if (!together) st.why = 'apart';
    else if (!e.callerSchema || !e.providerSchema || dbOf.get(e.callerSchema) !== dbOf.get(e.providerSchema)) st.why = 'servers';
    else if (e.workflows.some((w) => trace.orchestrated.has(get(`${w}.style`) ?? ''))) st.why = 'orchestrated';
    else st.joined = true;
    effects[e.id] = st;
  }
  const sagas = domain.processes.flatMap((p) => {
    if (p.transaction?.home && (homes[p.trigger] ?? trace.homes.find((h) => h.op === p.trigger)?.written) !== p.transaction.home) return [];
    const style = get(p.transaction ? `${p.id}.style` : `saga_${p.id}.style`);
    if (!style) return [];
    const svcs = new Set(p.transaction ? [opService(p.trigger), ...p.transaction.writes.map((c) => containerOf.get(c))].filter(Boolean)
      : p.steps.map((s) => opService(s)).filter(Boolean));
    if (svcs.size < 2) return [];
    const st = style === 'orchestration' ? 'orchestration' as const : 'choreography' as const;
    return [{ process: p.id, style: st, orchestrator: st === 'orchestration' ? opService(p.trigger ?? p.steps[0]) : undefined }];
  });
  return {
    decisions: { services, mechanisms, sagas, databases, operationPlacement, ...(trace.effectSites.length ? { effects } : {}), ...(trace.homes.length ? { homes } : {}) },
    metrics: { services: services.length, databases: databases.length, crossSync, crossAsync, copies,
      ...(trace.effectSites.length ? { joinedSteps: Object.values(effects).filter((e) => e.joined).length, inTxSteps: Object.values(effects).filter((e) => e.m === 'inTx').length } : {}) },
  };
}

// ---------------------------------------------------------------- the run
const rd = (f: string) => (fs.existsSync(path.join(runDir, f)) ? readJson(path.join(runDir, f)) : null);
// a run still going has no front.json yet: export what designs.jsonl has (status running)
const running = !fs.existsSync(path.join(runDir, 'front.json'));
// a running run: the objectives and constraints of its config (<build>/config-<name>.json), else those of the domain
// configs (configs/*-3obj-5sim.config) in their order, as many as its first design's vectors
const ALL_OBJECTIVES = ['MINIMIZE cost', 'MINIMIZE failure', 'MINIMIZE performance'];
const ALL_CONSTRAINTS = ['latencyBudget', 'peakCapacity', 'cohesion', 'changeCouplingBound', 'inconsistencyBound'];
function firstVectorLength(key: 'o' | 'c', otherwise: number): number {
  const f = path.join(runDir, 'designs.jsonl');
  if (!fs.existsSync(f)) return otherwise;
  const fd = fs.openSync(f, 'r');
  const buf = Buffer.alloc(1 << 16);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const m = new RegExp(`"${key}":\\[([^\\]]*)\\]`).exec(buf.subarray(0, n).toString('utf8'));
  return m ? m[1].split(',').filter((x) => x.trim() !== '').length : otherwise;
}
const goal = configJson && fs.existsSync(configJson) ? readJson(configJson).goal : undefined;
const front = rd('front.json') ?? {
  objectives: goal ? goal.objectives.map((o: any) => `${o.type} ${o.functionName}`) : ALL_OBJECTIVES.slice(0, firstVectorLength('o', ALL_OBJECTIVES.length)),
  constraints: goal ? goal.constraints.map((c: any) => c.functionName) : ALL_CONSTRAINTS.slice(0, firstVectorLength('c', ALL_CONSTRAINTS.length)),
  batches: [], seed: configSeed ?? 'realised/domain-neutral.model.json',
};
const KNOWN: Record<string, Partial<ObjectiveDef>> = {
  cost: { label: 'Cost', unit: 'cores', digits: 1, description: 'O1: container prices × the pods SimOxide\'s HPA ran over the measured window (replica-core-seconds), plus caches (metrics.fn::cost)' },
  failure: { label: 'Failures', unit: 'ppm', digits: 0, description: 'O2: failed outcomes per million sessions: sessions that need an unavailable failure source on their measured synchronous path (pathSets; shared fate, each release once per session, releases by operations), plus the failed runs of the asynchronous work they start, weighted by its process\'s criticality (copy maintenance 0).' },
  changeCoupling: { label: 'Change coupling', digits: 3, description: 'O3: containers touched per change (static, over the calls and the placement)' },
  inconsistency: { label: 'Inconsistency', digits: 3, description: 'O4: stale reads and writes to other containers per measured session, from the simulated call counts' },
  performance: { label: 'Slow requests', digits: 4, description: 'O5: share of the requests slower than their latency budget (C1\'s, 3 × today\'s p90), per request type from the simulated histograms, weighted by today\'s request mix, mean over the simulations; today\'s cut 0.029 in the day profile' },
};
const objectives: ObjectiveDef[] = front.objectives.map((s: string) => {
  const [dir, key] = s.split(' ');
  return { key, label: KNOWN[key]?.label ?? key, unit: KNOWN[key]?.unit, digits: KNOWN[key]?.digits ?? 3, description: KNOWN[key]?.description, direction: dir === 'MAXIMIZE' ? 'maximize' : 'minimize' };
});
const dirs = objectives.map((o) => o.direction);
const CONS: Record<string, Omit<ConstraintDef, 'key'>> = {
  latencyBudget: { label: 'Latency budget', description: `C1: Σ over request types of max(0, simulated ${evaluation.latency.statistic} / budget − 1); budget ${evaluation.latency.factor ?? '?'} × today's simulated ${evaluation.latency.statistic} under the ${profile} profile; 1000 when the simulation failed or was capped` },
  peakCapacity: { label: 'Peak capacity', description: `C2: the largest ${evaluation.peakCapacity.binS}-s bin utilisation of the database servers and the broker above ${evaluation.peakCapacity.limit}; 1 when the simulation failed` },
  cohesion: { label: 'Cohesion', description: 'C3: Σ over the services (classes in one container) and the database servers shared by services of the connected components of their classes in the domain\'s affinity graph − 1 (references, shared referrers, classes accessed together by at least two domain operations)' },
  changeCouplingBound: { label: 'Change coupling bound', description: 'C4: relative excess of O3 over the ObjectiveBound (factor × today\'s O3; metrics.fn::changeCouplingBound)' },
  inconsistencyBound: { label: 'Inconsistency bound', description: 'C5: relative excess of O4 over the ObjectiveBound (factor × today\'s O4; metrics.fn::inconsistencyBound)' },
};
const constraints: ConstraintDef[] = front.constraints.map((k: string) => ({ key: k, ...(CONS[k] ?? { label: k }) }));
const log: string = fs.existsSync(path.join(runDir, 'log.txt')) ? fs.readFileSync(path.join(runDir, 'log.txt'), 'utf8') : '';
const ops = /^operators \(\d+\): \[([^\]]*)\]/m.exec(log)?.[1].split(',').map((s) => s.trim()) ?? [];
// crossover (docs/search.md, Crossovers): its operators and the batch's counts, as the harness and core/platform/to_run.py log them
const xops = /^crossover operators \(\d+\): \[([^\]]*)\]/m.exec(log)?.[1].split(',').map((s) => s.trim()).filter(Boolean) ?? [];
const xcount = /crossovers: attempted (\d+), succeeded (\d+), fell back (\d+)/.exec(log);
const crossover = xops.length ? `${xops.map((p) => path.basename(p, '.mt')).join(', ')}${xcount ? `; ${xcount[2]} of ${xcount[1]} children crossed, ${xcount[3]} fell back to a copy` : ''}` : null;
const searchMs = +(/search took (\d+) ms/.exec(log)?.[1] ?? 0) || undefined;
const threads = +(/evaluation threads: (\d+)/.exec(log)?.[1] ?? 0) || undefined;
const batchLine = /batch 0: (\d+) solutions in the final front, (\d+) ms, (\d+) generations, (\d+) transformations tried, (\d+) operator slots skipped/.exec(log);

const same = (a: number[], b: number[]) => a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= 1e-9 * Math.max(1, Math.abs(x)));
const feasible = (c: number[]) => c.every((v) => v <= 1e-12);

const designs = new Map<string, Design>();
const byKey = new Map<string, Design>();
let evaluated = 0;
// read line by line: a run started far from the seed has long decision diffs (designs.jsonl > 512 MB, node's string limit)
function* readLines(file: string): Generator<string> {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1 << 24);
  const dec = new StringDecoder('utf8'); // keeps a character split between two reads
  let rest = '';
  try {
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) {
      const parts = (rest + dec.write(buf.subarray(0, n))).split('\n');
      rest = parts.pop()!;
      for (const l of parts) if (l) yield l;
    }
    rest += dec.end();
    if (rest) yield rest;
  } finally { fs.closeSync(fd); }
}
for (const line of readLines(path.join(runDir, 'designs.jsonl'))) {
  let e: { i: number; g: number; o: number[]; c: number[]; d: Record<string, string> };
  try { e = JSON.parse(line); } catch (err) { if (running) continue; throw err; } // a line being written
  evaluated++;
  const { decisions, metrics } = decisionsOf(e.d);
  // one design per distinct model decisions: the hash is over the model's decision links (finer
  // than the contract's decisions, which do not show, e.g., a schema's server inside a service or
  // the mechanism of a site whose access is local); it keys the detail cache
  const raw = modelDiff(e.d);
  const hash = modelHash(raw);
  const key = hash;
  const ex = byKey.get(key);
  if (ex) { ex.metrics.evaluations = (ex.metrics.evaluations ?? 1) + 1; continue; }
  const id = hash;
  const nd: Design = {
    id, runId, hash, objectives: e.o, constraints: e.c, feasible: feasible(e.c), born: e.g,
    metrics: { ...metrics, generation: e.g, evaluations: 1 }, hasDecisions: true, decisions,
    // the model's decision links that differ from the seed: the detail simulator rebuilds the model from them
    rawDecisions: raw,
  };
  designs.set(id, nd);
  byKey.set(key, nd);
}
// archive membership and leaving generation by objective vector
const archive = rd('archive.json');
const archiveIds: Id[] = [];
if (archive) {
  for (const a of archive.front) {
    const d = [...designs.values()].find((x) => x.feasible && same(x.objectives, a.o));
    if (d) { d.inArchive = true; d.died = null; archiveIds.push(d.id); }
  }
  for (const a of archive.left) {
    const d = [...designs.values()].find((x) => x.feasible && same(x.objectives, a.o) && !x.inArchive);
    if (d) d.died = a.died;
  }
}
// final population with its report values
const finalIds: Id[] = [];
const reportKeys = new Set<string>();
// the final population's models as the harness saved them (exactly the evaluated models): the detail simulates them as they are
const solutionModels: Record<Id, string> = {};
for (const s of front.batches[0] ?? []) {
  const d = [...designs.values()].find((x) => same(x.objectives, s.objectives));
  if (!d) continue;
  if (s.model && fs.existsSync(path.join(runDir, s.model))) solutionModels[d.id] = path.join(runDir, s.model);
  d.inFinalPopulation = true;
  Object.assign(d.metrics, s.report ?? {});
  Object.keys(s.report ?? {}).forEach((k) => reportKeys.add(k));
  finalIds.push(d.id);
}
// references: today's cut and the monolith, evaluated with the same metrics (core/tools/run-domain.sh step 3); a build may
// hold a committed realised seed instead (models/domain-<seed>-realised[-1sim].m, as the config names it)
const values = fs.existsSync(valuesFile) ? readJson(valuesFile) : {};
const REPORT_KEYS = ['modularity', 'replicas', 'utilisation', 'peakUtilisation', 'responseTime', 'simulationFailed', 'peakPods', 'createdPods', 'simulationWallMs'];
const refSpecs = all('ref').length ? all('ref') : ['today', 'monolith'].flatMap((l) => {
  const f = ['', '-realised-1sim', '-realised'].map((x) => path.join(buildDir, 'realised', `domain-${l}${x}.model.json`)).find((x) => fs.existsSync(x));
  return f ? [`${l}=${f}`] : [];
});
const references: { designId: Id; label: string }[] = [];
// the references' realised models: the detail simulator takes them as they are (rebuilding them from the
// neutral seed would misplace derived elements, whose generated names differ between realisations)
const referenceModels: Record<Id, string> = {};
for (const spec of refSpecs) {
  const [label, file] = spec.split('=');
  const model = readJson(path.resolve(file));
  const v = values[`realised/${path.basename(file)}`] ?? {};
  const diff = new Map([...linkMap(model, DECISION_PROPS)].filter(([k, t]) => seedLinks.get(k) !== t));
  const { decisions, metrics } = decisionsOf(diff);
  const hash = modelHash(modelDiff(diff));
  const o = objectives.map((x) => v[x.key] ?? NaN);
  const c = constraints.map((x) => v[x.key] ?? 0);
  const d: Design = byKey.get(hash) ?? { id: `ref-${label}`, runId, hash, objectives: o, constraints: c, feasible: feasible(c), metrics: { ...metrics }, hasDecisions: true, decisions, rawDecisions: modelDiff(diff) };
  d.reference = true;
  d.label = label;
  for (const k of REPORT_KEYS) if (typeof v[k] === 'number') d.metrics[k] = v[k];
  designs.set(d.id, d);
  references.push({ designId: d.id, label });
  referenceModels[d.id] = path.resolve(file);
}
const list = [...designs.values()];
const feas = list.filter((d) => d.feasible && d.objectives.every(Number.isFinite));
const r = ranks(feas.map((d) => minForm(d.objectives, dirs)));
feas.forEach((d, i) => (d.rank = r[i]));
list.filter((d) => !feas.includes(d)).forEach((d) => (d.rank = null));

// history: the population after each generation, design ids by objective vector
// (a running run: the generations of designs.jsonl as populations, until history_batch0.json exists)
const hist = (rd('history_batch0.json') ?? (running ? [...new Set(list.map((d) => d.born ?? 0))].sort((a, b) => a - b)
  .map((g) => list.filter((d) => d.born === g && !d.reference).map((d) => ({ o: d.objectives, c: d.constraints }))) : [])) as { o: number[]; c: number[] }[][];
const byO = new Map<string, Id>();
for (const d of list) { const k = d.objectives.map((x) => x.toPrecision(12)).join(','); if (!byO.has(k)) byO.set(k, d.id); }
// a platform run (core/platform/to_run.py): per generation the platform's counters and its own hypervolume, no populations
const platform = hist.length ? null : rd('platform_generations.json') as {
  hypervolume: { source: string; minimum?: number[]; reference?: number[] };
  generations: { index: number; evaluated: number; timeMs?: number; executedTransformations?: number; skippedOperatorSlots?: number; hypervolume: number | null }[];
} | null;
const platformGens = platform?.generations ?? null;
const history: Generation[] = platformGens
  ? platformGens.map((g) => ({ index: g.index, evaluated: g.evaluated, ...(g.timeMs != null ? { timeMs: g.timeMs } : {}),
    ...(g.executedTransformations != null ? { executedTransformations: g.executedTransformations, skippedOperatorSlots: g.skippedOperatorSlots ?? 0 } : {}), population: [] }))
  : hist.map((g, i) => ({
    index: i,
    evaluated: list.filter((d) => (d.born ?? 0) <= i).reduce((s, d) => s + (d.metrics.evaluations ?? 1), 0),
    population: g.map((p) => ({ o: p.o, c: p.c, d: byO.get(p.o.map((x) => x.toPrecision(12)).join(',')) })),
  }));
// hypervolume, box from the run's data (references included)
const pts = feas.map((d) => minForm(d.objectives, dirs));
let hv: Run['hypervolume'];
if (platform && platformGens?.some((g) => g.hypervolume !== null)) {
  // the platform's box: all generations' feasible fronts (minimisation form), the reference 10 % beyond their worst
  const box = platform.hypervolume.minimum && platform.hypervolume.reference ? { ideal: platform.hypervolume.minimum, nadir: platform.hypervolume.reference } : {};
  hv = { method: `the platform's own (${platform.hypervolume.source}): WFG hypervolume of each generation's feasible front, normalised to all generations' feasible fronts (reference 10 % beyond the worst); not comparable across runs`, ...box, population: platformGens.map((g) => g.hypervolume) };
} else if (pts.length) {
  // --box '{"ideal":[...],"nadir":[...],"label":"..."}' (minimised form): a box shared by several runs, so their hypervolumes compare
  const box = opt('box') ? JSON.parse(opt('box')!) as { ideal: number[]; nadir: number[]; label?: string } : undefined;
  const { ideal, nadir } = box ?? bounds(pts, dirs.length);
  const pop = history.map((g) => hypervolume(g.population.filter((p) => feasible(p.c)).map((p) => minForm(p.o, dirs)), ideal, nadir, 5000));
  const arch = archive ? [...archive.front.map((e: any) => ({ ...e, died: null })), ...archive.left] : [];
  const archHv = history.map((_, g) => hypervolume(arch.filter((e: any) => e.born <= g && (e.died === null || e.died > g)).map((e: any) => minForm(e.o, dirs)), ideal, nadir, 5000));
  hv = { method: `Monte Carlo on Halton samples (5 000), ${box ? `common box: ${box.label ?? 'given'}` : 'box from the run\'s feasible designs and references'}`, ideal, nadir, population: pop, archive: archive ? archHv : undefined };
}
const METRIC_LABELS: Record<string, { label: string; unit?: string; digits: number }> = {
  modularity: { label: 'Modularity', digits: 3 },
  replicas: { label: 'Pods (mean ready)', digits: 2 },
  utilisation: { label: 'Utilisation', digits: 3 },
  peakUtilisation: { label: 'Peak utilisation (C2)', digits: 3 },
  responseTime: { label: 'Response time', unit: 'ms', digits: 1 },
  simulationFailed: { label: 'Simulation failed', digits: 0 },
  peakPods: { label: 'Peak pods', digits: 0 },
  createdPods: { label: 'Created pods', digits: 0 },
  simulationWallMs: { label: 'Simulation wall time', unit: 'ms', digits: 0 },
  failureSync: { label: 'Failures, synchronous term', unit: 'ppm', digits: 0 },
  failureAsync: { label: 'Failures, asynchronous term', unit: 'ppm', digits: 0 },
  cohesionServices: { label: 'Cohesion, services', digits: 0 },
  cohesionServers: { label: 'Cohesion, database servers', digits: 0 },
};
const metricDefs: MetricDef[] = [
  { key: 'services', label: 'Services', digits: 0, better: 'none' },
  { key: 'databases', label: 'Database servers', digits: 0, better: 'none' },
  { key: 'crossSync', label: 'Cross-service sync accesses', digits: 0, better: 'lower' },
  { key: 'crossAsync', label: 'Cross-service async writes', digits: 0, better: 'none' },
  { key: 'copies', label: 'Local copies', digits: 0, better: 'none' },
  ...(trace.effectSites.length ? [{ key: 'joinedSteps', label: 'Joined effect steps', digits: 0, better: 'none' as const }, { key: 'inTxSteps', label: 'In-transaction effect steps', digits: 0, better: 'none' as const }] : []),
  { key: 'generation', label: 'Generation first seen', digits: 0, better: 'none' },
  { key: 'evaluations', label: 'Times evaluated', digits: 0, better: 'none' },
  ...[...reportKeys, ...REPORT_KEYS].filter((k, i, a) => a.indexOf(k) === i && (reportKeys.has(k) || list.some((d) => d.metrics[k] !== undefined))).map((k) => ({
    key: k, ...(METRIC_LABELS[k] ?? { label: k, digits: 3 }), better: (k === 'modularity' ? 'higher' : 'none') as MetricDef['better'],
  })),
];
// the config the run was made with: core/tools/run-domain.sh validates it into <build>/config-<name>.log
const configLog = path.join(buildDir, `config-${path.basename(runDir)}.log`);
const configPath = opt('config') ?? (fs.existsSync(configLog) ? /^\/(\S+\.config):/m.exec(fs.readFileSync(configLog, 'utf8'))?.[1] : undefined) ?? 'unknown';
const mtime = fs.statSync(path.join(runDir, running ? 'designs.jsonl' : 'front.json')).mtime;
// a platform run: its execution's id and times (core/platform/to_run.py)
const px = rd('platform_execution.json') as { id: string; startedAt?: string; finishedAt?: string } | null;
const pop = (front.batches[0] ?? []).length || hist[0]?.length || 0;
const run: Run = {
  contract: CONTRACT_VERSION, id: runId, name: opt('name') ?? `Domain sim-${profile} ${path.basename(runDir)}`,
  description: opt('description') ?? `Headless NSGA-II run of the domain problem (${configPath}): every design evaluated by one SimOxide simulation under the ${profile} profile; ${runDir}`,
  source: { kind: 'headless', location: runDir, ...(px ? { executionId: px.id } : {}) },
  problem: `sim-${profile}`, domainId: DOMAIN_ID, algorithm: 'NSGA-II', status: running ? 'running' : 'completed',
  ...(px?.startedAt && px.finishedAt
    ? { createdAt: px.startedAt, finishedAt: px.finishedAt, durationMs: Date.parse(px.finishedAt) - Date.parse(px.startedAt) }
    : { createdAt: new Date(mtime.getTime() - (searchMs ?? 0)).toISOString(), finishedAt: mtime.toISOString(), durationMs: searchMs }),
  populationSize: pop, generations: history.length, evaluated: platformGens?.at(-1)?.evaluated ?? evaluated, designCount: list.length, archiveSize: archiveIds.length,
  objectives, constraints, metrics: metricDefs,
  finalHypervolume: hv ? ((hv.archive ?? hv.population).at(-1) ?? undefined) ?? undefined : undefined,
  tags: ['headless', 'domain', 'simulated', profile, ...all('tag')],
  modelFingerprint: modelFingerprint(seedModel),
  config: {
    populationSize: pop, generations: history.length, batches: 1,
    operators: ops.map((p) => ({ name: path.basename(p, '.mt'), description: p })),
    mutationSteps: 'interval(1, 3)', crossover, threads,
    initialisation: [/initial designs: (.*)/.exec(log)?.[1], /initial walk: (.*)/.exec(log)?.[1]].filter(Boolean).join('; ') || undefined,
    evaluation,
    notes: batchLine ? `${batchLine[4]} transformations tried, ${batchLine[5]} operator slots skipped; search ${Math.round(+batchLine[2] / 1000)} s` : undefined,
    raw: { config: configPath, seed: front.seed, modelSeed: seedFile, buildDir: path.resolve(buildDir), seedValues: front.seedValues, referenceModels, solutionModels, log: log.split('\n').filter((l) => !l.startsWith('seed ')).join('\n') },
  },
  history, hypervolume: hv, archive: archiveIds, finalPopulation: finalIds, references,
};

fs.mkdirSync(path.join(out, 'domains'), { recursive: true });
fs.mkdirSync(path.join(out, 'runs', runId), { recursive: true });
fs.writeFileSync(path.join(out, 'domains', `${DOMAIN_ID}.json`), JSON.stringify(domain));
fs.writeFileSync(path.join(out, 'runs', runId, 'run.json'), JSON.stringify(run));
fs.rmSync(path.join(out, 'runs', runId, 'designs.json'), { force: true });
writeDesignsJsonl(path.join(out, 'runs', runId, 'designs.jsonl'), { contract: CONTRACT_VERSION, runId }, list);
console.log(`${runId}: ${run.evaluated} evaluated, ${list.length} distinct designs (${feas.length} feasible, ${list.filter((d) => d.rank === 0).length} on the front), archive ${archiveIds.length}, final ${finalIds.length}, references ${references.map((x) => x.label).join(', ')} -> ${out}`);
