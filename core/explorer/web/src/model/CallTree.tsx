/**
 * The call-site tree: an entry point (or a request type) and everything downstream of it, each
 * link one call of a SEFF labelled with its kind (field via the gateway plan, event raise → reaction, provider
 * callback, call, access to another class), the mechanisms its call site allows and — in a placement (design A, else
 * today's cut) — the mechanism chosen, the placement (no hop: caller and callee in one container; remote → the callee's
 * service), and what that makes of the call (an event gone in-process, a new saga event, copy feeds). Children render
 * only when a node is opened.
 */
import { memo, useMemo, useState, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import type { Id, InputModel, ModelOperation } from '@contract/types';
import { planVia } from '@contract/plan';
import { OwnData, PLACEMENT_ABOUT, PlacementBadge } from '@/components/PlacementBadge';
import { EffectCallChip, LevelChip, LockMark } from '@/components/LevelChip';
import { callConsistency, readConsistency } from '@contract/consistency';
import { cn } from '@/lib/utils';
import { activeSeff, callGraph, feedsInPlacement, realise, todayPlacement, type CallGraph, type CallLink, type Placement, type Realised } from './callGraph';
import { KindBadge, MechChip, ModelLink, fmtN, useMechLabel, type DesignContext } from './shared';
import { useSeffIndex, type Totals } from './SeffTree';
import { useT, type T } from './text';

export function usePlacement(model: InputModel, ctx: DesignContext | null): Placement {
  return useMemo(() => (ctx
    ? { label: `A (${ctx.label})`, design: true, serviceOf: (c: Id) => ctx.serviceOf.get(c), mech: (s) => ctx.siteMech(s.id),
      joinOf: (s) => { const st = ctx.design.decisions?.effects?.[s.id]; return st ? (st.joined ? true : st.why) : s.effect?.joined?.[ctx.seed as 'today' | 'neutral' | 'monolith']; },
      homeOf: (op: Id) => ctx.design.decisions?.homes?.[op] ?? model.homes?.find((h) => h.op === op)?.written }
    : todayPlacement(model)), [model, ctx]);
}

/** an operation's name; reactions and callbacks (named after their topic or route) with their service */
export function OpName({ op }: { op: ModelOperation }) {
  return <>{op.kind === 'reaction' || op.kind === 'callback' ? <span className="font-normal text-muted-foreground">{op.service}.</span> : null}{op.name}</>;
}

/** a request plan entry's `via` (contract PlanVia) as the call tree and the Workload tab name it */
export const PLAN_VIA_LABEL: Record<string, string> = { root: 'root resolver', service: "parent's service", gateway: 'gateway fetch' };
export const PLAN_VIA_ABOUT: Record<string, string> = {
  root: 'the gateway calls the root resolver',
  service: "resolved in the service that resolves its parent (the root's service for a field on the root's objects), no gateway fetch",
  gateway: 'a federation fetch by the gateway',
};

/** the link's kind as a short tag */
export function LinkTag({ l, g, compact }: { l: CallLink; g: CallGraph; compact?: boolean }) {
  const t = useT();
  let text: ReactNode;
  let title: string;
  switch (l.kind) {
    case 'field': {
      const via = planVia(l.site?.planVia);
      text = <>field{!compact && via ? <>{' · plan: '}{PLAN_VIA_LABEL[via]}</> : null}</>;
      title = t('model.link.field', "a further field of the request's gateway plan{{#plan}}; today's plan: {{plan}}{{/plan}}", { plan: via ? PLAN_VIA_ABOUT[via] : '' }); break;
    }
    case 'event': text = 'event';
      title = t('model.link.event', 'raise → reaction: one call site per (raise, reaction){{#event}}; event {{event}}{{/event}}', { event: l.site?.event }); break;
    case 'callback': text = 'provider callback'; title = t('model.link.callback', 'the external provider calls back (asynchronous only)'); break;
    case 'call': text = 'call'; title = t('model.link.call', 'a call of another operation (a strict call: sync only; a stale-ok one: sync or a cache)'); break;
    case 'root': text = 'root'; title = 'the gateway calls the request\'s root resolver'; break;
    case 'access': text = l.mode === 'write' ? 'write' : 'read'; title = t('model.link.access', '{{mode}} of another class through its component', { mode: l.mode }); break;
    // an access to the home class: read / write, shown with its fixed mechanism and the own-data badge (OwnData)
    default: text = l.commit ? 'commit' : l.mode === 'write' ? 'write' : 'read';
      title = l.commit ? t('model.link.commit', "the commit of the operation's transaction on its home class's own schema") : t('placement.own', PLACEMENT_ABOUT.own); break;
  }
  void g;
  const tone = l.kind === 'event' || l.kind === 'callback' ? 'border-[color-mix(in_oklab,var(--series-5)_45%,transparent)]' : l.kind === 'field' ? 'border-[color-mix(in_oklab,var(--series-3)_45%,transparent)]' : l.mode === 'write' ? 'border-[color-mix(in_oklab,var(--series-5)_30%,transparent)]' : '';
  return <span title={title} className={cn('inline-flex max-w-[22rem] items-center truncate rounded border px-1 text-[10px] leading-4 text-muted-foreground', tone)}>{text}</span>;
}

/** the allowed mechanisms, the placement's one highlighted */
export function MechSet({ r, pl, compact }: { r: Realised; pl: Placement; compact?: boolean }) {
  const label = useMechLabel();
  if (compact) return <MechChip m={r.mech} active title={`${pl.label}: ${label(r.mech)} · allowed: ${r.allowed.map(label).join(', ')}${r.decided ? '' : ' (no call site)'}`} />;
  return (
    <span className="inline-flex flex-wrap items-center gap-0.5" title={r.decided ? `allowed mechanisms of the call site; highlighted: ${pl.label}'s` : 'no call site: the only mechanism'}>
      {r.allowed.map((m) => <MechChip key={m} m={m} active={m === r.mech} muted={m !== r.mech} title={`${label(m)}${m === r.mech ? ` · ${pl.label}` : ''}`} />)}
      {!r.decided && <span className="text-[10px] text-muted-foreground">only</span>}
    </span>
  );
}

const MARK_STYLE: Record<string, string> = {
  broker: 'border-[color-mix(in_oklab,var(--series-5)_50%,transparent)] text-foreground',
  'no-event': 'border-dashed text-muted-foreground line-through decoration-1',
  'new-event': 'border-[var(--status-warning)] text-[var(--status-warning)]',
  feed: 'border-[var(--status-warning)] text-[var(--status-warning)]',
};

/** what the call is in the placement: the placement badge (no hop / remote → service), the effective realisation, event marks */
export function Realisation({ r, pl }: { r: Realised; pl: Placement }) {
  return (
    <span className="inline-flex flex-wrap items-center gap-1 text-[10.5px]">
      {r.together !== undefined && <PlacementBadge together={r.together} to={r.calleeSvc?.name} where={pl.label} />}
      <span className="text-muted-foreground">{r.text}</span>
      {r.mark && <span className={cn('rounded border px-1 text-[10px]', MARK_STYLE[r.mark.kind])} title={r.mark.text}>{r.mark.kind === 'no-event' ? 'event' : r.mark.kind === 'broker' ? 'broker event' : r.mark.kind === 'feed' ? '+ feed events from its writers' : '+ event'}</span>}
    </span>
  );
}

interface Ctx { model: InputModel; g: CallGraph; pl: Placement; entry?: Id; total: (s: Id) => Totals; select?: Id; t: T }

/**
 * a link's consistency: a read's level (its read group) with the rules and the reason, a call's, the effect
 * calls of a provider callback's registering operation; an own-data read only its lock mark (nothing to justify)
 */
export function LinkLevel({ l, g, model }: { l: CallLink; g: CallGraph; model: InputModel }) {
  const caller = l.caller ? g.ops.get(l.caller) : undefined;
  if ((l.kind === 'access' || (l.kind === 'db' && !l.commit)) && l.mode === 'read') {
    const c = readConsistency(caller, l.cls);
    return <>{l.kind === 'access' && <LevelChip c={c} texts={model.consistency} />}{c?.lock && <LockMark />}</>;
  }
  if (l.kind === 'call') return <LevelChip c={callConsistency(caller, l.op)} texts={model.consistency} what="call" />;
  if (l.kind === 'callback') return <>{caller?.effectCalls?.map((e) => <EffectCallChip key={e.to} to={e.to} rules={e.rules} reason={e.reason} texts={model.consistency} />)}</>;
  return null;
}

/** one access line: read / write of a class, its site and, for writes, the copy feeds it causes */
/** the call reaches B's step form: envelope (flagged when an estimate), the work below, B's commit */
function StepMark({ step, c }: { step: Id; c: Ctx }) {
  const f = c.g.seffs.get(step);
  const env = f?.parts.find((p) => p.name === 'envelope');
  const commit = f?.parts.some((p) => p.kind === 'commit');
  return (
    <span className="rounded border border-dashed px-1 text-[10px] text-muted-foreground" title={c.t('model.stepForm.title', "B's step form {{step}}: the receiving envelope{{#est}} (an estimate){{/est}}, the step's work (below){{#commit}}, B's commit{{/commit}}; skipped when the step joins the caller's transaction", { step, est: env?.estimate, commit })}>
      step form{env ? ` +${fmtN(env.ms, 2)} ms${env.estimate ? '*' : ''}` : ''}{commit ? ' + commit' : ''}
    </span>
  );
}

function AccessRow({ l, c }: { l: CallLink; c: Ctx }) {
  const r = realise(c.g, l, c.pl, c.t);
  const feeds = l.mode === 'write' && l.caller && l.cls ? feedsInPlacement(c.g, l.caller, l.cls, c.pl) : [];
  return (
    <li className="py-px">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 pl-5">
        <LinkTag l={l} g={c.g} />
        {l.cls && <ModelLink target={`class:${l.cls}`} className={cn(l.kind === 'db' ? 'text-muted-foreground' : 'font-medium')}>{l.what ?? l.cls}</ModelLink>}
        {l.p !== 1 && <span className="rounded bg-muted px-1 text-[10px] tabular" title="expected executions per execution of the caller">× {fmtN(l.p, 3)}</span>}
        {l.step && <StepMark step={l.step} c={c} />}
        {l.kind === 'access' && <MechSet r={r} pl={c.pl} />}
        {l.kind === 'db' && !l.commit && <OwnData mode={l.mode} />}
        <LinkLevel l={l} g={c.g} model={c.model} />
        {l.kind === 'access' && <Realisation r={r} pl={c.pl} />}
      </div>
      {feeds.length > 0 && (
        <div className="pl-9 text-[10.5px] text-[var(--status-warning)]" title="the copy sync: every write of a class read as a local copy in another service sends the copy an event (architecture.mm CopyFeed)">
          + feeds {feeds.length === 1 ? 'the copy' : `${feeds.length} copies`} of {l.cls} in {[...new Set(feeds.map((f) => f.svc?.name ?? '?'))].join(', ')}: {feeds.map((f, i) => <span key={f.site.id}>{i ? ', ' : ''}<ModelLink target={`op:${f.reader.id}`}>{f.reader.name}</ModelLink></span>)} <span className="text-muted-foreground">(a broker event per write)</span>
        </div>
      )}
    </li>
  );
}

/** "also reached from": the other entry points that reach this operation */
function AlsoFrom({ op, c }: { op: Id; c: Ctx }) {
  const others = (c.g.reachedFrom.get(op) ?? []).filter((e) => e !== c.entry);
  if (!others.length || c.g.entryOf.has(op)) return null;
  const names = others.map((e) => c.g.ops.get(e)?.name ?? e);
  return <span className="rounded bg-muted px-1 text-[10px] text-muted-foreground" title={`also reached from ${names.join(', ')}`}>also from {names.slice(0, 2).join(', ')}{names.length > 2 ? ` +${names.length - 2}` : ''}</span>;
}

/** an operation reached through a link (or the tree's root), with its calls below */
const OpNode = memo(function OpNode({ seff, l, c, depth, open: openDefault, path }: { seff: Id; l?: CallLink; c: Ctx; depth: number; open: boolean; path: string }) {
  const [open, setOpen] = useState(openDefault);
  const s = c.g.seffs.get(seff);
  if (!s) return null;
  const op = s.op ? c.g.ops.get(s.op) : undefined;
  const r = l ? realise(c.g, l, c.pl, c.t) : undefined;
  const t = c.total(seff);
  const cyc = path.split('/').includes(seff);
  const links = open && !cyc ? c.g.links(seff) : [];
  const homeCls = s.home?.class ?? op?.homeClass;
  const svc = homeCls ? c.pl.serviceOf(homeCls) : undefined;
  return (
    <li>
      <div className={cn('flex items-start gap-1 rounded py-0.5', op && op.id === c.select && 'bg-accent/60')}>
        <button type="button" onClick={() => setOpen(!open)} className="mt-px grid size-4 shrink-0 cursor-pointer place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={open ? 'Collapse' : 'Expand'} aria-expanded={open}>
          <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        </button>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
            {l && l.kind !== 'root' && <LinkTag l={l} g={c.g} />}
            {op ? <KindBadge op={op} /> : null}
            {op ? <ModelLink target={`op:${op.id}`} className="font-medium" title={op.id}><OpName op={op} /></ModelLink> : <span className="font-medium">{s.kind === 'gateway' ? `gateway · ${s.signature}` : s.signature}</span>}
            {op && <span className="text-[10.5px] text-muted-foreground" title={s.home ? c.t('model.home.chosenTitle', 'the chosen home of the operation (a decision)') : c.t('model.homeClass', 'home class')}>{homeCls}{svc ? ` · ${svc.name}` : ''}</span>}
            {s.home && <span className={cn('rounded border px-1 text-[10px]', s.home.written ? 'text-muted-foreground' : 'border-[color-mix(in_oklab,var(--series-3)_50%,transparent)]')} title={c.t('model.home.optionTitle', 'home of {{op}}: a decision among the classes it writes in its transaction{{#written}}; today\'s{{/written}}{{^written}}; an alternative: the operation\'s calls are re-targeted here{{/written}}', { op: s.home.op, written: s.home.written })}>{s.home.written ? 'home: written' : 'home: alternative'}</span>}
            {s.request && s.kind === 'request' && depth === 0 && <span className="text-[10.5px] text-muted-foreground">as the root of <ModelLink target={`req:${s.request}`}>{s.request}</ModelLink></span>}
            {l && l.p !== 1 && <span className="rounded bg-muted px-1 text-[10px] tabular" title={l.kind === 'event' ? c.t('model.link.eventP', 'raise probability × executions') : 'expected executions per execution of the caller'}>{l.kind === 'event' ? 'p' : '×'} {fmtN(l.p, 3)}</span>}
            {l?.kind === 'event' && l.p === 1 && <span className="rounded bg-muted px-1 text-[10px] tabular" title={c.t('model.link.raiseP', 'raise probability')}>p 1</span>}
            {l?.step && <StepMark step={l.step} c={c} />}
            {op && <AlsoFrom op={op.id} c={c} />}
            <span className="ml-auto whitespace-nowrap text-[10.5px] tabular text-muted-foreground" title={`everything below, per execution: CPU / database, ms of one full core (no middleware)${t.map > 0 ? '; of the CPU mapping (app-side persistence)' : ''}${t.wait > 0 ? c.t('model.totals.wait', '; wait: latency-only DELAY waits, no CPU') : ''}`}>Σ {fmtN(t.cpu, 2)} / {fmtN(t.db, 2)}{t.wait > 0 ? ` / ${fmtN(t.wait, 2)} wait` : ''} ms{t.map > 0 ? ` (map ${fmtN(t.map, 2)})` : ''}</span>
          </div>
          {l && r && l.kind !== 'root' && (
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <MechSet r={r} pl={c.pl} />
              <LinkLevel l={l} g={c.g} model={c.model} />
              <Realisation r={r} pl={c.pl} />
            </div>
          )}
        </div>
      </div>
      {open && !cyc && links.length > 0 && (
        <ul className="ml-[7px] space-y-0.5 border-l pl-2 text-[11.5px]">
          {links.map((x) => (x.kind === 'access' || x.kind === 'db'
            ? <AccessRow key={x.key} l={x} c={c} />
            : (() => { const to = activeSeff(c.model, c.g, x.to, c.pl); return <OpNode key={x.key} seff={to} l={to === x.to ? x : { ...x, to }} c={c} depth={depth + 1} open={depth < 0} path={`${path}/${seff}`} />; })()))}
        </ul>
      )}
      {open && cyc && <div className="ml-6 text-[10.5px] text-muted-foreground">(recursion)</div>}
    </li>
  );
});

/** the tree below one SEFF: a request's gateway SEFF, an entry point's root SEFF, an operation's SEFF */
export function CallTree({ model, roots, ctx, entry, select, openDepth = 1 }: { model: InputModel; roots: Id[]; ctx: DesignContext | null; entry?: Id; select?: Id; openDepth?: number }) {
  const g = callGraph(model);
  const pl = usePlacement(model, ctx);
  const ix = useSeffIndex(model);
  const t = useT();
  const c: Ctx = useMemo(() => ({ model, g, pl, entry, total: ix.total, select, t }), [model, g, pl, entry, ix, select, t]);
  return (
    <ul className="space-y-1 text-xs">
      {roots.map((s) => <OpNodeOpen key={s} seff={s} c={c} openDepth={openDepth} />)}
    </ul>
  );
}

/** the root node: opened, and its children opened to `openDepth` */
function OpNodeOpen({ seff, c, openDepth }: { seff: Id; c: Ctx; openDepth: number }) {
  // depth counts from -openDepth so that OpNode's `depth < 0` opens the first levels
  return <OpNode seff={seff} c={c} depth={-openDepth} open path="" />;
}

/** a path from an entry point down to an operation, as a breadcrumb of links */
export function PathLine({ model, entry, links, ctx }: { model: InputModel; entry: Id; links: CallLink[]; ctx: DesignContext | null }) {
  const g = callGraph(model);
  const pl = usePlacement(model, ctx);
  const t = useT();
  const e = g.ops.get(entry)!;
  return (
    <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5">
      <KindBadge op={e} />
      <ModelLink target={`op:${e.id}`} className="font-medium"><OpName op={e} /></ModelLink>
      {links[0]?.request && <span className="text-[10px] text-muted-foreground">({links[0].request})</span>}
      {links.map((l) => {
        const o: ModelOperation | undefined = l.op ? g.ops.get(l.op) : undefined;
        const r = realise(g, l, pl, t);
        return (
          <span key={l.key} className="inline-flex flex-wrap items-center gap-1">
            <span className="text-muted-foreground">→</span>
            <LinkTag l={l} g={g} compact />
            <MechSet r={r} pl={pl} compact />
            {l.kind === 'call' && !l.site && <LinkLevel l={l} g={g} model={model} />}
            {r.together !== undefined && <PlacementBadge together={r.together} to={r.calleeSvc?.name} where={pl.label} />}
            {l.kind === 'event' && <span className="text-[10px] tabular text-muted-foreground">p {fmtN(l.p, 3)}</span>}
            {o && <ModelLink target={`op:${o.id}`} className="font-medium"><OpName op={o} /></ModelLink>}
          </span>
        );
      })}
    </div>
  );
}
