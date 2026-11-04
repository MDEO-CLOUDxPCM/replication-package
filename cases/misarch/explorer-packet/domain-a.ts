/**
 * Adapter: package A's extraction (domain/misarch-domain.json) -> the contract's Domain.
 *
 * Kept: the 32 domain classes, references, the domain operations (copy-maintenance handlers are a
 * realisation of today's cut and are left out), their accesses, event topics, features, sagas and
 * the Gatling request types. Rates: request types from the msa mapping (x the design load factor),
 * operations from the request plans, event handlers from their publishers. Session types are not
 * in A's file; they are defined here over A's request types (package C's session model replaces them).
 */
import type { Access, Aggregate, Consistency, Domain, Id, Operation, OperationKind, RequestType, SessionType } from '../../../core/explorer/contract/types';
import { CONTRACT_VERSION } from '../../../core/explorer/contract/types';
import { mergeConsistency } from '../../../core/explorer/contract/consistency';
import { fromWorkload } from './workload-c';
import { files, rel } from './config';

/** design load 64.2 sessions/s = loadFactor 45.616 x the msa rates (misarch-kotlin.m) */
export const LOAD_FACTOR = 45.616;

/* eslint-disable @typescript-eslint/no-explicit-any */
type A = any;

const round = (v: number, d = 4) => Math.round(v * 10 ** d) / 10 ** d;

function perExecution(statements: unknown): number {
  if (typeof statements === 'number') return statements;
  if (typeof statements === 'string') {
    if (/^\d+(\.\d+)?$/.test(statements)) return +statements;
    if (statements.startsWith('1 if')) return 0.5;
    if (statements.startsWith('|')) return 3;
  }
  return 1;
}

function opKind(o: A): OperationKind {
  const t = o.trigger ?? {};
  if (t.graphql?.startsWith('Mutation.')) return 'mutation';
  if (t.graphql?.startsWith('Query.')) return 'query';
  if (t.graphql) return 'internal';
  return 'handler';
}

function opName(o: A): string {
  const id: string = o.id;
  const local = id.slice(id.indexOf('.') + 1);
  return local;
}

/** composition closure from roots: a class with no incoming composition roots an aggregate */
function aggregates(classes: Id[], refs: { from: Id; to: Id; kind: string }[]): Aggregate[] {
  const parent = new Map<Id, Id>();
  for (const r of refs) if (r.kind === 'composition') parent.set(r.from, r.to); // child.from -> parent.to
  const rootOf = (c: Id, seen = new Set<Id>()): Id => {
    const p = parent.get(c);
    if (!p || seen.has(c)) return c;
    seen.add(c);
    return rootOf(p, seen);
  };
  const groups = new Map<Id, Id[]>();
  for (const c of classes) groups.set(rootOf(c), [...(groups.get(rootOf(c)) ?? []), c]);
  return [...groups.entries()].map(([root, cs]) => ({ id: root, name: root, root, classes: [root, ...cs.filter((c) => c !== root)] }));
}

const SESSIONS: SessionType[] = [
  { id: 'browse', name: 'Browse', share: 0.38, thinkTimeS: 4, description: 'catalogue browsing without a purchase',
    steps: [{ request: 'users' }, { request: 'products', repeat: 2 }, { request: 'product', repeat: 3 }, { request: 'wishlistView', probability: 0.1 }] },
  { id: 'cart', name: 'Cart', share: 0.14, thinkTimeS: 5, description: 'adds to the cart, leaves before checkout',
    steps: [{ request: 'users' }, { request: 'products' }, { request: 'product', repeat: 2 }, { request: 'createShoppingcartItem', repeat: 2 }, { request: 'addToWishlist', probability: 0.2 }] },
  { id: 'buy', name: 'Buy', share: 0.3, thinkTimeS: 6, description: 'full purchase: cart, checkout, place order',
    steps: [{ request: 'users' }, { request: 'products' }, { request: 'product' }, { request: 'createShoppingcartItem' }, { request: 'address' }, { request: 'shipmentMethods' }, { request: 'paymentInformations' }, { request: 'createOrder' }, { request: 'placeOrder' }] },
  { id: 'abort', name: 'Aborted buy', share: 0.08, thinkTimeS: 6, description: 'checkout started, order created but never placed',
    steps: [{ request: 'users' }, { request: 'product' }, { request: 'createShoppingcartItem' }, { request: 'address' }, { request: 'shipmentMethods' }, { request: 'createOrder', probability: 0.6 }] },
  { id: 'account', name: 'Account', share: 0.09, thinkTimeS: 8, description: 'profile, order tracking, reviews',
    steps: [{ request: 'users' }, { request: 'address' }, { request: 'orderTracking' }, { request: 'createReview', probability: 0.1 }] },
  { id: 'admin', name: 'Admin', share: 0.01, thinkTimeS: 15, description: 'catalogue maintenance',
    steps: [{ request: 'adminCreateProduct', probability: 0.2 }, { request: 'adminCreateVariant', probability: 0.2 }, { request: 'adminNewPrice', probability: 0.5 }, { request: 'adminUpdateProduct', probability: 0.3 }] },
];

/** `workload`: package C's workload/sessions.json; without it the request types come from A and the sessions are placeholders */
export function fromMisarchDomain(a: A, workload?: A): Domain {
  const classIds: Id[] = a.classes.map((c: A) => c.name);
  const classSet = new Set(classIds);
  const domainOps: A[] = a.operations.filter((o: A) => o.domain);
  const opIds = new Set<Id>(domainOps.map((o) => o.id));

  // ---- rates
  const mapping: A[] = a.msaMapping?.operations ?? [];
  const reqRate = new Map<Id, number>();
  const rate = new Map<Id, number>();
  const demand = new Map<Id, { cpuMs: number; dbMs: number }>();
  for (const m of mapping) {
    const r = (m.rate ?? 0) * LOAD_FACTOR;
    if (m.request) reqRate.set(m.request, (reqRate.get(m.request) ?? 0) + r);
    else if (m.ops?.[0] && r > 0) rate.set(m.ops[0], (rate.get(m.ops[0]) ?? 0) + r);
    if (m.ops?.[0] && !demand.has(m.ops[0])) demand.set(m.ops[0], { cpuMs: m.cpuMs, dbMs: m.dbMs });
  }
  const wl = workload ? fromWorkload(workload, reqRate, opIds, new Map((a.requests ?? []).map((r: A) => [r.type, r.document]))) : null;
  if (wl) {
    // the operations' rates follow C's request rates (the msa rates only rank the client requests)
    rate.clear();
    for (const rq of wl.requests) for (const op of rq.operations) rate.set(op, (rate.get(op) ?? 0) + (rq.rate ?? 0));
  } else {
    for (const rq of a.requests ?? []) for (const p of rq.plan ?? []) rate.set(p.op, (rate.get(p.op) ?? 0) + (reqRate.get(rq.type) ?? 0));
  }
  // event handlers: publishers' rate x probability, propagated along the topics
  const topicSubs = new Map<string, Id[]>();
  for (const ev of a.events ?? []) topicSubs.set(ev.topic, (ev.subscribers ?? []).map((s: A) => s.op).filter((o: Id) => opIds.has(o)));
  for (let pass = 0; pass < 10; pass++) {
    const acc = new Map<Id, number>();
    for (const o of domainOps) for (const p of o.publishes ?? []) {
      const pr = typeof p.prob === 'number' ? p.prob : /fail|cancel|compensat/.test(p.topic) ? 0.02 : p.when ? 0.5 : 1;
      for (const s of topicSubs.get(p.topic) ?? []) acc.set(s, (acc.get(s) ?? 0) + (rate.get(o.id) ?? 0) * pr);
    }
    for (const [s, r] of acc) if (opKind(domainOps.find((o) => o.id === s)) === 'handler') rate.set(s, r);
  }

  // ---- operations
  const operations: Operation[] = domainOps.map((o) => {
    const byKey = new Map<string, Access>();
    const levels = new Map<string, Consistency[]>();
    // an access of the operation's own data in a copy table (`own`) is its home class's, keyed by the home below
    const addAccess = (x: A, cls: Id) => {
      const k = `${cls}|${x.mode}`;
      const pe = perExecution(x.statements);
      const ex = byKey.get(k);
      if (ex) ex.perExecution = round((ex.perExecution ?? 1) + pe, 3);
      else byKey.set(k, { class: cls, mode: x.mode, perExecution: pe });
      // (contract 1.13.0) a read's curated level (not strong: stale-ok), as derive's access groups:
      // not through a call, not from a payload; the group takes the strictest, with that level's rules and reasons
      if (x.mode === 'read' && x.today !== 'call' && x.today !== 'payload') (levels.get(k) ?? levels.set(k, []).get(k)!).push(x.strong && x.consistency
        ? { level: x.consistency.level, rules: x.consistency.rules, reason: x.consistency.reason, lock: x.op === 'lock' } : { level: 'stale-ok', lock: x.op === 'lock' });
    };
    for (const x of o.accesses ?? []) if (classSet.has(x.class) && !x.own) addAccess(x, x.class);
    const typeName = /^(?:_entities\()?(\w+)\)?/.exec(o.trigger?.graphql ?? '')?.[1];
    const homeOf = (accesses: Access[]) =>
      accesses.find((x) => x.mode === 'write')?.class ??
      (typeName && classSet.has(typeName) ? typeName : undefined) ??
      (o.accesses ?? []).find((x: A) => classSet.has(x.class) && !x.foreignToday)?.class ??
      accesses[0]?.class ??
      a.classes.find((c: A) => c.service === o.service)?.name ??
      classIds[0];
    const ownHome = homeOf([...byKey.values()]);
    for (const x of o.accesses ?? []) if (classSet.has(x.class) && x.own) addAccess(x, ownHome);
    for (const [k, ls] of levels) {
      const c = mergeConsistency(ls);
      const acc = byKey.get(k)!;
      if (c && c.level !== 'stale-ok') acc.level = c.level;
      if (c?.rules) acc.rules = c.rules;
      if (c?.reason) acc.reason = c.reason;
      if (c?.lock) acc.lock = true;
    }
    const joinedClasses = new Set<Id>();
    for (const t of a.transactions ?? []) if (t.op === o.id && t.multiClass) for (const c of t.classes) joinedClasses.add(c);
    for (const j of a.joins ?? []) if ((j.usedBy ?? []).includes(o.id)) for (const c of j.classes) joinedClasses.add(c);
    for (const acc of byKey.values()) if (joinedClasses.has(acc.class)) acc.joined = true;
    const accesses = [...byKey.values()];
    const homeClass = homeOf(accesses);
    const d = demand.get(o.id);
    const kind = opKind(o);
    return {
      id: o.id,
      name: opName(o),
      kind,
      feature: o.feature ?? undefined,
      homeClass,
      trigger: o.trigger?.topic ?? undefined,
      publishes: (o.publishes ?? []).map((p: A) => p.topic),
      rate: round(rate.get(o.id) ?? 0),
      cpuMs: d?.cpuMs ?? round(0.6 + 0.25 * accesses.length, 3),
      dbMs: d?.dbMs ?? round(0.1 * accesses.length, 3),
      accesses,
      description: o.note ? String(o.note).slice(0, 200) : undefined,
    };
  });

  const references = (a.references ?? []).filter((r: A) => classSet.has(r.from) && classSet.has(r.to)).map((r: A) => ({
    id: r.id, from: r.from, to: r.to, name: r.attr ?? undefined,
    kind: r.snapshot ? 'snapshot' : r.kind === 'composition' ? 'composition' : 'association',
    multiplicity: r.mult,
  })) as Domain['references'];

  const baseRequests: { type: Id; document?: string; ops: Id[]; rate: number }[] = wl
    ? wl.requests.map((r) => ({ type: r.id, document: r.document, ops: r.operations, rate: r.rate ?? 0 }))
    : (a.requests ?? []).map((r: A) => ({ type: r.type, document: r.document, ops: (r.plan ?? []).map((p: A) => p.op).filter((x: Id) => opIds.has(x)), rate: reqRate.get(r.type) ?? 0 }));
  const requests: RequestType[] = baseRequests.map((r) => {
    const ops = r.ops;
    const work = ops.reduce((s, id) => { const op = operations.find((x) => x.id === id)!; return s + (op.cpuMs ?? 1) + (op.dbMs ?? 0.3); }, 0);
    const accs = ops.reduce((s, id) => s + operations.find((x) => x.id === id)!.accesses.length, 0);
    return {
      id: r.type, name: r.type, document: r.document, operations: ops, rate: round(r.rate),
      budgetMs: Math.round(10 + 2 * work + 1.0 * accs),
    };
  });

  const events: Domain['events'] = (a.events ?? []).map((e: A) => ({
    id: e.topic, name: e.topic,
    publishers: (e.publishers ?? []).map((p: A) => p.op).filter((o: Id) => opIds.has(o)),
    subscribers: (e.subscribers ?? []).map((s: A) => s.op).filter((o: Id) => opIds.has(o)),
    class: e.publishers?.[0]?.payload?.find((c: Id) => classSet.has(c)),
  }));

  const today = new Map<string, Id[]>();
  for (const c of a.classes) today.set(c.service, [...(today.get(c.service) ?? []), c.name]);

  return {
    contract: CONTRACT_VERSION,
    id: 'misarch-kotlin',
    name: 'MiSArch (Kotlin)',
    version: String(a.meta?.commit ?? 'unknown').slice(0, 12),
    source: `${rel(files.extraction)} (package A) from ${a.meta?.source ?? 'misarch-kotlin'} @ ${String(a.meta?.commit ?? '').slice(0, 12)}${wl ? `; requests, sessions, load profiles: ${wl.source}, design load ${round(wl.designSessions, 2)} sessions/s` : '; sessions: explorer placeholders'}`,
    classes: a.classes.map((c: A) => ({
      id: c.name, name: c.name, sizeKb: c.rowBytes ? round(c.rowBytes / 1024, 3) : undefined, attributes: c.attributes,
      description: c.note ?? undefined,
    })),
    references,
    aggregates: [],
    operations,
    events,
    features: (a.features ?? []).map((f: A) => ({ id: f.code, code: f.code, name: f.name, operations: (f.operations ?? []).filter((o: Id) => opIds.has(o)) })),
    processes: (a.sagas ?? []).map((s: A) => ({
      id: s.name, name: s.name, trigger: s.trigger,
      steps: [s.trigger, ...(s.operations ?? []).filter((x: A) => x.role === 'step' && x.op !== s.trigger && opIds.has(x.op)).map((x: A) => x.op)],
    })),
    requests,
    sessions: wl ? wl.sessions : SESSIONS.map((s) => ({ ...s, steps: s.steps.filter((st) => requests.some((r) => r.id === st.request)) })),
    loadProfiles: wl?.profiles,
    cuts: [
      { id: 'today', name: `Today's ${today.size} services`, services: [...today.entries()].map(([name, classes]) => ({ name, classes })) },
      { id: 'monolith', name: 'Monolith', services: [{ name: 'monolith', classes: classIds }] },
    ],
  };
}

/** fills aggregates (composition closure) and assigns each class its aggregate */
export function withAggregates(d: Domain): Domain {
  const aggs = aggregates(d.classes.map((c) => c.id), d.references);
  const of = new Map<Id, Id>();
  for (const g of aggs) for (const c of g.classes) of.set(c, g.id);
  return { ...d, aggregates: aggs, classes: d.classes.map((c) => ({ ...c, aggregate: of.get(c.id) })) };
}

export function loadMisarchDomain(json: A, workload?: A): Domain {
  return withAggregates(fromMisarchDomain(json, workload));
}
