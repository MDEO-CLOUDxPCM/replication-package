/**
 * How one request (or one operation) expands in the model: its SEFF's parts in order — own work,
 * accesses to classes (own data or another class's component, with the database time), calls,
 * events, provider callbacks and the request's further fields into other operations' SEFFs — with
 * multiplicities, the call sites' allowed mechanisms, today's and design A's choice. The base model: the middleware the realisation adds for remote calls is not shown.
 */
import { memo, useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { Id, InputModel, ModelSeff, SeffPart } from '@contract/types';
import { OwnData, PlacementBadge } from '@/components/PlacementBadge';
import { EffectCallChip, LevelChip, LockMark } from '@/components/LevelChip';
import { callConsistency, readConsistency } from '@contract/consistency';
import { cn } from '@/lib/utils';
import { MechChip, ModelLink, fmtN, type DesignContext } from './shared';
import { accessesName } from './accessName';
import { useT, type T } from './text';

/** CPU and database demand below a SEFF, ms of one full core; `map` the mapping CPU within cpu, `wait` latency-only DELAY waits */
export interface Totals { cpu: number; db: number; map: number; wait: number }

interface Index {
  seffs: Map<Id, ModelSeff>;
  ops: Map<Id, InputModel['operations'][number]>;
  sites: Map<Id, InputModel['sites'][number]>;
  total: (seff: Id) => Totals;
  /** where the demands come from: the model's timing label ("campaign v3, k_c applied") */
  timing: string;
  /** the packet's texts */
  t: T;
  /** (1.13.0) the case's texts of the consistency levels and rules */
  consistency: InputModel['consistency'];
}

/** the model's timing source (absent: the seed's timings) */
export const timingLabel = (model: InputModel) => model.timing?.label ?? 'seed timings';

export function useSeffIndex(model: InputModel): Index {
  const tx = useT();
  return useMemo(() => {
    const seffs = new Map(model.seffs.map((s) => [s.id, s]));
    const memo = new Map<Id, Totals>();
    const total = (id: Id, depth = 0): Totals => {
      if (memo.has(id)) return memo.get(id)!;
      const s = seffs.get(id);
      const t = { cpu: 0, db: 0, map: 0, wait: 0 };
      if (s && depth < 40) {
        for (const p of s.parts) {
          const v = (p.ms ?? 0) * (p.p ?? 1);
          if (p.t === 'work') {
            if (p.resource === 'DELAY') t.wait += v;
            else if (s.kind === 'db') t.db += v;
            else { t.cpu += v; if (p.name === 'map') t.map += v; }
          } else if (p.to) { const c = total(p.to, depth + 1); for (const k of ['cpu', 'db', 'map', 'wait'] as const) t[k] += c[k] * (p.p ?? 1); }
        }
      }
      memo.set(id, t);
      return t;
    };
    return { seffs, ops: new Map(model.operations.map((o) => [o.id, o])), sites: new Map(model.sites.map((s) => [s.id, s])), total, timing: timingLabel(model), t: tx, consistency: model.consistency };
  }, [model, tx]);
}

/** what a work part is: own work, mapping CPU (split from work or an action of its own), a latency-only wait, a provider's cache hit */
function workLabel(p: SeffPart, s: ModelSeff, timing: string, t: T): string {
  if (p.name === 'work') return `own work (${timing})`;
  if (p.name === 'map') return p.split ? `mapping CPU of the home class's accesses (${timing}; in the model part of work)` : `mapping CPU (${timing}; runs where ${s.class ?? s.component} runs)`;
  if (p.resource === 'DELAY') return t('model.work.wait', 'latency-only wait: statements × round trip + commits × commit delay (no CPU)');
  if (p.name === 'cacheHit') return t('model.work.cacheHit', "a hit of the provider's cache");
  if (p.name === 'envelope' && s.kind === 'envelope') return t('model.work.receiving', 'the receiving envelope of a synchronous call across containers (receiving the request, dispatch, decoding, the answer){{#est}}: an estimate{{/est}}', { est: p.estimate });
  if (p.name === 'envelope') return t('model.work.envelope', 'the receiving envelope of the step in its own transaction (dispatch, decode, transaction, idempotency){{#est}}: an estimate{{/est}}', { est: p.estimate });
  return p.name;
}

const CALL_LABEL: Record<string, string> = { root: 'root resolver', call: 'calls', event: 'event →', callback: 'provider calls back', field: 'field', work: 'the step\'s work', commit: 'B\'s commit', other: 'calls' };

function SiteChips({ site, ctx, ix }: { site?: Id; ctx: DesignContext | null; ix: Index }) {
  const s = site ? ix.sites.get(site) : undefined;
  if (!s) return <span className="text-[10.5px] text-muted-foreground" title="no call site: only one mechanism is allowed (a strict read or call, an effect call: synchronous)">sync only</span>;
  const inA = ctx?.siteMech(s.id);
  return (
    <span className="inline-flex flex-wrap items-center gap-1" title={`call site ${s.id}`}>
      {s.allowed.map((m) => <MechChip key={m} m={m} active={inA ? m === inA : m === s.today} title={`${m}${m === s.today ? ' · today' : ''}${inA === m ? ` · in ${ctx!.label}` : ''}${m === s.neutral ? ' · neutral seed' : ''}`} />)}
      <span className="text-[10px] text-muted-foreground">{inA ? `A: ${inA}` : ''}{s.today ? `${inA ? ' · ' : ''}today: ${s.today}` : ''}</span>
    </span>
  );
}

function AccessLine({ part, owner, ix, ctx, m }: { part: SeffPart; owner: ModelSeff; ix: Index; ctx: DesignContext | null; m: number }) {
  const target = part.to ? ix.seffs.get(part.to) : undefined;
  const cls = target?.class;
  const mode = /^write/.test(part.name) ? 'write' : 'read';
  const op = owner.op ? ix.ops.get(owner.op) : undefined;
  // one access per reference share the call: their statements together, named by what they touch
  const accs = op?.accesses.filter((a) => a.class === cls && a.mode === mode) ?? [];
  const acc = accs.length ? { ...accs[0], count: accs.reduce((s, a) => s + a.count, 0), cpuMs: accs.reduce((s, a) => s + a.cpuMs, 0) } : undefined;
  // the read group's level: its call site is shared, the strictest decides
  const lv = mode === 'read' ? readConsistency(op, cls) : undefined;
  const what = cls ? accessesName(op, cls, mode) : undefined;
  const t = part.to ? ix.total(part.to) : { cpu: 0, db: 0, map: 0, wait: 0 };
  // mapping CPU: another class's in its access SEFF (`map`), the home class's own in the operation's work
  const map = part.kind === 'db' ? acc?.cpuMs ?? 0 : t.map;
  const svc = cls && ctx ? ctx.serviceOf.get(cls) : undefined;
  const from = op && ctx ? ctx.opService(op) : undefined;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
      <span className={cn('rounded px-1 text-[10px] font-semibold uppercase', mode === 'write' ? 'bg-[color-mix(in_oklab,var(--series-5)_18%,transparent)]' : 'bg-muted')}>{mode}</span>
      {cls ? <ModelLink target={`class:${cls}`} className="font-medium">{what ?? cls}</ModelLink> : <span>{part.name}</span>}
      {part.kind === 'db' ? <OwnData mode={mode} /> : <span className="text-muted-foreground">{`through ${cls}'s component`}</span>}
      {acc && <span className="text-muted-foreground" title={ix.t('model.seff.stmtTitle', 'statements per execution, shape')}>{fmtN(acc.count)} stmt · {acc.shape.toLowerCase().replace('_', ' ')}</span>}
      <LevelChip c={lv} texts={ix.consistency} own={part.kind === 'db'} />
      {lv?.lock && <LockMark />}
      <span className="tabular text-muted-foreground" title={`database time per execution (${ix.timing})`}>{fmtN(t.db * m, 3)} ms db</span>
      {map > 0 && <span className="tabular text-muted-foreground" title={part.kind === 'db' ? `mapping CPU of the home class's own data (${ix.timing}): part of the operation's work in the model` : `mapping CPU (${ix.timing}): the \`map\` action of ${cls}'s access SEFF, where ${cls} runs`}>{fmtN(map * m, 3)} ms map{part.kind === 'db' ? ' (in work)' : ''}</span>}
      {t.wait > 0 && <span className="tabular text-muted-foreground" title={ix.t('model.seff.waitTitle', 'latency-only wait (DELAY, no CPU): statements × stmtRoundTripMs + commits × commitDelayMs')}>{fmtN(t.wait * m, 3)} ms wait</span>}
      {target?.kind === 'step' && (() => { const env = target.parts.find((x) => x.name === 'envelope'); return <span className="rounded border border-dashed px-1 text-[10px] text-muted-foreground" title={ix.t('model.seff.stepFormTitle', "B's step form: the receiving envelope, the write's work, B's commit; skipped when the step joins the caller's transaction")}>step form{env ? ` +${fmtN(env.ms, 2)} ms envelope${env.estimate ? ' (est.)' : ''}` : ''}</span>; })()}
      {part.envelopeMs ? <span className="rounded border border-dashed px-1 text-[10px] text-muted-foreground" title={ix.t('model.seff.envelopeTitle', "the callee application's receiving envelope, paid in its container only when the call crosses containers")}>+{fmtN(part.envelopeMs, 2)} ms envelope across containers{part.estimate ? ' (est.)' : ''}</span> : null}
      {part.kind === 'access' && <SiteChips site={part.site} ctx={ctx} ix={ix} />}
      {svc && from && part.kind === 'access' && <PlacementBadge together={svc.id === from.id} to={svc.name} where={ctx?.label ? `A (${ctx.label})` : 'A'} />}
    </div>
  );
}

const SeffNode = memo(function SeffNode({ id, ix, ctx, m, depth, open: openDefault, path, label, part, caller }: {
  id: Id; ix: Index; ctx: DesignContext | null; m: number; depth: number; open: boolean; path: Set<Id>; label?: string; part?: SeffPart;
  /** the operation whose SEFF makes the call `part` */
  caller?: Id;
}) {
  const [open, setOpen] = useState(openDefault);
  const s = ix.seffs.get(id);
  if (!s) return null;
  const op = s.op ? ix.ops.get(s.op) : undefined;
  const t = ix.total(id);
  const cyc = path.has(id);
  const next = new Set(path).add(id);
  const work = s.parts.filter((p) => p.t === 'work' && p.resource !== 'DELAY').reduce((x, p) => x + (p.ms ?? 0) * (p.p ?? 1), 0);
  const svc = op && ctx ? ctx.opService(op) : undefined;
  return (
    <li className="relative">
      <div className="flex items-start gap-1 py-0.5">
        <button type="button" onClick={() => setOpen(!open)} className="mt-px grid size-4 shrink-0 cursor-pointer place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={open ? 'Collapse' : 'Expand'}>
          <ChevronRight className={cn('size-3 transition-transform', open && 'rotate-90')} />
        </button>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
          {label && <span className="text-[10.5px] text-muted-foreground">{label}</span>}
          {op ? <ModelLink target={`op:${op.id}`} className="font-medium">{op.name}</ModelLink> : <span className="font-medium">{s.kind === 'gateway' ? `gateway · ${s.signature}` : s.signature}</span>}
          {op && <span className="text-[10.5px] text-muted-foreground">{op.homeClass}</span>}
          {part && (part.p ?? 1) !== 1 && <span className="rounded bg-muted px-1 text-[10px] tabular" title="expected executions per execution of the caller (branch probability or loop count)">× {fmtN(part.p, 3)}</span>}
          {part?.async && <span className="rounded bg-muted px-1 text-[10px]" title="in an asynchronous fork in the seed">async</span>}
          {part && part.kind !== 'access' && (part.envelopeMs ? <span className="rounded border border-dashed px-1 text-[10px] text-muted-foreground" title={ix.t('model.seff.envelopeTitle', "the callee application's receiving envelope, paid in its container only when the call crosses containers")}>+{fmtN(part.envelopeMs, 2)} ms envelope across containers{part.estimate ? ' (est.)' : ''}</span> : null)}
          {part && part.kind !== 'root' && <SiteChips site={part.site} ctx={ctx} ix={ix} />}
          {part?.kind === 'call' && <LevelChip c={callConsistency(caller ? ix.ops.get(caller) : undefined, op?.id)} texts={ix.consistency} what="call" />}
          {part?.kind === 'callback' && caller && ix.ops.get(caller)?.effectCalls?.map((e) => <EffectCallChip key={e.to} to={e.to} rules={e.rules} reason={e.reason} texts={ix.consistency} />)}
          <span className="ml-auto whitespace-nowrap text-[10.5px] tabular text-muted-foreground" title="own work · everything below (CPU / database), per execution, ms of one full core">
            work {fmtN(work, 2)} · Σ {fmtN(t.cpu, 2)} cpu / {fmtN(t.db, 2)} db{t.wait > 0 ? ` / ${fmtN(t.wait, 2)} wait` : ''} ms
          </span>
          {svc && <span className="text-[10.5px] text-muted-foreground">A: {svc.name}</span>}
        </div>
      </div>
      {open && !cyc && (
        <ul className="ml-[7px] space-y-0.5 border-l pl-3 text-[11.5px]">
          {s.parts.map((p, i) => {
            if (p.t === 'work') return (
              <li key={i} className="flex items-center gap-2 py-px text-muted-foreground">
                <span className="rounded bg-muted px-1 text-[10px] font-semibold uppercase">{p.name === 'map' ? 'map' : p.resource === 'DELAY' ? 'wait' : 'work'}</span>
                <span className="tabular">{fmtN(p.ms, 3)} ms {p.resource === 'CPU' ? 'CPU' : p.resource === 'DELAY' ? 'wait' : p.resource}</span>
                {(p.p ?? 1) !== 1 && <span className="tabular">× {fmtN(p.p, 3)}</span>}
                <span className="text-[10.5px]">{workLabel(p, s, ix.timing, ix.t)}</span>
              </li>
            );
            if (p.kind === 'access' || p.kind === 'db') return <li key={i} className="py-px"><AccessLine part={p} owner={s} ix={ix} ctx={ctx} m={1} /></li>;
            if (!p.to) return <li key={i} className="text-muted-foreground">{p.name}</li>;
            return <SeffNode key={i} id={p.to} ix={ix} ctx={ctx} m={m * (p.p ?? 1)} depth={depth + 1} open={depth < 1} path={next} label={CALL_LABEL[p.kind ?? 'other']} part={p} caller={s.op} />;
          })}
        </ul>
      )}
      {open && cyc && <div className="ml-6 text-[10.5px] text-muted-foreground">(recursion)</div>}
    </li>
  );
});

export function SeffTree({ model, seff, ctx, label }: { model: InputModel; seff: Id; ctx: DesignContext | null; label?: string }) {
  const ix = useSeffIndex(model);
  return <ul className="text-xs"><SeffNode id={seff} ix={ix} ctx={ctx} m={1} depth={0} open path={new Set()} label={label} /></ul>;
}
