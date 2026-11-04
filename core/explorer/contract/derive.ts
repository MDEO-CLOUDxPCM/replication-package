import type { AccessMode, Decisions, Domain, EffectSite, EffectState, Id, Mechanism, Operation, SessionType } from './types';

export interface DerivedAccess {
  key: string;
  op: Id;
  cls: Id;
  mode: AccessMode;
  /** service the operation runs in */
  from: Id;
  /** service owning the class */
  to: Id;
  /**
   * the design's mechanism for an access to another service; null within the operation's own service (1.12.0: no
   * mechanism there, before `local`): placement "no hop"
   */
  mechanism: Mechanism | null;
  /** accesses per second at the reference load */
  rate: number;
}

export interface DerivedEdge {
  id: string;
  /** source and target class (for accesses: the operation's home class and the accessed class) */
  source: Id;
  target: Id;
  kind: 'reference' | 'access' | 'feed' | 'event';
  mechanism?: Mechanism;
  ops: Id[];
  rate: number;
}

export interface DerivedSaga {
  process: Id;
  style: 'choreography' | 'orchestration';
  services: Id[];
  orchestrator?: Id;
}

/** (1.4.0) an effect step in the design: the model's site with the design's state */
export interface DerivedEffect extends EffectSite {
  state: EffectState;
  from: Id;
  to: Id;
}

export interface DerivedDesign {
  /** (1.4.0) the effect steps (empty for a model without them) */
  effects: DerivedEffect[];
  serviceOf: Map<Id, Id>;
  opService: Map<Id, Id>;
  accesses: DerivedAccess[];
  /** class-level edges: references, cross-service accesses (by mechanism), copy feeds, events */
  edges: DerivedEdge[];
  sagas: DerivedSaga[];
  /** per service: operations running there */
  opsByService: Map<Id, Id[]>;
  /** per mechanism: count of cross-service accesses (accesses within a service have no mechanism) */
  mechanismCounts: Record<Mechanism, number>;
}

export const accessKey = (op: Id, cls: Id, mode: AccessMode) => `${op}|${cls}|${mode}`;
export const parseAccessKey = (k: string) => { const [op, cls, mode] = k.split('|'); return { op, cls, mode: mode as AccessMode }; };

/** default mechanism of a cross-service access the decisions do not list */
export function defaultMechanism(op: Operation, mode: AccessMode, inProcess: boolean): Mechanism {
  if (mode === 'write') return inProcess ? 'saga' : 'sync';
  return op.kind === 'query' ? 'join' : 'sync';
}

export function opRate(op: Operation): number {
  return op.rate ?? 0;
}

export function deriveDesign(domain: Domain, d: Decisions): DerivedDesign {
  const serviceOf = new Map<Id, Id>();
  for (const s of d.services) for (const c of s.classes) serviceOf.set(c, s.id);
  const opService = new Map<Id, Id>();
  const opsByService = new Map<Id, Id[]>(d.services.map((s) => [s.id, []]));
  for (const op of domain.operations) {
    const s = d.operationPlacement?.[op.id] ?? serviceOf.get(op.homeClass) ?? d.services[0]?.id;
    opService.set(op.id, s);
    opsByService.get(s)?.push(op.id);
  }
  const procOps = new Set(domain.processes.flatMap((p) => p.steps));
  const accesses: DerivedAccess[] = [];
  const mechanismCounts = { sync: 0, copy: 0, cache: 0, join: 0, saga: 0 } as Record<Mechanism, number>;
  for (const op of domain.operations) {
    const from = opService.get(op.id)!;
    for (const a of op.accesses) {
      const to = serviceOf.get(a.class) ?? from;
      const key = accessKey(op.id, a.class, a.mode);
      const mechanism: Mechanism | null =
        to === from ? null : (d.mechanisms[key] ?? defaultMechanism(op, a.mode, procOps.has(op.id)));
      if (mechanism) mechanismCounts[mechanism]++;
      accesses.push({ key, op: op.id, cls: a.class, mode: a.mode, from, to, mechanism, rate: opRate(op) * (a.perExecution ?? 1) });
    }
  }
  const edges: DerivedEdge[] = [];
  for (const r of domain.references) {
    edges.push({ id: `ref:${r.id}`, source: r.from, target: r.to, kind: 'reference', ops: [], rate: 0 });
  }
  // cross-service accesses, aggregated per (home class, class, mechanism)
  const opById = new Map(domain.operations.map((o) => [o.id, o]));
  const agg = new Map<string, DerivedEdge>();
  for (const a of accesses) {
    if (!a.mechanism) continue;
    const src = opById.get(a.op)!.homeClass;
    const id = `acc:${src}>${a.cls}:${a.mechanism}`;
    const e = agg.get(id) ?? { id, source: src, target: a.cls, kind: 'access' as const, mechanism: a.mechanism, ops: [], rate: 0 };
    if (!e.ops.includes(a.op)) e.ops.push(a.op);
    e.rate += a.rate;
    agg.set(id, e);
  }
  edges.push(...agg.values());
  // copy feeds: the copied class's writers publish, the copy holder (the reading op's home class) applies
  const feeds = new Map<string, DerivedEdge>();
  const writers = new Map<Id, Operation[]>();
  for (const op of domain.operations) for (const a of op.accesses) if (a.mode === 'write') {
    writers.set(a.class, [...(writers.get(a.class) ?? []), op]);
  }
  for (const a of accesses) {
    if (a.mechanism !== 'copy') continue;
    const holder = opById.get(a.op)!.homeClass;
    const id = `feed:${a.cls}>${holder}`;
    const ws = writers.get(a.cls) ?? [];
    const e = feeds.get(id) ?? { id, source: a.cls, target: holder, kind: 'feed' as const, ops: ws.map((w) => w.id), rate: ws.reduce((s, w) => s + opRate(w), 0) };
    feeds.set(id, e);
  }
  edges.push(...feeds.values());
  // (1.4.0) the effect steps with the design's state; an event step that is not an asynchronous message is a
  // synchronous step (inTx apart, or sync): drawn as a sync call, not as an event
  const effects: DerivedEffect[] = [];
  const stepOf = new Map<string, DerivedEffect>();
  for (const e of domain.effectSites ?? []) {
    const st = d.effects?.[e.id];
    if (!st) continue;
    const x: DerivedEffect = { ...e, state: st, from: opService.get(e.op) ?? '?', to: serviceOf.get(e.class) ?? '?' };
    effects.push(x);
    if (e.callee) stepOf.set(`${e.op}>${e.callee}`, x);
  }
  // domain events between services: publisher's home class -> handler's home class
  for (const ev of domain.events) {
    for (const p of ev.publishers) for (const s of ev.subscribers) {
      const po = opById.get(p), so = opById.get(s);
      if (!po || !so || opService.get(p) === opService.get(s)) continue;
      const step = stepOf.get(`${p}>${s}`);
      if (step && step.state.m !== 'async') edges.push({ id: `step:${ev.id}:${p}>${s}`, source: po.homeClass, target: so.homeClass, kind: 'access', mechanism: 'sync', ops: [p, s], rate: opRate(po) });
      else edges.push({ id: `ev:${ev.id}:${p}>${s}`, source: po.homeClass, target: so.homeClass, kind: 'event', ops: [p, s], rate: opRate(po) });
    }
  }
  const sagaStyle = new Map(d.sagas.map((s) => [s.process, s]));
  const sagas: DerivedSaga[] = [];
  for (const p of domain.processes) {
    // a transaction workflow of a home option not chosen is inert
    if (p.transaction?.home && p.transaction.home !== (d.homes?.[p.trigger] ?? domain.homes?.find((h) => h.op === p.trigger)?.written)) continue;
    if (p.transaction) {
      // a transaction workflow: a saga while one of its written classes sits in another service than the trigger
      const services = [...new Set([opService.get(p.trigger), ...p.transaction.writes.map((c) => serviceOf.get(c))].filter((x): x is Id => !!x))];
      if (services.length < 2) continue;
      const dec = sagaStyle.get(p.id);
      sagas.push({ process: p.id, style: dec?.style ?? 'choreography', services, orchestrator: dec?.orchestrator });
      continue;
    }
    const services = [...new Set(p.steps.map((o) => opService.get(o)!).filter(Boolean))];
    const writeServices = new Set(
      p.steps.flatMap((o) => (opById.get(o)?.accesses ?? []).filter((a) => a.mode === 'write').map((a) => serviceOf.get(a.class)!)),
    );
    if (writeServices.size < 2 && services.length < 2) continue;
    const dec = sagaStyle.get(p.id);
    sagas.push({ process: p.id, style: dec?.style ?? 'choreography', services, orchestrator: dec?.orchestrator });
  }
  return { effects, serviceOf, opService, accesses, edges, sagas, opsByService, mechanismCounts };
}

/** expected visits per request type of a session type (its steps' probability x repeat, summed per request) */
export function visitsOf(s: SessionType): Map<Id, number> {
  const m = new Map<Id, number>();
  for (const st of s.steps) m.set(st.request, (m.get(st.request) ?? 0) + (st.probability ?? 1) * (st.repeat ?? 1));
  return m;
}
