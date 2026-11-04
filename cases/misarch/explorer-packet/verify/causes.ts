/**
 * What an operation causes downstream, for the Verify tab (verify/causes.json, contract/verify.ts Causes): one row
 * per interaction of the model in the Interactions tab's terms (a fetch gets data of another class, an effect step runs a step of the work in
 * another class; a call of another operation by its consistency level; docs/model.md, Call sites), each joined with the code facts of package A's extraction it stands for:
 * the statements of a read or write, the publish of an event and the reaction's subscription, the provider's
 * registration, the call; a copy feed (the copy sync) this operation's writes feed, the publish only copy maintenance
 * subscribes to. The home class's own reads and writes are rows too (local); a code fact the model has no interaction
 * for (a payload read, a publish nothing reacts to, a call left out) is a row of its own with the reason, so every
 * fact of the code is checked.
 */
import type { Consistency, InputModel, ModelAccess, ModelOperation, ModelSite } from '../../../../core/explorer/contract/types';
import { callConsistency } from '../../../../core/explorer/contract/consistency';
import { cyrb53 } from '../../../../core/explorer/contract/hash';
import type { Cause, Causes } from '../../../../core/explorer/contract/verify';
import { parseEvidence, type Loc } from './claims';
import type { AAccess, AOperation, Extraction } from './extraction';

export type { Cause, CauseKind, Causes } from '../../../../core/explorer/contract/verify';

const TODAY: Record<string, string> = { local: 'same service', copy: 'local copy table', payload: 'from the event payload', call: 'through a call' };
/** an access of the operation's own data held in a copy table: the home's own data */
const OWN_IN_COPY = 'its own data in its copy table';
const n3 = (v: number) => Number(v.toPrecision(3)).toString();
const uniq = <T,>(xs: T[]) => [...new Set(xs)];
const evKey = (l: Loc) => `${l.path}:${l.line ?? ''}`;
function uniqEv(ls: Loc[]): Loc[] {
  const seen = new Set<string>();
  return ls.filter((l) => !seen.has(evKey(l)) && !!seen.add(evKey(l)));
}

/** an effect step's form: what it costs separated (envelope, commit), and whether today joins it (neither) */
function stepLine(sites: ModelSite[]): string[] {
  const st = sites.find((s) => s.effect?.step)?.effect;
  if (!st?.step) return [];
  const { envelopeMs, commitMs, estimate } = st.step;
  const joined = st.joined?.today === true ? '; joined in-transaction today: neither' : '';
  return [`separated: envelope ${n3(envelopeMs)} ms CPU${estimate ? ' (ESTIMATE)' : ''}, ${commitMs ? `commit ${n3(commitMs)} ms` : 'no commit'}${joined}`];
}

/**
 * a read's consistency as the row carries it: where curated (its rules and reason) or not stale-ok;
 * none for a read nobody curated (stale-ok: it decides no write or check), so those rows keep their fingerprints
 */
function readLevel(x: ModelAccess): { consistency: Consistency } | Record<string, never> {
  if (x.mode !== 'read' || !x.level || (!x.rules && x.level === 'stale-ok')) return {};
  return { consistency: { level: x.level, ...(x.rules ? { rules: x.rules } : {}), ...(x.reason ? { reason: x.reason } : {}), ...(x.lock ? { lock: true } : {}) } };
}
const callLevel = (c?: Consistency): { consistency: Consistency } | Record<string, never> => (c ? { consistency: c } : {});

/** the sites as written (a home option's sites only for the written option) */
const writtenIn = (model: InputModel) => model.sites.filter((s) => !s.home || s.home.written);

function siteSide(sites: ModelSite[]): { allowed: string[]; today?: string } {
  const allowed = uniq(sites.flatMap((s) => s.allowed));
  const today = uniq(sites.map((s) => s.today).filter(Boolean) as string[]);
  // no site: no decision, a plain synchronous access through the class's component (local while co-located)
  if (!sites.length) return { allowed: ['sync'], today: 'sync' };
  return { allowed: allowed.length ? allowed : ['sync'], today: today.join(' / ') || undefined };
}

/**
 * an access to the home class's own data is `own` (the explorer shows it with its fixed mechanism, a read sync, a write
 * in transaction). A row's fingerprint is taken over the older spelling `local`, so the marks made on these rows stay
 * (the claim is the same, only its word differs).
 */
export const OWN = 'own';
const OWN_WHILE = 'own data while';
function ownAsBefore(c: Omit<Cause, 'fp'>): Omit<Cause, 'fp'> {
  if (!c.allowed.includes(OWN) && !c.model.some((m) => m.startsWith(OWN_WHILE))) return c;
  return { ...c, allowed: c.allowed.map((m) => (m === OWN ? 'local' : m)), ...(c.today === OWN ? { today: 'local' } : {}),
    model: c.model.map((m) => (m.startsWith(OWN_WHILE) ? `local while${m.slice(OWN_WHILE.length)}` : m)) };
}

export function buildCauses(a: Extraction, model: InputModel, o: AOperation, mo: ModelOperation): Causes {
  const rows: Cause[] = [];
  const usedAcc = new Set<AAccess>();
  const usedCalls = new Set<number>();
  const usedPubs = new Set<string>();
  const add = (c: Omit<Cause, 'fp'>) => rows.push({ ...c, fp: cyrb53(JSON.stringify({ ...ownAsBefore(c), ev: c.ev.map(evKey) })) });
  // the code facts of one model access: same class, mode and reference (none for the class's rows)
  // an access of the operation's own data in a copy table is one of the home class's rows (derive's groups)
  const accOf = (cls: string, mode: 'read' | 'write', via?: string) => o.accesses.filter((x) => x.mode === mode && (x.own
    ? via === undefined && cls === mo.homeClass : x.class === cls && x.reference === via));
  const accCode = (xs: AAccess[]) => {
    const stmts = xs.map((x) => `${x.op ?? x.mode} ${x.shape}${x.own ? ` ${x.class}${x.reference ? ` (${x.reference})` : ''} in ${x.own}` : ''}${x.statements !== 1 ? ` ×${x.statements}` : ''}`);
    return [uniq(xs.map((x) => (x.own ? OWN_IN_COPY : TODAY[x.today] ?? x.today))).join(', '), ...uniq(stmts)].filter(Boolean);
  };

  // ---- itself: how the operation is reached, each with its mechanisms (the row of the caller's side, seen from here)
  const reqs = new Map(a.requests.map((r) => [r.type, r]));
  const aops = new Map(a.operations.map((x) => [x.id, x]));
  const reqEv = (r?: string) => { const rq = r ? reqs.get(r) : undefined; return { ev: rq ? parseEvidence(rq.evidence, 'request') : [], code: rq ? ['in the request\'s GraphQL document'] : [] }; };
  const callers = writtenIn(model).filter((s) => s.callee === o.id);
  // the invocation of another operation whose query resolves `callee` on the objects of `parent` (its `to` lists
  // both, `parents` links them): the model calls the field from the parent's SEFF for that call
  const nestedIn = (parent: string, callee: string) => {
    for (const x of a.operations) for (const c of x.calls) {
      const to = [c.to].flat(), i = to.indexOf(callee);
      if (i > 0 && c.parents?.[i] != null && to[c.parents[i]!] === parent) return { from: x.id, call: c };
    }
    return undefined;
  };
  // the root resolver of a request type: the gateway calls it
  for (const r of model.requests.filter((x) => x.plan[0]?.op === o.id)) {
    add({ key: `root:${r.id}`, kind: 'root', request: r.id, allowed: ['sync'], today: 'sync', model: ['the gateway calls the root resolver (sync only)'], ...reqEv(r.id) });
  }
  // a field: on the objects of the entry it is a field of, in that request
  for (const s of callers.filter((x) => x.kind === 'field')) {
    add({
      key: `fetched:${s.request}<${s.op}`, kind: 'fetched', op: s.op, request: s.request, ...siteSide([s]),
      model: [`this field, fetched on the objects of ${s.op}`, ...(s.planVia ? [`today's plan: ${s.planVia === 'gateway' ? 'a federation fetch by the gateway' : 'resolved by the service of the entry'}`] : [])],
      ...reqEv(s.request),
    });
  }
  // a reaction: the raises it reacts to
  for (const s of callers.filter((x) => x.kind === 'event')) {
    const sub = a.events.find((e) => e.topic === s.event)?.subscribers.find((x) => x.op === o.id);
    add({
      key: `reaction:${s.event}<${s.op}`, kind: 'reaction', op: s.op, topic: s.event, ...siteSide([s]),
      model: [`reacts to ${s.event} raised by ${s.op}`],
      ev: sub ? parseEvidence(sub.evidence, 'subscription') : [], code: sub ? [] : ['no subscription found'],
    });
  }
  // a provider callback: the operation that registers with the provider
  for (const s of callers.filter((x) => x.kind === 'callback')) {
    add({ key: `calledBack:${s.op}`, kind: 'calledBack', op: s.op, ...siteSide([s]), model: [`the provider calls back after ${s.op} registers (async only)`], ev: [], code: [] });
  }
  // a call of another operation (by its level, strict sync only, else a call site sync / cache)
  for (const c of model.operations.filter((x) => x.calls.some((y) => y.callee === o.id))) {
    const own = aops.get(c.id)?.calls.find((x) => [x.to].flat()[0] === o.id || (!x.parents && [x.to].flat().includes(o.id)));
    const nest = own ? undefined : nestedIn(c.id, o.id);
    const cc = own ?? nest?.call;
    const lv = callConsistency(c, o.id);
    add({
      key: `calledBy:${c.id}`, kind: 'calledBy', op: c.id, ...siteSide(callers.filter((s) => s.kind === 'call' && s.op === c.id)), ...callLevel(lv),
      model: [nest ? `resolved on the objects of ${c.id} in ${nest.from}'s call${lv?.level === 'strict' ? ' (strict: sync only)' : ''}` : `called by ${c.id}${lv?.level === 'strict' ? ' (strict: sync only)' : ''}`],
      ev: cc ? parseEvidence(cc.evidence, 'call') : [], code: cc ? [nest ? `${cc.how}: a field of ${nest.from}'s query` : cc.how] : [],
    });
  }
  if (o.trigger.schedule) add({ key: 'scheduled', kind: 'scheduled', allowed: [], model: [`a scheduled job (${o.trigger.schedule})`], ev: parseEvidence(o.entry, 'entry'), code: [] });

  // ---- what it does from its home: its own schema and what it causes. When the home is a decision, one list
  // for every option: each option has its own SEFF and sites, a row per interaction joins them (the mechanisms of
  // all options; a candidate's own reads and writes `local` while it is the home), today's mechanism the written one's
  const hd = model.homes?.find((h) => h.op === o.id);
  const written = hd?.written ?? mo.homeClass;
  const options = hd ? hd.options.map((x) => x.class) : [written];
  add({
    key: 'home', kind: 'home', cls: written, allowed: options, today: written,
    model: [hd ? `the home is a decision (AB38): ${options.length} classes it writes in one transaction; the chosen one's service runs it, the others' writes become effect steps`
      : 'the home (F2): the class it writes, else the class it reads, else its GraphQL type; its service runs it (no decision)'],
    ev: parseEvidence(o.entry, 'entry'), code: [`today's entry point in ${o.service}`],
  });
  const perHome = new Map<string, { home: string; c: Omit<Cause, 'fp'> }[]>();
  const forHome = (home: string, sites: ModelSite[]) => {
    const addH = (c: Omit<Cause, 'fp'>) => { if (!hd) { add(c); return; } perHome.set(c.key, [...(perHome.get(c.key) ?? []), { home, c }]); };
    // the home's own reads and writes: own data, its mechanism fixed (a candidate's while it is the home)
    const own = mo.accesses.filter((x) => x.class === home);
    for (const x of own) {
      const xs = accOf(home, x.mode, x.via);
      xs.forEach((y) => usedAcc.add(y));
      addH({
        key: `${x.mode}:${x.via ?? x.class}`, kind: x.mode, cls: x.class, ...(x.via ? { via: x.via } : {}), allowed: [OWN], today: OWN,
        model: [`${x.count !== 1 ? `${x.count} statements` : '1 statement'}${x.rows !== 1 ? ` of ${x.rows} rows` : ''}, ${n3(x.dbMs)} ms DB`, ...(x.lock ? ['a lock of its own class (a strict read, S5)'] : [])],
        ev: uniqEv(xs.flatMap((y) => parseEvidence(y.evidence))), code: accCode(xs),
      });
    }

    // reads and writes of other classes
    for (const x of mo.accesses) {
      if (x.class === home) continue;
      const ss = sites.filter((s) => s.kind === 'access' && s.class === x.class && s.mode === x.mode);
      const xs = accOf(x.class, x.mode, x.via);
      xs.forEach((y) => usedAcc.add(y));
      const tx = x.mode === 'write' ? o.transactions.filter((t) => t.classes.includes(x.class) && t.classes.includes(home)) : [];
      const bound = ss.some((s) => s.effect?.bound);
      addH({
        key: `${x.mode}:${x.via ?? x.class}`, kind: x.mode, cls: x.class, ...(x.via ? { via: x.via } : {}), ...siteSide(ss), ...readLevel(x),
        model: [`${x.count !== 1 ? `${x.count} statements` : '1 statement'}${x.rows !== 1 ? ` of ${x.rows} rows` : ''}, ${n3(x.dbMs)} ms DB`, ...(bound ? ['in the home class\'s transaction today'] : []), ...(x.mode === 'write' ? stepLine(ss) : [])],
        ev: uniqEv([...xs.flatMap((y) => parseEvidence(y.evidence)), ...tx.flatMap((t) => parseEvidence(t.evidence, 'transaction'))]),
        code: [...accCode(xs), ...(tx.length ? ['in one transaction with the home class'] : [])],
      });
    }

    // events: one row per raise and reaction
    const evs = new Map(a.events.map((e) => [e.topic, e]));
    for (const r of mo.raises) {
      const pubs = o.publishes.filter((p) => p.topic === r.event);
      if (pubs.length) usedPubs.add(r.event);
      const reactions = sites.filter((s) => s.kind === 'event' && s.event === r.event);
      const subs = evs.get(r.event)?.subscribers ?? [];
      for (const s of reactions.length ? reactions : [undefined]) {
        const sub = s && subs.find((x) => x.op === s.callee);
        addH({
          key: `event:${r.event}>${s?.callee ?? ''}`, kind: 'event', topic: r.event, op: s?.callee, p: r.probability,
          ...siteSide(s ? [s] : []), ...(s ? {} : { allowed: [] }),
          model: [s ? `p ${n3(r.probability)} per execution` : 'raised, no reaction in the model', ...(s ? stepLine([s]) : []), ...(s?.effect?.cascades ? [`the reaction: ${s.effect.cascades.sites} call sites${s.effect.cascades.raises.length ? `, raises ${s.effect.cascades.raises.join(', ')}` : ''}`] : [])],
          ev: uniqEv([...pubs.flatMap((p) => parseEvidence(p.evidence, 'publish')), ...(sub ? parseEvidence(sub.evidence, 'subscription') : [])]),
          code: [...pubs.map((p) => p.when ?? 'published always').filter(Boolean), ...(pubs.length ? [] : ['no publish found']), ...(s && !sub ? ['no subscription found'] : [])],
        });
      }
    }

    // provider callbacks: the registration with the provider
    const providerCalls = o.calls.map((c, i) => [c, i] as const).filter(([c]) => typeof c.to === 'string');
    for (const s of sites.filter((x) => x.kind === 'callback')) {
      providerCalls.forEach(([, i]) => usedCalls.add(i));
      addH({
        key: `callback:${s.callee}`, kind: 'callback', op: s.callee, ...siteSide([s]), ...(mo.effectCalls?.length ? { effect: mo.effectCalls } : {}),
        model: ['the provider calls back later (async only)', ...(mo.effectCalls?.length ? ['the registration is an effect call: sync only (E1)'] : [])],
        ev: uniqEv(providerCalls.flatMap(([c]) => parseEvidence(c.evidence, 'registration'))), code: providerCalls.map(([c]) => `registers with ${c.to} (${c.how})`),
      });
    }

    // the request's further fields resolved on this operation's objects: the root resolver's, or a field's
    // own fields; the mechanism is that of fetching the further field, not of this operation
    const isRoot = model.requests.some((r) => r.plan[0]?.op === o.id);
    for (const s of sites.filter((x) => x.kind === 'field')) {
      const rq = s.request ? reqs.get(s.request) : undefined;
      addH({
        key: `field:${s.request}>${s.callee}`, kind: 'field', op: s.callee, request: s.request, ...siteSide([s]),
        model: [isRoot ? `a further field of ${s.request}` : `a further field of ${s.request}, on the objects of this field`, ...(s.planVia ? [`today's plan: ${s.planVia === 'gateway' ? 'a federation fetch by the gateway' : isRoot ? 'resolved by the root\'s service' : 'resolved by this field\'s service'}`] : [])],
        ev: rq ? parseEvidence(rq.evidence, 'request') : [], code: rq ? ['in the request\'s GraphQL document'] : [],
      });
    }

    // calls of other operations (by the call's level, strict sync only, else its call site sync / cache)
    for (const c of mo.calls) {
      // a call of the operation (of a call into nested fields, its first field), else a field resolved on this
      // operation's objects in another operation's call
      const idx = o.calls.findIndex((x) => [x.to].flat()[0] === c.callee || (!x.parents && [x.to].flat().includes(c.callee)));
      const nest = idx >= 0 ? undefined : nestedIn(o.id, c.callee);
      const cc = idx >= 0 ? o.calls[idx] : nest?.call;
      if (idx >= 0) usedCalls.add(idx);
      const through = idx >= 0 && cc ? o.accesses.filter((x) => x.today === 'call' && x.evidence === cc.evidence) : [];
      through.forEach((x) => usedAcc.add(x));
      const nested = idx >= 0 && cc?.parents ? [cc.to].flat().filter((_, i) => i > 0) : [];
      const lv = callConsistency(mo, c.callee);
      addH({
        key: `call:${c.callee}`, kind: 'call', op: c.callee, ...siteSide(sites.filter((s) => s.kind === 'call' && s.callee === c.callee)), ...callLevel(lv),
        model: [`${c.count !== 1 ? `${c.count} calls` : '1 call'} per execution${lv?.level === 'strict' ? ', strict (sync only)' : ''}${nest ? `, on this operation's objects in ${nest.from}'s call` : ''}`],
        ev: cc ? parseEvidence(cc.evidence, 'call') : [],
        code: cc ? [`${cc.how}${nest ? `: a field of ${nest.from}'s query` : cc.purpose ? `: ${cc.purpose}` : ''}`,
          ...(nested.length ? [`one invocation; ${nested.join(', ')} resolved in the callee`] : []),
          ...(through.length ? [`reads ${uniq(through.map((x) => x.class)).join(', ')} through it`] : [])] : ['no call found'],
      });
    }
  };
  for (const home of [written, ...options.filter((x) => x !== written)]) forHome(home, model.sites.filter((x) => x.op === o.id && (!x.home || (hd ? x.home.class === home : x.home.written))));
  // one row per interaction over the options: today's (the written option's) side, the mechanisms of all
  for (const rs of perHome.values()) {
    const base = rs.find((r) => r.home === written) ?? rs[0];
    const own = rs.filter((r) => r.c.allowed.includes(OWN)).map((r) => r.home);
    const only = rs.length < options.length ? rs.map((r) => r.home) : [];
    const allowed = uniq(rs.flatMap((r) => r.c.allowed));
    add({
      ...base.c, allowed: [...allowed.filter((m) => m === OWN), ...allowed.filter((m) => m !== OWN)],
      today: base.home === written ? base.c.today : undefined,
      model: [...base.c.model, ...(own.length ? [`${OWN_WHILE} ${own.join(' or ')} is the home`] : []), ...(only.length ? [`only while ${only.join(' or ')} is the home`] : [])],
      ev: uniqEv(rs.flatMap((r) => r.c.ev)), code: uniq(rs.flatMap((r) => r.c.code)),
    });
  }

  // ---- copy feeds (the copy sync): a copy is fed by the writes of the data it holds, whose operation is the feed's
  // writer; today's code feeds it by a publish only copy maintenance subscribes to. One row per topic of this
  // operation's that feeds a copy, one per copied class whose feeds no publish of it does
  const events = new Map(a.events.map((e) => [e.topic, e]));
  const feeding = [...new Map(model.sites.filter((s) => s.copyFeed?.writers.some((w) => w.op === o.id)).map((s) => [s.id, s])).values()];
  const feedLine = (s: ModelSite) => `feeds the copy of ${s.class} at ${s.op}${s.request && s.request !== s.op ? ` (${s.request})` : ''}${s.today ? `, today ${s.today}` : ''}`;
  const notify = 'while a site is a copy, the copy sync adds a notification to this write (O2 counts it 0, O4 its staleness)';
  const fed = new Set<string>();
  for (const t of uniq(o.publishes.map((p) => p.topic))) {
    const fs = feeding.filter((s) => s.copyTopics?.some((x) => x.topic === t));
    if (!fs.length) continue;
    fs.forEach((s) => fed.add(s.id));
    const pubs = o.publishes.filter((p) => p.topic === t);
    const subs = events.get(t)?.subscribers ?? [];
    const copies = subs.filter((x) => x.copy);
    // a topic with a domain reaction keeps its own fact (a raise, or probability 0)
    if (subs.every((x) => x.copy)) usedPubs.add(t);
    const readers = uniq(fs.map((s) => aops.get(s.op ?? '')?.service).filter(Boolean) as string[]);
    const kept = new Set(copies.map((x) => x.service));
    add({
      key: `copy:${t}`, kind: 'copy', topic: t, cls: uniq(fs.map((s) => s.class)).join(', '), readers: uniq(fs.map((s) => s.op!)), ...siteSide(fs),
      model: [...fs.map(feedLine), notify],
      ev: uniqEv([...pubs.flatMap((p) => parseEvidence(p.evidence, 'publish')), ...copies.flatMap((x) => parseEvidence(x.evidence, 'subscription'))]),
      code: [...uniq(pubs.map((p) => p.when ?? 'published always')), ...[...kept].map((v) => `a copy in ${v}${readers.includes(v) ? '' : ' (no copy feed there)'}`),
        ...readers.filter((v) => !kept.has(v)).map((v) => `no copy in ${v} today`)],
    });
  }
  const unfed = feeding.filter((s) => !fed.has(s.id));
  for (const cls of uniq(unfed.map((s) => s.class!))) {
    const fs = unfed.filter((s) => s.class === cls);
    add({
      key: `copy:?${cls}`, kind: 'copy', cls, readers: uniq(fs.map((s) => s.op!)), ...siteSide(fs),
      ev: uniqEv(o.accesses.filter((x) => x.mode === 'write' && x.class === cls).flatMap((x) => parseEvidence(x.evidence))),
      model: [...fs.map(feedLine), 'F4: a copy is fed by every write of the data it holds, so this one too', notify],
      code: ['no publish of a topic that feeds it: today\'s copy misses this write (stays stale after it)'],
    });
  }

  // ---- code facts the model has no interaction for, each with the reason (one row per fact, sites of a fact merged)
  const facts = new Map<string, { what: string; why: string; ev: Loc[]; code: string[] }>();
  const fact = (key: string, what: string, why: string, ev: Loc[], code: string[]) => {
    const f = facts.get(key);
    if (f) { f.ev.push(...ev); f.code.push(...code); } else facts.set(key, { what, why, ev: [...ev], code: [...code] });
  };
  for (const x of o.accesses.filter((y) => !usedAcc.has(y))) {
    fact(`${x.mode}:${x.reference ?? x.class}`, `${x.mode} ${x.reference ?? x.class}`,
      x.today === 'payload' ? `the event's payload carries it${x.topic ? ` (${x.topic})` : ''}: the message brings the data, no access in the model`
        : `no access of ${x.reference ?? x.class} in the model (today ${TODAY[x.today] ?? x.today})`,
      parseEvidence(x.evidence), accCode([x]));
  }
  o.calls.forEach((c, i) => {
    if (usedCalls.has(i)) return;
    fact(`call:${[c.to].flat().join(',')}`, `calls ${[c.to].flat().join(', ')}`, 'no call in the model (left out)', parseEvidence(c.evidence, 'call'), [`${c.how}${c.purpose ? `: ${c.purpose}` : ''}`]);
  });
  for (const p of o.publishes.filter((x) => !usedPubs.has(x.topic))) {
    const subs = events.get(p.topic)?.subscribers ?? [];
    const domain = subs.filter((x) => aops.get(x.op)?.domain);
    const why = domain.length
      ? `the model raises it with probability 0 (a failure outcome, F5): ${domain.map((x) => x.op).join(', ')} is not reached from here`
      : subs.length ? `only copy maintenance subscribes (${subs.length} handlers), but no copy feed of the model has this operation as a writer`
        : 'no subscriber: nothing reacts to it';
    fact(`publish:${p.topic}`, `publishes ${p.topic}`, why, parseEvidence(p.evidence, 'publish'), [p.when ?? 'published always']);
  }
  for (const [key, f] of facts) add({ key: `code:${key}`, kind: 'code', allowed: [], model: [f.why], ev: uniqEv(f.ev), code: [f.what, ...uniq(f.code)] });
  return { rows };
}
