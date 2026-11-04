/**
 * The operations as a call graph of entry points and their downstream operations. Read from the
 * input model's SEFFs: every link is one call of a SEFF — the gateway's call of a root resolver, a request's further
 * field, an event raise → reaction, a provider callback, a call of another operation, an access to another
 * class — and every link with a decision is a call site with its allowed mechanisms. Nothing here is
 * invented: the kinds come from the SEFF parts, the mechanisms from the sites, the realisation rules (docs/model.md §5)
 * (middleware and broker only between containers, a ComposedCall only across containers) and the copy sync's copy feeds
 * (architecture.mm's local copies: a writer in the copy's own container sends nothing).
 */
import type { AccessMode, Id, InputModel, JoinBlocker, ModelOperation, ModelSeff, ModelSite } from '@contract/types';
import { JOIN_BLOCKER_SHORT } from '@contract/effects';
import { accessesName } from './accessName';
import type { T } from './text';

export type LinkKind = 'root' | 'field' | 'event' | 'callback' | 'call' | 'access' | 'db';

/** one call of a SEFF */
export interface CallLink {
  /** `<caller SEFF>#<part index>`: stable and unique */
  key: string;
  kind: LinkKind;
  from: Id;
  to: Id;
  /** the operation whose SEFF makes the call (none: the gateway) */
  caller?: Id;
  /** the operation called (op links) */
  op?: Id;
  /** accesses: the class and mode */
  cls?: Id;
  mode?: AccessMode;
  /** accesses: what the caller's accesses of that class and mode touch (`Class.reference`), when not just the class */
  what?: string;
  /** expected executions per execution of the caller (branch probability, loop count, raise probability) */
  p: number;
  async?: boolean;
  site?: ModelSite;
  /** the request whose SEFF this is (a root resolver's request SEFF) */
  request?: Id;
  /** a `db` link that is the transaction's commit on the home's schema (not an access: no own-data mechanism) */
  commit?: boolean;
  /** the call reaches B's step form (envelope, work, commit): `to` is the step's work, this the step form */
  step?: Id;
}

export interface Entry {
  op: Id;
  /** request: the root resolver of request types (queries, mutations, the registration reaction); callback: the external provider's HTTP callback; job: a scheduled job */
  kind: 'request' | 'callback' | 'job';
  /** the SEFFs it starts from: one per request type for a root resolver, its own SEFF otherwise */
  roots: { seff: Id; request?: Id }[];
  rate: number;
}

export interface CallGraph {
  ops: Map<Id, ModelOperation>;
  seffs: Map<Id, ModelSeff>;
  /** every call of a SEFF, in the SEFF's order (accesses, own schema, calls, fields, events, callbacks) */
  links(seff: Id): CallLink[];
  /** the calls of a SEFF into other operations */
  opLinks(seff: Id): CallLink[];
  entries: Entry[];
  entryOf: Map<Id, Entry>;
  /** the entry points that reach an operation (not itself), in the entries' order */
  reachedFrom: Map<Id, Id[]>;
  /** paths from entry points to an operation: the links from the entry's root SEFF down to it */
  paths(op: Id, max?: number): { entry: Id; links: CallLink[] }[];
  /** the copy sync: the copy sites a write of `cls` by `op` feeds */
  feedsOf(op: Id, cls: Id): ModelSite[];
}

const cache = new WeakMap<InputModel, CallGraph>();

export function callGraph(model: InputModel): CallGraph {
  const hit = cache.get(model);
  if (hit) return hit;
  const ops = new Map(model.operations.map((o) => [o.id, o]));
  const seffs = new Map(model.seffs.map((s) => [s.id, s]));
  const sites = new Map(model.sites.map((s) => [s.id, s]));
  const linkCache = new Map<Id, CallLink[]>();
  const links = (id: Id): CallLink[] => {
    let out = linkCache.get(id);
    if (out) return out;
    out = [];
    const s = seffs.get(id);
    if (s) s.parts.forEach((p, i) => {
      if (p.t !== 'call' || !p.to) return;
      let to = seffs.get(p.to);
      // an alternative home's own commit is a call into its own schema
      // a call into a database SEFF is its own schema (an alternative home's commit too, exported as `other`)
      const kind = (p.kind === 'commit' || to?.kind === 'db' || to?.kind === 'commit' ? 'db' : p.kind === 'other' || !p.kind ? 'call' : p.kind) as LinkKind;
      const l: CallLink = { key: `${id}#${i}`, kind, from: id, to: p.to, caller: s.op, p: p.p ?? 1, request: s.request };
      // through B's step form to the step's work: the tree shows what the step does, the step form is a mark
      const work = to?.kind === 'step' ? to.parts.find((x) => x.kind === 'work')?.to : undefined;
      if (work && seffs.has(work)) { l.step = p.to; l.to = work; to = seffs.get(work); }
      if (p.async) l.async = true;
      if (p.site) l.site = sites.get(p.site);
      if (kind === 'access' || kind === 'db') {
        l.cls = to?.class; l.mode = /^write/.test(p.name) ? 'write' : 'read';
        if (kind === 'db' && (p.kind === 'commit' || to?.kind === 'commit' || /^commit/.test(p.name))) l.commit = true;
        const what = l.cls && /^(read|write)/.test(p.name) ? accessesName(s.op ? ops.get(s.op) : undefined, l.cls, l.mode) : undefined;
        if (what && what !== l.cls) l.what = what;
      }
      else l.op = to?.op;
      out!.push(l);
    });
    linkCache.set(id, out);
    return out;
  };
  const opLinks = (id: Id) => links(id).filter((l) => l.op && l.kind !== 'access' && l.kind !== 'db');

  // entry points: the root resolvers of the request types' gateway plans, the provider callbacks, scheduled jobs
  const rootOf = new Set(model.requests.map((r) => r.plan.find((x) => x.via === 'root')?.op).filter(Boolean) as Id[]);
  const entries: Entry[] = [];
  for (const o of model.operations) {
    const kind: Entry['kind'] | null = rootOf.has(o.id) ? 'request' : o.kind === 'callback' ? 'callback' : o.kind === 'job' ? 'job' : null;
    if (!kind) continue;
    const roots = o.seffs.map((s) => seffs.get(s)).filter((s): s is ModelSeff => !!s && (!s.home || s.home.written)).map((s) => (s.request ? { seff: s.id, request: s.request } : { seff: s.id }));
    entries.push({ op: o.id, kind, roots, rate: o.rate });
  }
  const order = { request: 0, callback: 1, job: 2 };
  entries.sort((a, b) => order[a.kind] - order[b.kind] || b.rate - a.rate || a.op.localeCompare(b.op));
  const entryOf = new Map(entries.map((e) => [e.op, e]));

  const reached = new Map<Id, Id[]>();
  for (const e of entries) {
    const seen = new Set<Id>();
    const stack = e.roots.map((r) => r.seff);
    while (stack.length) {
      const s = stack.pop()!;
      if (seen.has(s)) continue;
      seen.add(s);
      for (const l of opLinks(s)) {
        if (l.op && l.op !== e.op) { const r = reached.get(l.op) ?? []; if (!r.includes(e.op)) r.push(e.op); reached.set(l.op, r); }
        stack.push(l.to);
      }
    }
  }

  const paths = (target: Id, max = 12) => {
    const out: { entry: Id; links: CallLink[] }[] = [];
    for (const e of entries) {
      if (out.length >= max) break;
      const walk = (s: Id, acc: CallLink[], onPath: Set<Id>) => {
        if (out.length >= max || acc.length > 14) return;
        for (const l of opLinks(s)) {
          if (onPath.has(l.to)) continue;
          if (l.op === target) { out.push({ entry: e.op, links: [...acc, l] }); if (out.length >= max) return; continue; }
          onPath.add(l.to);
          walk(l.to, [...acc, l], onPath);
          onPath.delete(l.to);
        }
      };
      if (e.op === target) continue;
      for (const r of e.roots) walk(r.seff, [], new Set([r.seff]));
    }
    return out;
  };

  const feeds = new Map<string, ModelSite[]>();
  for (const s of model.sites) for (const w of s.copyFeed?.writers ?? []) {
    const k = `${w.op}|${s.class}`;
    const list = feeds.get(k) ?? [];
    if (!list.includes(s)) list.push(s);
    feeds.set(k, list);
  }

  const g: CallGraph = { ops, seffs, links, opLinks, entries, entryOf, reachedFrom: reached, paths, feedsOf: (op, cls) => feeds.get(`${op}|${cls}`) ?? [] };
  cache.set(model, g);
  return g;
}

// ------------------------------------------------------------------------------------------------ realisation

/** where things live and which mechanism a site has: design A, or today's cut */
export interface Placement {
  /** "A" (with the design's label) or "today" */
  label: string;
  design: boolean;
  serviceOf(cls: Id): { id: Id; name: string } | undefined;
  mech(site: ModelSite): string | undefined;
  /** an effect step: joined in the caller's transaction, else why not */
  joinOf?(site: ModelSite): true | JoinBlocker | undefined;
  /** the chosen home class of an operation whose home is a decision (else its written one) */
  homeOf?(op: Id): Id | undefined;
}

/** a home option's SEFF stands for the chosen option's: the chosen class's SEFF of the same signature (the
 *  work, a reaction's step form, a request's root SEFF; itself when chosen) */
export function activeSeff(model: InputModel, g: CallGraph, seff: Id, pl: Placement): Id {
  const h = g.seffs.get(seff)?.home;
  if (!h) return seff;
  const chosen = pl.homeOf?.(h.op);
  if (!chosen || chosen === h.class) return seff;
  const opt = model.homes?.find((x) => x.op === h.op)?.options.find((o) => o.class === chosen);
  const sig = model.seffs.find((x) => x.id === seff)?.signature;
  return (opt?.seffs ?? []).find((s) => model.seffs.find((x) => x.id === s)?.signature === sig) ?? opt?.seff ?? seff;
}

/** a site in a home option's SEFF while another option is chosen: inert (no objective changes) */
export const inertSite = (s: ModelSite, pl: Placement) => !!s.home && (pl.homeOf?.(s.home.op) ?? (s.home.written ? s.home.class : undefined)) !== s.home.class;

export function todayPlacement(model: InputModel): Placement {
  const svc = new Map(model.classes.map((c) => [c.id, { id: c.service, name: c.service }]));
  const written = new Map((model.homes ?? []).map((h) => [h.op, h.today ?? h.written]));
  return { label: 'today', design: false, serviceOf: (c) => svc.get(c), mech: (s) => s.today, joinOf: (s) => s.effect?.joined?.today, homeOf: (op) => written.get(op) };
}

export type EventMark = 'broker' | 'no-event' | 'new-event' | 'feed';

export interface Realised {
  /** the mechanism of the call (a site's choice, or the only one) */
  mech: string;
  allowed: string[];
  /** whether there is a decision (a call site) */
  decided: boolean;
  /**
   * placement (contract Placement): caller and callee in one container, "no hop" (a service of a design is a container);
   * false: "remote → calleeSvc"; undefined: no caller class (the gateway)
   */
  together?: boolean;
  calleeSvc?: { id: Id; name: string };
  /** what the call is in this placement, in words */
  text: string;
  /** events: a broker event, an event that is gone (in-process or a sync call), a new one (a saga step), copy feeds */
  mark?: { kind: EventMark; text: string };
}

const KIND_ONLY: Partial<Record<LinkKind, string[]>> = { call: ['sync'], callback: ['async'], root: ['sync'], db: ['sync'] };

/** what a link is in a placement (docs/model.md, Call sites; architecture.mm's local copies) */
/** `t`: the packet's texts (the design references of the sync-only cases) */
export function realise(g: CallGraph, l: CallLink, pl: Placement, t?: T): Realised {
  const caller = l.caller ? g.ops.get(l.caller) : undefined;
  const callee = l.op ? g.ops.get(l.op) : undefined;
  // a home option's SEFF runs at its class
  const fromCls = g.seffs.get(l.from)?.home?.class ?? caller?.homeClass;
  const toCls = l.cls ?? g.seffs.get(l.to)?.home?.class ?? callee?.homeClass;
  const a = fromCls ? pl.serviceOf(fromCls) : undefined, b = toCls ? pl.serviceOf(toCls) : undefined;
  const together = a && b ? a.id === b.id : undefined;
  const allowed = l.site?.allowed ?? KIND_ONLY[l.kind] ?? ['sync'];
  const mech = (l.site && pl.mech(l.site)) ?? allowed[0];
  const base = { mech, allowed, decided: !!l.site, together, calleeSvc: b };
  // co-located (no hop): no middleware, no network, no receiving envelope, no broker
  const local = together !== false;
  // an effect step in its own transaction or joined
  if (l.site?.effect?.step && (l.kind === 'event' || (l.kind === 'access' && l.mode === 'write'))) {
    const j = pl.joinOf?.(l.site);
    const ev = l.kind === 'event';
    if (mech === 'inTx') return j === true
      ? { ...base, text: 'joined: a direct call in the caller\'s transaction (no envelope, commit or message)', ...(ev ? { mark: { kind: 'no-event' as const, text: 'no event (in the transaction)' } } : {}) }
      : { ...base, text: `in transaction not possible (${j ? JOIN_BLOCKER_SHORT[j] : local ? 'other DB server' : 'apart'}): a synchronous step, own transaction`, ...(ev ? { mark: { kind: 'no-event' as const, text: 'no event (a sync step)' } } : {}) };
    if (mech === 'sync') return { ...base, text: local ? 'synchronous step, a direct call (own transaction)' : 'synchronous step across the hop (own transaction)', ...(ev ? { mark: { kind: 'no-event' as const, text: 'no event (a sync step)' } } : {}) };
    if (mech === 'async') return local
      ? { ...base, text: 'in-process message (own transaction)', ...(ev ? { mark: { kind: 'no-event' as const, text: 'no broker event (co-located)' } } : {}) }
      : ev ? { ...base, text: 'message through the broker (own transaction)', mark: { kind: 'broker', text: 'broker event' } }
        : { ...base, text: 'message through the broker (own transaction)', mark: { kind: 'new-event', text: 'new event: the write goes through the broker' } };
  }
  switch (l.kind) {
    case 'root':
      return { ...base, text: 'the gateway calls the root resolver' };
    case 'db':
      return { ...base, text: 'own data (the home class\'s schema)' };
    case 'call':
      // a call without a site is sync only by its level: strict (or a field of a strict call's invocation)
      return { ...base, text: `${local ? 'direct call' : 'synchronous call'}${l.site ? '' : t?.('model.realise.strictCall', ' (strict: sync only)') || ' (strict: sync only)'}` };
    case 'field': {
      const t = local
        ? mech === 'cache' ? 'cache, a direct call on a miss' : mech === 'join' || mech === 'joinCache' ? 'the root resolver calls it directly (a join only across containers)' : 'direct call'
        : mech === 'join' ? 'gateway join (federation)' : mech === 'joinCache' ? 'gateway join with a cache' : mech === 'cache' ? 'cache, a call on a miss' : 'synchronous call from the root resolver';
      return { ...base, text: t };
    }
    case 'event':
      if (mech === 'async') return local
        ? { ...base, text: 'in-process, asynchronous', mark: { kind: 'no-event', text: 'no broker event (co-located)' } }
        : { ...base, text: 'event through the broker', mark: { kind: 'broker', text: 'broker event' } };
      return { ...base, text: local ? 'direct call' : 'synchronous call', mark: { kind: 'no-event', text: local ? 'no event (co-located, sync)' : 'no event (a sync call)' } };
    case 'callback':
      return { ...base, text: local ? 'in-process, asynchronous' : 'asynchronous call' };
    case 'access': {
      if (l.mode === 'write') {
        if (mech === 'async') return local
          ? { ...base, text: 'in-process, asynchronous write' }
          : { ...base, text: 'asynchronous saga step', mark: { kind: 'new-event', text: 'new event: the write goes through the broker' } };
        return { ...base, text: local ? 'direct write' : 'synchronous saga step' };
      }
      if (mech === 'copy') {
        const carried = l.site?.copyFeed && !l.site.copyFeed.writers.length;
        if (carried) return { ...base, text: 'local copy that comes with the saga message (no feed)' };
        return local
          ? { ...base, text: 'local copy in the same container: its own data, no feed' }
          : { ...base, text: 'local copy (stale), fed by events', mark: { kind: 'feed', text: `new events: every write of ${l.cls} by ${l.site?.copyFeed?.writers.length ?? 0} operation(s) feeds it` } };
      }
      if (mech === 'cache') return { ...base, text: local ? 'cache, a direct read on a miss' : 'cache, a call on a miss' };
      return { ...base, text: `${local ? 'direct read' : 'synchronous read'}${l.site ? '' : t?.('model.realise.noSite', ' (strict: no call site, sync only)') || ' (strict: no call site, sync only)'}` };
    }
  }
}

/** copy feeds a write causes in a placement: the copies of `cls` read as copies in another service than `cls` */
export function feedsInPlacement(g: CallGraph, op: Id, cls: Id, pl: Placement): { site: ModelSite; reader: ModelOperation; svc?: { id: Id; name: string } }[] {
  const own = pl.serviceOf(cls);
  return g.feedsOf(op, cls).flatMap((s) => {
    if (pl.mech(s) !== 'copy') return [];
    const reader = s.op ? g.ops.get(s.op) : undefined;
    if (!reader) return [];
    const svc = pl.serviceOf(reader.homeClass);
    return svc && own && svc.id === own.id ? [] : [{ site: s, reader, svc }];
  });
}

export const LINK_LABEL: Record<LinkKind, string> = {
  root: 'root resolver', field: 'field', event: 'event', callback: 'provider callback', call: 'call', access: 'access', db: 'own data',
};
