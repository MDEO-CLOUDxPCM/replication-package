import { useMemo, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import type { InputModel, JoinBlocker, ModelSite } from '@contract/types';
import { JOIN_BLOCKER_LABEL, JOIN_BLOCKER_SHORT } from '@contract/effects';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ScrollArea } from '@/components/ui/scroll-area';
import { workspaceActions } from '@/lib/useWorkspace';
import { cn } from '@/lib/utils';
import { SequenceDiagram, type LaneDef, type Step } from './SequenceDiagram';
import { useDoc, type TextVars } from '@/lib/packet';
import { OwnData, PLACEMENT_ABOUT, PlacementBadge } from '@/components/PlacementBadge';
import { EffectCallChip, LevelChip, LockMark } from '@/components/LevelChip';
import { CONSISTENCY_LEVELS } from '@contract/types';
import { EFFECT_ABOUT, LEVEL_ABOUT, LOCK_ABOUT, callConsistency, readConsistency } from '@contract/consistency';
import { MechChip, ModelLink, Section, useMechLabel } from './shared';
import { MText, fill, nodeVar, useT } from './text';

/**
 * Every way two operations of the model interact, with the mechanisms a design may choose for it, as sequence
 * diagrams (docs/model.md, Call sites): the kinds grouped by what they are for (fetch gets
 * data of another class, effect runs a step of the work in another class), one card per mechanism, each with the
 * diagrams it needs, and every lifeline inside the box of where it runs (a service, the gateway, a database server,
 * the broker). The mechanisms are shown as the open model realises them; costs are its parameters.
 */

type KindId = 'fixed' | 'home' | 'read' | 'effect' | 'field' | 'saga';
/** accepts the older kind ids (`mech:write` …): one effect step */
const KIND_ALIAS: Record<string, KindId> = { write: 'effect', event: 'effect', callback: 'effect' };
/** what an interaction is for; `none`: no decision, `chain`: the coordination of a chain of effects */
type FamilyId = 'none' | 'fetch' | 'effect' | 'chain';
interface Diagram { caption: string; lanes: LaneDef[]; steps: Step[] }
/** `mech` the card's mechanism; none: own data, shown with its fixed mechanisms (a read sync, a write in transaction) */
interface Card { id: string; mech?: string; sub?: string; text: string; diagrams: Diagram[] }
interface Kind {
  id: KindId; family: FamilyId; title: string; where: string; ref?: string; options: string[];
  /** what the interaction is */
  what: string;
  /** where it comes from in the case (markup) */
  examples: string;
  /** the node variables of the examples (lists of links) */
  nodes?: Record<string, ReactNode>;
  /** what the choice changes */
  effect: string;
  cards: Card[];
}

/** the packet's doc `interactions`: per kind its texts (templates over the variables kinds() computes) */
interface KindDoc { where?: string; ref?: string; what?: string; examples?: string; effect?: string; cards?: Record<string, string>; vars?: Record<string, { calls?: string; compensations?: string }> }
/** the placement badges (no hop, remote, own data) explained once: markup templates over the intro's variables */
interface PlacementDoc { title?: string; intro?: string; noHop?: string; remote?: string; own?: string }
/** the consistency levels and their rules explained once: markup over the counts the tab computes */
interface ConsistencyDoc { title?: string; intro?: string; lock?: string; effect?: string }
interface InteractionsDoc { intro?: string[]; placement?: PlacementDoc; consistency?: ConsistencyDoc; kinds?: Partial<Record<KindId, KindDoc>>; lanes?: { trigger?: string } }

/** without a packet: the header, in general */
const INTRO = [
  'Every way one operation reaches another class or operation, with the mechanisms a design may choose for it. Each lifeline sits in the box of where it runs: a **service** (an application container with the components of its classes), the **gateway**, a **DB server** (with the schemas placed on it) or the **broker**. Coloured arrows cross containers through the sidecars: a synchronous hop costs {{callerCpuMs}} ms CPU on the caller\'s sidecar, {{latencyMs}} ms latency and {{calleeCpuMs}} ms on the callee\'s; an asynchronous message {{publishCpuMs}} ms to publish, the broker, and {{deliverCpuMs}} ms to deliver{{#networkMs}}; between pods on different nodes each message adds {{networkMs}} ms of network delay (two per hop){{/networkMs}}. Database servers are reached directly. Dashed arrows are answers, open heads asynchronous messages; **alt** frames are branches, **async** frames run in the background. Values are this model\'s parameters ([Overview](how)).',
  'The kinds are grouped by what an interaction is **for**: a **fetch** gets data of another class and the caller needs the answer (sync, cache, a copy fed by replication, join); an **effect** runs a step of the work in another class: one **effect step**, in the caller\'s transaction, a synchronous step or an asynchronous message (a chain of steps not in one transaction is a saga). "Another class" is relative to the operation\'s home class, where it starts.',
];

const num = (v: unknown, d = 3) => (typeof v === 'number' ? String(+v.toFixed(d)) : '?');

function StyleChip({ m }: { m: string }) {
  return <span className="inline-flex items-center rounded border bg-card px-1.5 py-px text-[10.5px] leading-tight text-foreground">{m}</span>;
}
const Op = ({ id }: { id: string }) => <ModelLink target={`op:${id}`} className="font-mono text-[10.5px]">{id}</ModelLink>;
const Cls = ({ id }: { id: string }) => <ModelLink target={`class:${id}`}>{id}</ModelLink>;
const chip = (m: string) => (m === 'choreography' || m === 'orchestration' ? <StyleChip key={m} m={m} /> : <MechChip key={m} m={m} active />);

// where a lifeline runs
const SVC_A = 'service of A';
const SVC_B = 'service of B';
const DB_A = 'DB server of A';
const DB_B = 'DB server of B';
const BROKER = 'broker';
const GW = 'gateway container';
const ONE = 'one service (A and B)';

function kinds(model: InputModel, doc: InteractionsDoc | undefined): Kind[] {
  const prop = (cls: string, name: string | null, p: string) => model.parameters.find((x) => x.class === cls && (name === null || x.name === name))?.properties[p];
  const rc = (p: string) => num(prop('RemoteCalls', null, p));
  const asBuilt = model.sites.some((s) => s.cachedService);
  const siteHits = model.sites.some((s) => s.hitRatio !== undefined);
  const ratio = siteHits ? 'hit, p = the site\'s hit ratio' : `hit, p = ${num(prop('CachedCall', 'cache', 'hitRatio'), 2)}`;
  const cacheHit = num(prop('CachedCall', 'cache', 'hitCpuMs'));
  const compose = num(prop('ComposedCall', 'join', 'composeCpuMs'));
  const jcHit = num(prop('ComposedCall', 'joinCache', 'hitCpuMs'));
  const readDb = num(prop('LocalCopy', null, 'readDbMs'));
  const readCpu = prop('LocalCopy', null, 'readCpuMs');
  const writeCpu = num(prop('LocalCopy', null, 'writeCpuMs'));
  const writeDb = num(prop('LocalCopy', null, 'writeDbMs'));
  const step = num(prop('Orchestrated', null, 'stepCpuMs'));
  const wSync = num(prop('Consistency', null, 'syncWriteWeight'));
  const wAsync = num(prop('Consistency', null, 'asyncWriteWeight'));
  const pub = `publish ${rc('publishCpuMs')} ms`;
  const del = `deliver ${rc('deliverCpuMs')} ms`;
  const count = (pred: (s: InputModel['sites'][number]) => boolean) => todaySites(model).filter(pred).length;
  // the effect steps as built: envelope per step form (flagged when an estimate), commit wait, joined today
  const steps = model.sites.flatMap((s) => (s.effect?.step ? [s.effect.step] : []));
  const envs = [...new Map(steps.map((x) => [x.seff, x.envelopeMs])).values()];
  const envRange = envs.length ? range(envs) : '?';
  const estimate = steps.some((x) => x.estimate);
  const commitMs = num(prop('Latency', null, 'commitDelayMs'));
  const joinedToday = count((s) => s.effect?.joined?.today === true);
  // (1.11.0) the receiving envelope a synchronous call across containers pays in the callee's container
  const recvs = (model.envelopes ?? []).map((e) => e.ms);
  const recv = recvs.length > 0;
  const recvRange = recv ? range(recvs) : '?';
  const recvEst = (model.envelopes ?? []).some((e) => e.estimate);

  const L = (id: string, title: string, sub: string | undefined, group?: string): LaneDef => ({ id, title, sub, group });
  // the read or write of class B through its component: the access operation maps, the schema runs the statements
  const access = (from: string, label: string, remote: boolean, answer = 'result'): Step[] => [
    { msg: [from, 'b'], label, remote: remote ? 'sync' : undefined },
    { note: 'b', text: 'access operation:\nmapping (app side)' },
    { msg: ['b', 'bdb'], label: 'statements' },
    { msg: ['bdb', 'b'], label: 'rows', ret: true },
    { msg: ['b', from], label: answer, ret: true, remote: remote ? 'sync' : undefined },
  ];
  const apart = (op: string, opSub: string): LaneDef[] => [L('op', op, opSub, SVC_A), L('b', 'class B', 'component', SVC_B), L('bdb', 'B\'s schema', undefined, DB_B)];
  const together = (op: string, opSub: string): LaneDef[] => [L('op', op, opSub, ONE), L('b', 'class B', 'component', ONE), L('bdb', 'B\'s schema', undefined, DB_B)];
  // B's step form: the receiving envelope, a direct call into the work, B's commit
  const stepForm = (b: string, bdb: string): Step[] => [
    { note: b, text: `step form: envelope\n${envRange} ms CPU${estimate ? ' (ESTIMATE)' : ''}` },
    { note: b, text: 'B\'s work' },
    { msg: [b, bdb], label: 'statements' },
    { msg: [b, bdb], label: `B's commit (${commitMs} ms wait)` },
  ];

  // request fields
  const fieldLanes = (oneService: boolean): LaneDef[] => [
    L('client', 'client', 'browser, load generator'),
    L('gw', 'gateway', 'request plan', GW),
    L('root', 'root resolver', 'top-level field', oneService ? 'one service (both)' : 'root\'s service'),
    L('prov', 'field resolver', 'the further field', oneService ? 'one service (both)' : 'field\'s service'),
    L('db', 'field\'s schema', undefined, 'field\'s DB server'),
  ];
  const start: Step[] = [
    { msg: ['client', 'gw'], label: 'GraphQL request' },
    { msg: ['gw', 'root'], label: 'root field', remote: 'sync' },
    { note: 'root', text: 'own work, own class\'s schema' },
  ];
  const resolve = (to: string, remote: boolean): Step[] => [
    { note: 'prov', text: 'field resolver: own work' },
    { msg: ['prov', 'db'], label: 'statements' },
    { msg: ['db', 'prov'], label: 'rows', ret: true },
    { msg: ['prov', to], label: 'field', ret: true, remote: remote ? (to === 'gw' ? 'join' : 'sync') : undefined },
  ];
  const fetch: Step = { msg: ['gw', 'prov'], label: '_entities fetch (reference)', remote: 'join' };
  const back: Step = { msg: ['gw', 'client'], label: 'response', ret: true };
  const answer = (what: string): Step => ({ msg: ['root', 'gw'], label: what, ret: true, remote: 'sync' });
  const localField: Diagram = {
    caption: 'Both classes in one container (no hop): the root resolver resolves the field itself',
    lanes: fieldLanes(true),
    steps: [...start, { msg: ['root', 'prov'], label: 'direct call' }, ...resolve('root', false), answer('answer with the field'), back],
  };

  const sagas = model.processes.filter((p) => !p.transaction);
  const txs = model.processes.filter((p) => p.transaction && (!p.transaction.home || p.transaction.home.written));
  // the variables of the doc's templates (packets' docs/interactions)
  const V: TextVars = {
    cacheHit, compose, jcHit, readDb, readCpu: typeof readCpu === 'number' ? num(readCpu) : '', writeCpu, writeDb, step, wSync, wAsync, pub, del,
    latencyMs: rc('latencyMs'), commitMs, envRange, estimate, siteHits, asBuilt, joinedToday, recv, recvRange, recvEst,
    ttl: num(prop('Consistency', null, 'cacheTtlSeconds')), lag: num(prop('Consistency', null, 'replicationLagSeconds')), copyCoupling: num(prop('LocalCopy', null, 'couplingWeight')),
    readCache: count((s) => s.kind === 'access' && s.mode === 'read' && s.allowed.includes('cache')),
    // strict reads that today's code serves from the reader's own copy: sync / copy
    readStrict: count((s) => s.kind === 'access' && s.mode === 'read' && !s.allowed.includes('cache')),
    callSites: count((s) => s.kind === 'call'),
    writesOther: count((s) => s.kind === 'access' && s.mode === 'write'), bound: count((s) => s.effect?.bound === true),
    events: count((s) => s.kind === 'event'), callbacks: count((s) => s.kind === 'callback'), inTxSites: count((s) => s.allowed.includes('inTx')),
    fieldSites: count((s) => s.kind === 'field'), fetchSites: model.sites.filter((x) => x.fetchService).length,
    homes: model.homes?.length ?? 0, homeOptions: (model.homes ?? []).reduce((a, h) => a + h.options.length, 0),
    homeList: model.homes?.length ? nodeVar('homeList') : '', sagaIds: sagas.map((p) => p.id).join(', '), txs: txs.length,
    sagaList: sagas.length ? nodeVar('sagaList') : '', txList: txs.length ? nodeVar('txList') : '',
  };
  // the lists of links in the examples, as React nodes
  const nodes: Record<string, ReactNode> = {
    homeList: (model.homes ?? []).map((h, i) => <span key={h.op}>{i > 0 && '; '}<Op id={h.op} />: {h.options.map((o, j) => <span key={o.class}>{j > 0 && ', '}<Cls id={o.class} />{o.class === h.written ? ' (today)' : ''}</span>)}</span>),
    sagaList: sagas.map((p, i) => <span key={p.id}>{i > 0 && '; '}{p.id}: {p.steps.length} steps from <Op id={p.trigger} /></span>),
    txList: txs.map((p, i) => <span key={p.id}>{i > 0 && '; '}<Op id={p.trigger} /> writes {p.transaction!.writes.map((c, j) => <span key={c}>{j > 0 && ', '}<Cls id={c} /></span>)}</span>),
  };
  const K = (k: KindId) => doc?.kinds?.[k];
  // a kind's own variables: the calls of an operation, the compensations of a process
  const vk = (k: KindId): TextVars => ({ ...V, ...Object.fromEntries(Object.entries(K(k)?.vars ?? {}).map(([n, q]) => [n,
    q.calls ? model.operations.find((o) => o.id === q.calls)?.calls?.length : q.compensations ? model.processes.find((p) => p.id === q.compensations)?.compensations.length : undefined])) });
  const F = (k: KindId, f: 'where' | 'what' | 'examples' | 'effect') => fill(K(k)?.[f], vk(k));
  const C = (k: KindId, c: string) => fill(K(k)?.cards?.[c], vk(k));

  return [
    {
      id: 'fixed', family: 'none', title: 'Without a decision', where: F('fixed', 'where'), ref: K('fixed')?.ref, options: ['sync'],
      what: F('fixed', 'what'),
      examples: F('fixed', 'examples'),
      effect: F('fixed', 'effect'),
      cards: [
        {
          id: 'own', sub: 'access to the home class: no call site; a read sync, a write in the operation\'s own transaction',
          text: C('fixed', 'own'),
          diagrams: [{ caption: 'An operation reads or writes its home class A', lanes: [L('op', 'operation', 'home class A', SVC_A), L('adb', 'A\'s schema', undefined, DB_A)], steps: [{ note: 'op', text: 'own work' }, { msg: ['op', 'adb'], label: 'statements (direct)' }, { msg: ['adb', 'op'], label: 'rows', ret: true }] }],
        },
        {
          id: 'strict', mech: 'sync', sub: 'strict read of another class, strict call, effect call (by its consistency level)',
          text: C('fixed', 'strict'),
          diagrams: [
            { caption: 'A and B in different containers (remote): a hop through both sidecars', lanes: apart('operation', 'home class A'), steps: access('op', 'strict read / call', true) },
            { caption: 'A and B in one container (no hop): a direct call', lanes: together('operation', 'home class A'), steps: access('op', 'direct call', false) },
          ],
        },
      ],
    },
    ...(model.homes?.length ? [{
      // the home of an operation as a decision
      id: 'home' as const, family: 'none' as const, title: 'Home of an operation', where: F('home', 'where'), ref: K('home')?.ref, options: [],
      what: F('home', 'what'),
      examples: F('home', 'examples'), nodes,
      effect: F('home', 'effect'),
      cards: [{
        id: 'home', mech: 'sync', sub: 'the gateway calls the chosen home',
        text: C('home', 'home'),
        diagrams: [
          { caption: 'Today\'s home A', lanes: [L('gw', 'gateway', 'request plan', GW), L('a', 'operation at A', 'root resolver', SVC_A), L('b', 'class B', 'step form / work', SVC_B), L('bdb', 'B\'s schema', undefined, DB_B)],
            steps: [{ msg: ['gw', 'a'], label: 'root field', remote: 'sync' }, { note: 'a', text: 'writes A (own schema)' }, { msg: ['a', 'b'], label: 'effect step: write B', remote: 'sync' }, { msg: ['b', 'bdb'], label: 'statements' }, { msg: ['b', 'a'], label: 'ok', ret: true, remote: 'sync' }, { msg: ['a', 'gw'], label: 'answer', ret: true, remote: 'sync' }] },
          { caption: 'Home B chosen: the gateway\'s call re-targeted (layer 2), A\'s write an effect step', lanes: [L('gw', 'gateway', 'request plan', GW), L('b', 'operation at B', 'root resolver', SVC_B), L('bdb', 'B\'s schema', undefined, DB_B), L('a', 'class A', 'step form / work', SVC_A)],
            steps: [{ msg: ['gw', 'b'], label: 'root field (re-targeted)', remote: 'sync' }, { msg: ['b', 'bdb'], label: 'writes B, commit' }, { msg: ['b', 'a'], label: 'effect step: write A', remote: 'sync' }, { msg: ['a', 'b'], label: 'ok', ret: true, remote: 'sync' }, { msg: ['b', 'gw'], label: 'answer', ret: true, remote: 'sync' }] },
        ],
      }],
    } as Kind] : []),
    {
      id: 'read', family: 'fetch', title: 'Read of another class', where: F('read', 'where'), ref: K('read')?.ref, options: ['sync', 'cache', 'copy'],
      what: F('read', 'what'),
      examples: F('read', 'examples'),
      effect: F('read', 'effect'),
      cards: [
        {
          id: 'sync', mech: 'sync',
          text: C('read', 'sync'),
          diagrams: [{ caption: 'A and B in different services', lanes: apart('reader', 'operation of A'), steps: access('op', 'read', true) }],
        },
        {
          id: 'cache', mech: 'cache',
          text: C('read', 'cache'),
          diagrams: [{ caption: 'A and B in different services', lanes: apart('reader', 'operation of A, cache'), steps: [{ frame: 'alt', span: ['op', 'bdb'], guard: ratio, then: [{ note: 'op', text: `cache hit ${cacheHit} ms` }], elseGuard: 'miss', orElse: access('op', 'read', true) }] }],
        },
        {
          id: 'copy', mech: 'copy',
          text: C('read', 'copy'),
          diagrams: [
            { caption: 'The read: from the copy in the reader\'s service, no call to B', lanes: [L('op', 'reader', 'operation of A', SVC_A), L('store', 'copy store', 'copy of B', SVC_A)], steps: [{ msg: ['op', 'store'], label: 'copy read' }, { note: 'store', text: `readDbMs ${readDb} ms` }, { msg: ['store', 'op'], label: 'rows', ret: true }] },
            {
              caption: 'What feeds it: every write of B, in the background', lanes: [L('w', 'writer of B', 'any operation', SVC_B), L('broker', 'broker', undefined, BROKER), L('r', 'class A', 'component', SVC_A), L('store', 'copy store', 'copy of B', SVC_A)],
              steps: [
                { note: 'w', text: 'writes B (B\'s schema)' },
                { frame: 'async', span: ['w', 'store'], guard: 'after the write, in the background', then: [
                  { msg: ['w', 'broker'], label: pub, remote: 'feed', async: true },
                  { msg: ['broker', 'r'], label: del, remote: 'feed', async: true },
                  { note: 'r', text: `copy write ${writeCpu} ms` },
                  { msg: ['r', 'store'], label: `upsert ${writeDb} ms` },
                ] },
              ],
            },
          ],
        },
      ],
    },
    {
      id: 'effect', family: 'effect', title: 'Effect step', where: F('effect', 'where'), ref: K('effect')?.ref, options: ['inTx', 'sync', 'async'],
      what: F('effect', 'what'),
      examples: F('effect', 'examples'),
      effect: F('effect', 'effect'),
      cards: [
        {
          id: 'inTx', mech: 'inTx', sub: 'in A\'s transaction',
          text: C('effect', 'inTx'),
          diagrams: [
            {
              caption: 'A and B in one container (no hop), both schemas on one database server: joined (a direct call in A\'s transaction)',
              lanes: [L('op', 'operation A', 'trigger, A\'s transaction', ONE), L('b', 'class B', 'B\'s work', ONE), L('adb', 'A\'s schema', undefined, 'one DB server'), L('bdb', 'B\'s schema', undefined, 'one DB server')],
              steps: [
                { note: 'op', text: 'begin; A\'s work' },
                { msg: ['op', 'adb'], label: 'A\'s statements' },
                { msg: ['op', 'b'], label: 'direct call (the work)' },
                { note: 'b', text: 'B\'s work only:\nno envelope' },
                { msg: ['b', 'bdb'], label: 'B\'s statements' },
                { msg: ['b', 'op'], label: 'ok', ret: true },
                { msg: ['op', 'adb'], label: `one commit (${commitMs} ms wait)` },
              ],
            },
            {
              caption: 'Apart, or the two schemas on different database servers: realised as a synchronous step (below)',
              lanes: apart('operation A', 'trigger'),
              steps: [{ msg: ['op', 'b'], label: 'step call', remote: 'sync' }, { note: 'b', text: 'step form: envelope,\nwork, B\'s commit' }, { msg: ['b', 'bdb'], label: 'statements, commit' }, { msg: ['b', 'op'], label: 'ok', ret: true, remote: 'sync' }],
            },
          ],
        },
        {
          id: 'sync', mech: 'sync', sub: 'a synchronous step, own transaction',
          text: C('effect', 'sync'),
          diagrams: [
            { caption: 'A and B in different containers (remote)', lanes: apart('operation A', 'trigger'), steps: [{ msg: ['op', 'b'], label: 'step call', remote: 'sync' }, ...stepForm('b', 'bdb'), { msg: ['b', 'op'], label: 'ok', ret: true, remote: 'sync' }] },
            { caption: 'A and B in one container (no hop): a direct call into the step form, B\'s own transaction', lanes: together('operation A', 'trigger'), steps: [{ msg: ['op', 'b'], label: 'direct step call' }, ...stepForm('b', 'bdb'), { msg: ['b', 'op'], label: 'ok', ret: true }] },
          ],
        },
        {
          id: 'async', mech: 'async', sub: 'an asynchronous message, own transaction',
          text: C('effect', 'async'),
          diagrams: [
            {
              caption: 'A and B in different containers (remote): through the broker', lanes: [L('op', 'operation A', 'trigger', SVC_A), L('broker', 'broker', undefined, BROKER), L('b', 'class B', 'step form', SVC_B), L('bdb', 'B\'s schema', undefined, DB_B)],
              steps: [
                { msg: ['op', 'broker'], label: pub, remote: 'saga', async: true },
                { note: 'op', text: 'goes on' },
                { frame: 'async', span: ['broker', 'bdb'], guard: 'in the background', then: [{ msg: ['broker', 'b'], label: del, remote: 'saga', async: true }, ...stepForm('b', 'bdb')] },
              ],
            },
            {
              caption: 'A and B in one container (no hop): in-process, no broker', lanes: together('operation A', 'trigger'),
              steps: [{ note: 'op', text: 'goes on' }, { frame: 'async', span: ['op', 'bdb'], guard: 'in the background', then: [{ msg: ['op', 'b'], label: 'message', async: true }, ...stepForm('b', 'bdb')] }],
            },
          ],
        },
        {
          id: 'callback', mech: 'async', sub: 'triggered from outside: a provider callback, async only',
          text: C('effect', 'callback'),
          diagrams: [{
            caption: 'Registrant and callback: always in one service', lanes: [L('op', 'registrant', 'operation of A', SVC_A), L('cb', 'callback', 'operation of A', SVC_A), L('adb', 'A\'s schema', undefined, DB_A)],
            steps: [
              { note: 'op', text: 'register with the provider\n(not modelled)', muted: true },
              { frame: 'async', span: ['op', 'adb'], guard: 'later, in the background', then: [{ msg: ['op', 'cb'], label: 'callback', async: true }, { note: 'cb', text: 'callback: own work' }, { msg: ['cb', 'adb'], label: 'statements' }] },
            ],
          }],
        },
      ],
    },
    {
      id: 'field', family: 'fetch', title: 'Field of a request', where: F('field', 'where'), ref: K('field')?.ref, options: ['sync', 'join', 'cache', 'joinCache'],
      what: F('field', 'what'),
      examples: F('field', 'examples'),
      effect: F('field', 'effect'),
      cards: [
        {
          id: 'sync', mech: 'sync',
          text: C('field', 'sync'),
          diagrams: [{ caption: 'The field\'s class in another service than the root\'s', lanes: fieldLanes(false), steps: [...start, { msg: ['root', 'prov'], label: 'field call', remote: 'sync' }, ...resolve('root', true), answer('answer with the field'), back] }],
        },
        {
          id: 'join', mech: 'join',
          text: C('field', 'join'),
          diagrams: [
            { caption: 'The field\'s class in another service than the root\'s', lanes: fieldLanes(false), steps: [...start, answer('answer + reference'), { note: 'gw', text: `compose ${compose} ms` }, fetch, ...resolve('gw', true), back] },
            localField,
          ],
        },
        {
          id: 'cache', mech: 'cache',
          text: C('field', 'cache'),
          diagrams: [{ caption: 'The field\'s class in another service than the root\'s', lanes: fieldLanes(false), steps: [...start, { frame: 'alt', span: ['root', 'db'], guard: ratio, then: [{ note: 'root', text: `cache hit ${cacheHit} ms` }], elseGuard: 'miss', orElse: [{ msg: ['root', 'prov'], label: 'field call', remote: 'sync' }, ...resolve('root', true)] }, answer('answer with the field'), back] }],
        },
        asBuilt
          ? {
            id: 'joinCache', mech: 'joinCache', sub: 'the field service\'s entity cache',
            text: C('field', 'joinCache'),
            diagrams: [{
              caption: 'The field\'s class in another service than the root\'s', lanes: fieldLanes(false),
              steps: [...start, answer('answer + reference'), { note: 'gw', text: `compose ${compose} ms` }, fetch,
                { frame: 'alt', span: ['prov', 'db'], guard: ratio, then: [{ note: 'prov', text: `entity cache hit ${jcHit} ms` }], elseGuard: 'miss', orElse: [{ note: 'prov', text: 'field resolver: own work' }, { msg: ['prov', 'db'], label: 'statements' }, { msg: ['db', 'prov'], label: 'rows', ret: true }] },
                { msg: ['prov', 'gw'], label: 'field', ret: true, remote: 'join' }, back],
            }],
          }
          : {
            id: 'joinCache', mech: 'joinCache', sub: 'a cache in the gateway',
            text: C('field', 'joinCache'),
            diagrams: [{
              caption: 'The field\'s class in another service than the root\'s', lanes: fieldLanes(false),
              steps: [...start, answer('answer + reference'), { note: 'gw', text: `compose ${compose} ms` },
                { frame: 'alt', span: ['gw', 'db'], guard: ratio, then: [{ note: 'gw', text: `gateway cache hit ${jcHit} ms` }], elseGuard: 'miss', orElse: [fetch, ...resolve('gw', true)] }, back],
            }],
          },
      ],
    },
    {
      id: 'saga', family: 'chain', title: 'Saga coordination', where: F('saga', 'where'), ref: K('saga')?.ref, options: ['choreography', 'orchestration'],
      what: F('saga', 'what'),
      examples: F('saga', 'examples'), nodes,
      effect: F('saga', 'effect'),
      cards: [
        {
          id: 'choreography', mech: 'choreography', sub: 'each service makes the next step',
          text: C('saga', 'choreography'),
          diagrams: [{
            caption: 'Three services, asynchronous steps', lanes: [L('t', 'trigger', doc?.lanes?.trigger, 'trigger\'s service'), L('broker', 'broker', undefined, BROKER), L('s1', 'step 1', 'reaction', 'step 1\'s service'), L('s2', 'step 2', 'reaction', 'step 2\'s service')],
            steps: [
              { msg: ['t', 'broker'], label: 'E1', remote: 'event', async: true },
              { frame: 'async', span: ['broker', 's2'], guard: 'in the background', then: [
                { msg: ['broker', 's1'], label: 'deliver E1', remote: 'event', async: true },
                { note: 's1', text: 'step 1, raises E2' },
                { msg: ['s1', 'broker'], label: 'E2', remote: 'event', async: true },
                { msg: ['broker', 's2'], label: 'deliver E2', remote: 'event', async: true },
                { note: 's2', text: 'step 2' },
              ] },
            ],
          }],
        },
        {
          id: 'orchestration', mech: 'orchestration', sub: 'the trigger\'s service makes every step',
          text: C('saga', 'orchestration'),
          diagrams: [{
            caption: 'Three services, one asynchronous and one synchronous step', lanes: [L('t', 'orchestrator', 'trigger\'s component', 'trigger\'s service'), L('broker', 'broker', undefined, BROKER), L('s1', 'step 1', 'async step', 'step 1\'s service'), L('s2', 'step 2', 'sync step', 'step 2\'s service')],
            steps: [
              { frame: 'async', span: ['t', 's2'], guard: 'background (first step asynchronous, remote)', then: [
                { note: 't', text: `step ${step} ms` },
                { msg: ['t', 'broker'], label: 'request', remote: 'saga', async: true },
                { msg: ['broker', 's1'], label: 'deliver', remote: 'saga', async: true },
                { note: 's1', text: 'step 1' },
                { msg: ['s1', 'broker'], label: 'reply', remote: 'saga', async: true },
                { msg: ['broker', 't'], label: 'deliver reply', remote: 'saga', async: true },
                { note: 't', text: `step ${step} ms` },
                { msg: ['t', 's2'], label: 'step 2 call', remote: 'sync' },
                { note: 's2', text: 'step 2' },
                { msg: ['s2', 't'], label: 'done', ret: true, remote: 'sync' },
              ] },
            ],
          }],
        },
      ],
    },
  ];
}

const FAMILIES: { id: FamilyId; title: string; text: string }[] = [
  { id: 'none', title: 'No call site', text: 'what the design cannot change, only where the two sides run' },
  { id: 'fetch', title: 'Fetch', text: 'get data of another class: the caller needs the answer' },
  { id: 'effect', title: 'Effect', text: 'a step of the work runs in another class: in the caller\'s transaction, a synchronous step or an asynchronous message' },
  { id: 'chain', title: 'Chains of effects', text: 'who coordinates the steps of a saga' },
];

type EffectSub = 'write' | 'event' | 'callback';
const subOf = (s: ModelSite): EffectSub => (s.kind === 'access' ? 'write' : s.kind as EffectSub);
/** today's sites: not those in a home option's SEFF other than the written one (inert while not chosen) */
const todaySites = (model: InputModel) => model.sites.filter((s) => !s.home || s.home.written);
const sitesOf = (model: InputModel, id: KindId | EffectSub) => (id === 'home' ? model.sites.filter((s) => s.home && !s.home.written)
  // a call of another operation that is not strict is a fetch too: sync or a cache
  : id === 'read' ? todaySites(model).filter((s) => (s.kind === 'access' && s.mode === 'read') || s.kind === 'call')
    : id === 'effect' ? todaySites(model).filter((s) => s.family === 'effect')
      : id === 'write' ? todaySites(model).filter((s) => s.kind === 'access' && s.mode === 'write')
        : todaySites(model).filter((s) => s.kind === id));
/** counts by label (`label`: a mechanism's, the packet's vocabulary) */
const tally = (xs: (string | undefined)[], label: (m: string) => string = (m) => m) => Object.entries(xs.reduce<Record<string, number>>((a, x) => { const k = x ? label(x) : '?'; return { ...a, [k]: (a[k] ?? 0) + 1 }; }, {}));
const range = (xs: number[]) => { const a = Math.min(...xs); const b = Math.max(...xs); return a === b ? num(a) : `${num(a)}–${num(b)}`; };
const short = (op: string) => op.slice(op.indexOf('.') + 1);

/**
 * The effect family's attributes: write, process event and callback are one interaction, "a step of the
 * work runs in another class"; only these attributes differ, and the allowed mechanisms and today's follow from them.
 */
function EffectAttributes({ model }: { model: InputModel }) {
  const cols: { id: EffectSub; label: string }[] = [{ id: 'write', label: 'write of another class' }, { id: 'event', label: 'event reaction' }, { id: 'callback', label: 'provider callback' }];
  const wAsync = num(model.parameters.find((x) => x.class === 'Consistency')?.properties.asyncWriteWeight);
  const mech = useMechLabel();
  const t = useT();
  const joinTally = (ss: ModelSite[]) => tally(ss.map((x) => { const j = x.effect?.joined?.today; return j === true ? 'joined' : j ? JOIN_BLOCKER_SHORT[j] : undefined; }), mech).map(([m, n]) => `${n} ${m}`).join(', ');
  const envOf = (ss: ModelSite[]) => { const v = ss.flatMap((x) => (x.effect?.step ? [x.effect.step.envelopeMs] : [])); return v.length ? `${range(v)} ms CPU${ss.some((x) => x.effect?.step?.estimate) ? ' (ESTIMATE)' : ''}` : 'none (no step form)'; };
  const rows: [string, string, (ss: ModelSite[], id: EffectSub) => ReactNode][] = [
    ['bound', 'in the operation\'s transaction with its home class', (ss) => { const n = ss.filter((x) => x.effect?.bound).length; return n ? `${n} yes, ${ss.length - n} no` : 'no'; }],
    ['fanout', 'targets per raise, and the probability per execution', (ss, id) => (id === 'event' ? `1 reaction per site, p ${range(ss.map((x) => x.effect?.p ?? 1))} (the raise's outcome)` : `1, p ${range(ss.map((x) => x.effect?.p ?? 1))}`)],
    ['cascades', 'what follows on the other side', (ss, id) => (id === 'write' ? 'none: the access part only'
      : `the ${id === 'callback' ? 'callback' : 'reaction'}'s SEFF: ${range(ss.map((x) => x.effect?.cascades?.sites ?? 0))} sites; raises ${[...new Set(ss.flatMap((x) => x.effect?.cascades?.raises ?? []))].length} topics`)],
    ['external', 'the trigger is outside the system', (ss) => (ss.some((x) => x.effect?.external) ? t('model.mech.attr.external', 'yes') : 'no')],
    ['allowed', 'follows from the above', (ss) => <span className="inline-flex flex-wrap gap-0.5">{[...new Set(ss.flatMap((x) => x.allowed))].map((m) => <MechChip key={m} m={m} active />)}</span>],
    ['today', 'today\'s mechanisms', (ss) => tally(ss.map((x) => x.today), mech).map(([m, n]) => `${n} ${m}`).join(', ')],
    ['joined', t('model.mech.attr.joinedHelp', 'in today\'s cut: joined A\'s transaction, else why not'), joinTally],
    ['envelope', t('model.mech.attr.envelopeHelp', 'B\'s receiving envelope per step form, own transaction only'), envOf],
    ['compensation', 'a failing outcome', (ss, id) => (id === 'write' ? 'no outcome branches: the write commits with its step'
      : id === 'callback' ? t('model.mech.attr.callbackCompensation', 'raises a failure event: its compensation is an event step')
        : t('model.mech.attr.reactionCompensation', '{{n}} compensation steps: they exist only for steps in their own transaction (a failure event); in transaction a failing outcome is a rollback of the whole transaction (the model keeps the compensations as calls)', { n: ss.filter((x) => model.processes.some((p) => x.callee && p.compensations.includes(x.callee))).length }))],
  ];
  const by = new Map(cols.map((c) => [c.id, sitesOf(model, c.id)]));
  return (
    <div className="space-y-1">
      <div className="text-[10.5px] font-medium">One effect step, three ways today&apos;s code implements it (the attributes)</div>
      <div className="overflow-hidden rounded-md border text-[11px]">
        <div className="grid grid-cols-[6.5rem_repeat(3,minmax(0,1fr))] gap-x-2 border-b bg-muted/40 px-2 py-0.5 text-[10.5px] text-muted-foreground">
          <span>attribute</span>{cols.map((c) => <span key={c.id} className="font-medium text-foreground">{c.label} ({by.get(c.id)!.length})</span>)}
        </div>
        {rows.map(([k, help, f]) => (
          <div key={k} className="grid grid-cols-[6.5rem_repeat(3,minmax(0,1fr))] gap-x-2 border-b border-border/50 px-2 py-0.5 last:border-b-0">
            <span className="text-muted-foreground" title={help}>{k}</span>
            {cols.map((c) => <span key={c.id} className="min-w-0 text-foreground [overflow-wrap:anywhere]">{f(by.get(c.id)!, c.id)}</span>)}
          </div>
        ))}
      </div>
      <ul className="list-disc space-y-0.5 pl-4 text-[11px] text-muted-foreground">
        <li>{t('model.mech.attr.noteInTx', "in transaction joins A's transaction only while A and B share a container and their schemas a database server (and not as an orchestrated step); else it is a synchronous step: {{apart}}; {{servers}}; {{orchestrated}};", { apart: JOIN_BLOCKER_LABEL.apart, servers: JOIN_BLOCKER_LABEL.servers, orchestrated: JOIN_BLOCKER_LABEL.orchestrated })}</li>
        <li>sync and async run B&apos;s step form in B&apos;s own transaction (envelope, work, commit): only these have failure events and compensation steps; async leaves A&apos;s path (O4 weight {wAsync} apart);</li>
        {model.processes.some((p) => p.transaction && (!p.transaction.home || p.transaction.home.written)) && <li>{t('model.mech.attr.noteTx', "the bound writes of one operation are the steps of its transaction workflow (Saga coordination): choreographed they run where the code makes them, orchestrated they are saga steps (step forms) at the end of the operation's SEFF;")}</li>}
        <li>an external trigger allows async only;</li>
        <li>writes and events have the same mechanism weights (coupling, contract breaks): command or event is not a choice of the design, what the operation needs is given by the domain.</li>
      </ul>
    </div>
  );
}

/** the kind's call sites with their family attributes: effect sites their attributes, copy sites the topics that feed the copy */
const joinText = (j: true | JoinBlocker | undefined) => (j === true ? 'joined today' : j && j !== 'chosen' ? `not joined today: ${JOIN_BLOCKER_SHORT[j]}` : undefined);

function SiteList({ model, kind }: { model: InputModel; kind: KindId }) {
  const ss = useMemo(() => sitesOf(model, kind).slice().sort((a, b) => (a.op ?? '').localeCompare(b.op ?? '') || (a.class ?? a.callee ?? '').localeCompare(b.class ?? b.callee ?? '')), [model, kind]);
  if (!ss.length) return null;
  const copies = ss.filter((x) => x.copyTopics);
  const txStep = new Set(model.processes.flatMap((p) => p.transaction?.sites ?? []));
  const ops = new Map(model.operations.map((o) => [o.id, o]));
  return (
    <Collapsible className="rounded-lg border bg-card px-3 py-1.5">
      <CollapsibleTrigger className="group flex w-full cursor-pointer items-center gap-1 text-left text-[11px] font-medium">
        <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />
        Sites ({ss.length})
        <span className="ml-auto text-[10.5px] font-normal text-muted-foreground">{kind === 'read'
          ? `${copies.filter((x) => x.copyTopics!.some((t) => t.today)).length} of ${copies.length} copy options fed by a topic today`
          : ss[0].effect ? 'how today implements it · bound · p · cascades · joined today' : 'today\'s mechanism highlighted'}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-1 text-[11px]">
        {ss.map((x) => (
          <div key={x.id} className="grid grid-cols-1 gap-x-2 border-t border-border/50 py-0.5 @2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]" title={x.id}>
            <span className="min-w-0 [overflow-wrap:anywhere]">
              {x.op ? <ModelLink target={`op:${x.op}`}>{x.op}</ModelLink> : '–'}{x.request && <span className="text-muted-foreground"> ({x.request})</span>}
              <span className="text-muted-foreground"> → </span>
              {x.class ? <ModelLink target={`class:${x.class}`}>{x.class}</ModelLink> : x.callee ? <ModelLink target={`op:${x.callee}`}>{short(x.callee)}</ModelLink> : '–'}
              {x.event && <span className="text-muted-foreground"> on {x.event}</span>}
              {x.kind === 'call' && <span className="text-muted-foreground"> (a call)</span>}
              {kind === 'read' && <> <LevelChip c={x.kind === 'call' ? callConsistency(x.op ? ops.get(x.op) : undefined, x.callee) : readConsistency(x.op ? ops.get(x.op) : undefined, x.class)} texts={model.consistency} what={x.kind === 'call' ? 'call' : 'read'} /></>}
              {x.kind === 'callback' && x.op && ops.get(x.op)?.effectCalls?.map((e) => <span key={e.to}> <EffectCallChip to={e.to} rules={e.rules} reason={e.reason} texts={model.consistency} /></span>)}
            </span>
            <span className="min-w-0 text-muted-foreground [overflow-wrap:anywhere]">
              {x.effect && [
                kind === 'effect' ? ({ write: 'write', event: 'event reaction', callback: 'callback' } as const)[subOf(x)] : undefined,
                x.home && !x.home.written ? `at home ${x.home.class} (inert unless chosen)` : undefined,
                x.kind === 'access' ? (x.effect.bound ? (txStep.has(x.id) ? 'bound, transaction step' : 'bound') : 'own transaction') : undefined,
                x.effect.p !== 1 ? `p ${num(x.effect.p)}` : undefined,
                x.effect.cascades ? `${x.effect.cascades.sites} sites${x.effect.cascades.raises.length ? `, raises ${x.effect.cascades.raises.join(', ')}` : ''}` : undefined,
                x.effect.external ? 'external' : joinText(x.effect.joined?.today),
                x.effect.step ? `envelope ${num(x.effect.step.envelopeMs)} ms${x.effect.step.estimate ? ' (est.)' : ''}` : undefined,
              ].filter(Boolean).join(' · ')}
              {x.copyTopics && (x.copyTopics.length
                ? <>{x.copyTopics[0].today ? 'copy fed by ' : 'no copy today; carried by '}{x.copyTopics.map((t, i) => <span key={t.topic}>{i > 0 && ', '}<span className="font-mono text-[10.5px] text-foreground/80">{t.topic}</span> <span className="text-[10px]">{t.role}</span></span>)}</>
                : 'no topic carries it: a copy needs a new replication topic')}
              {x.copyFeed && !x.copyFeed.writers.length && <span> (event-carried)</span>}
            </span>
            <span className="inline-flex flex-wrap items-start gap-0.5 @2xl:justify-end">{x.allowed.map((m) => <MechChip key={m} m={m} active={m === x.today} />)}</span>
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * the consistency levels, explained once: what each leaves of a read's or call's mechanisms, how many reads and
 * calls of the model have it, the lock and effect marks, and the case's rules (the ids the chips name)
 */
function ConsistencyLegend({ model, doc }: { model: InputModel; doc?: ConsistencyDoc }) {
  const reads = model.operations.flatMap((o) => [...new Set(o.accesses.filter((a) => a.mode === 'read' && !a.local).map((a) => a.class))].map((c) => readConsistency(o, c)!));
  const calls = model.operations.flatMap((o) => o.calls.map((c) => callConsistency(o, c.callee)!));
  const n = (lv: string) => ({ reads: reads.filter((c) => c.level === lv).length, calls: calls.filter((c) => c.level === lv).length });
  const effects = model.operations.reduce((a, o) => a + (o.effectCalls?.length ?? 0), 0);
  const locks = model.operations.reduce((a, o) => a + o.accesses.filter((x) => x.lock).length, 0);
  const vars = { reads: reads.length, calls: calls.length, effects, locks };
  const rules = Object.entries(model.consistency?.rules ?? {});
  const texts = model.consistency;
  return (
    <div data-testid="consistency-legend" className="space-y-1 rounded-lg border bg-card px-3 py-2">
      <div className="text-[11px] font-semibold">{doc?.title || 'Consistency levels: what a read or call may use'}</div>
      {doc?.intro && <p className="text-muted-foreground"><MText text={fill(doc.intro, vars)} strong="font-medium text-foreground" /></p>}
      <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] items-baseline gap-x-2 gap-y-1">
        {CONSISTENCY_LEVELS.map((lv) => {
          const k = n(lv);
          return (
            <div key={lv} className="contents">
              <dt><LevelChip c={{ level: lv }} texts={texts} /></dt>
              <dd className="text-muted-foreground">{texts?.levels?.[lv] ?? LEVEL_ABOUT[lv]} <span className="tabular">({k.reads} reads of other classes{k.calls ? `, ${k.calls} calls` : ''} in the model)</span></dd>
            </div>
          );
        })}
        <dt><LockMark /></dt><dd className="text-muted-foreground">{doc?.lock ? <MText text={fill(doc.lock, vars)} /> : LOCK_ABOUT}</dd>
        <dt><EffectCallChip texts={texts} /></dt><dd className="text-muted-foreground">{doc?.effect ? <MText text={fill(doc.effect, vars)} /> : `${EFFECT_ABOUT}${effects ? ` (${effects} in the model)` : ''}`}</dd>
      </dl>
      {rules.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 text-left text-[10.5px] font-medium text-muted-foreground hover:text-foreground">
            <ChevronRight className="size-3 transition-transform group-data-[state=open]:rotate-90" />
            The rules ({rules.length}){texts?.source ? <span className="font-normal"> · curated in <code className="font-mono">{texts.source}</code></span> : null}
          </CollapsibleTrigger>
          <CollapsibleContent>
            <dl data-testid="consistency-rules" className="grid grid-cols-[2.25rem_minmax(0,1fr)] gap-x-2 gap-y-0.5 pt-1 text-[11px]">
              {rules.map(([id, text]) => <div key={id} className="contents"><dt className="font-mono font-medium">{id}</dt><dd className="text-muted-foreground">{text}</dd></div>)}
            </dl>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

/** the Interactions tab: the kinds of interaction with their options, then the selected kind's mechanisms as sequence diagrams */
export function InteractionsTab({ model, kindId }: { model: InputModel; kindId?: string }) {
  const doc = useDoc<InteractionsDoc>('interactions');
  const t = useT();
  const all = useMemo(() => kinds(model, doc), [model, doc]);
  const mech = useMechLabel();
  const counts = useMemo(() => {
    const m = new Map<KindId, { n: number; today: [string, number][] }>();
    for (const k of all) {
      if (k.id === 'fixed') continue;
      if (k.id === 'saga') { const ps = model.processes.filter((p) => !p.transaction?.home || p.transaction.home.written); m.set(k.id, { n: ps.length, today: tally(ps.map((p) => p.today), mech) }); }
      else if (k.id === 'home') m.set(k.id, { n: model.homes?.length ?? 0, today: tally((model.homes ?? []).map((h) => (h.today === h.written ? 'written home' : 'another home')), mech) });
      else { const ss = sitesOf(model, k.id); m.set(k.id, { n: ss.length, today: tally(ss.map((s) => s.today), mech) }); }
    }
    return m;
  }, [model, all, mech]);
  const sel = all.find((k) => k.id === (KIND_ALIAS[kindId ?? ''] ?? kindId)) ?? all.find((k) => k.id === 'read')!;
  const rc = model.parameters.find((p) => p.class === 'RemoteCalls')?.properties ?? {};
  const intro = (doc?.intro ?? INTRO).map((x) => fill(x, {
    callerCpuMs: num(rc.callerCpuMs), latencyMs: num(rc.latencyMs), calleeCpuMs: num(rc.calleeCpuMs), publishCpuMs: num(rc.publishCpuMs), deliverCpuMs: num(rc.deliverCpuMs),
    networkMs: typeof rc.networkMs === 'number' ? num(rc.networkMs) : '',
  })).filter(Boolean);
  const examples = t('model.mech.examples', 'Examples');
  // the placement badges, explained once: the same variables as the intro, and the receiving envelope's range
  const recvs = (model.envelopes ?? []).map((e) => e.ms);
  const pv = {
    callerCpuMs: num(rc.callerCpuMs), latencyMs: num(rc.latencyMs), calleeCpuMs: num(rc.calleeCpuMs), publishCpuMs: num(rc.publishCpuMs), deliverCpuMs: num(rc.deliverCpuMs),
    networkMs: typeof rc.networkMs === 'number' ? num(rc.networkMs) : '', recv: recvs.length > 0, recvRange: recvs.length ? range(recvs) : '', recvEst: (model.envelopes ?? []).some((e) => e.estimate),
  };
  const pd = doc?.placement;
  const placement = { title: pd?.title || 'Placement: no hop, remote or own data (not a mechanism)', intro: fill(pd?.intro, pv), noHop: fill(pd?.noHop, pv) || PLACEMENT_ABOUT.noHop, remote: fill(pd?.remote, pv) || PLACEMENT_ABOUT.remote, own: fill(pd?.own, pv) || PLACEMENT_ABOUT.own };

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto max-w-[1100px] space-y-5 p-4 text-xs">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">How operations interact, and what a design may choose</h2>
          {intro.map((x) => <p key={x} className="text-muted-foreground"><MText text={x} strong="font-medium text-foreground" /></p>)}
        </div>
        <div data-testid="placement-legend" className="space-y-1 rounded-lg border bg-card px-3 py-2">
          <div className="text-[11px] font-semibold">{placement.title}</div>
          {placement.intro && <p className="text-muted-foreground"><MText text={placement.intro} strong="font-medium text-foreground" /></p>}
          <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] items-baseline gap-x-2 gap-y-1">
            <dt><PlacementBadge together /></dt><dd className="text-muted-foreground"><MText text={placement.noHop} strong="font-medium text-foreground" /></dd>
            <dt><PlacementBadge together={false} to="B's service" /></dt><dd className="text-muted-foreground"><MText text={placement.remote} strong="font-medium text-foreground" /></dd>
            <dt className="flex flex-col items-start gap-0.5"><OwnData mode="read" /><OwnData mode="write" /></dt><dd className="text-muted-foreground"><MText text={placement.own} strong="font-medium text-foreground" /></dd>
          </dl>
        </div>
        <ConsistencyLegend model={model} doc={doc?.consistency} />
        <Section title="Kinds of interaction" right={`${todaySites(model).length} call sites${model.sites.length > todaySites(model).length ? ` (+${model.sites.length - todaySites(model).length} in the alternative homes' SEFFs)` : ''} · ${model.processes.filter((p) => !p.transaction?.home || p.transaction.home.written).length} sagas${model.homes?.length ? ` · ${model.homes.length} homes` : ''}`}>
          <div className="space-y-1.5">
            {FAMILIES.map((f) => (
              <div key={f.id}>
                <div className="flex flex-wrap items-baseline gap-x-2 px-2 pb-0.5"><span className="text-[11px] font-semibold">{f.title}</span><span className="text-[10.5px] text-muted-foreground">{f.text}</span></div>
                <div className="divide-y divide-border/50 border-l-2 border-border pl-1">
                  {all.filter((k) => k.family === f.id).map((k) => {
                    const c = counts.get(k.id);
                    return (
                      <button key={k.id} type="button" onClick={() => workspaceActions.openModel(`mech:${k.id}`)}
                        className={cn('grid w-full cursor-pointer grid-cols-1 gap-x-3 gap-y-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent/60 @2xl:grid-cols-[minmax(0,1fr)_auto]', k.id === sel.id && 'bg-accent')}>
                        <span className="min-w-0"><span className="font-medium">{k.title}</span>{k.where && <span className="text-muted-foreground"> · {k.where}</span>}</span>
                        <span className="flex flex-wrap items-center gap-1 @2xl:justify-end">
                          {k.options.map(chip)}
                          <span className="tabular ml-1 text-[10.5px] text-muted-foreground">{c ? `${c.n} ${k.id === 'saga' ? 'sagas' : k.id === 'home' ? 'operations' : 'sites'} · today ${c.today.map(([m, n]) => `${n} ${m}`).join(', ')}` : 'no site'}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </Section>
        <Section title={sel.title} right={sel.ref}>
          {(sel.what || sel.examples || sel.effect) && <dl className="grid gap-x-3 gap-y-1 @2xl:grid-cols-[7rem_minmax(0,1fr)]">
            {sel.what && <><dt className="text-muted-foreground">What it is</dt><dd>{sel.what}</dd></>}
            {sel.examples && <><dt className="text-muted-foreground">{examples}</dt><dd><MText text={sel.examples} nodes={sel.nodes} /></dd></>}
            {sel.effect && <><dt className="text-muted-foreground">What the choice changes</dt><dd>{sel.effect}</dd></>}
          </dl>}
          {sel.family === 'effect' && <EffectAttributes model={model} />}
          <SiteList model={model} kind={sel.id} />
          <div className="space-y-3 pt-1">
            {sel.cards.map((c) => (
              <div key={c.id} className="space-y-1.5 rounded-lg border bg-card px-3 py-2">
                <div className="flex flex-wrap items-center gap-1.5">{c.mech ? chip(c.mech) : <><OwnData mode="read" /><OwnData mode="write" /></>}{c.sub && <span className="text-[10.5px] text-muted-foreground">{c.sub}</span>}</div>
                {c.text && <p className="text-[11px] text-muted-foreground">{c.text}</p>}
                <div className="space-y-3">
                  {c.diagrams.map((d) => (
                    <figure key={d.caption} className="min-w-0 space-y-0.5">
                      <figcaption className="text-[10.5px] font-medium">{d.caption}</figcaption>
                      <SequenceDiagram lanes={d.lanes} steps={d.steps} />
                    </figure>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Section>
      </div>
    </ScrollArea>
  );
}
