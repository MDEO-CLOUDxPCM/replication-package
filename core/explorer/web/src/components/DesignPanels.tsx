import { Fragment, useMemo, useState } from 'react';
import { Check, Search, X } from 'lucide-react';
import type { Design, Domain, Id, Mechanism, Run } from '@contract/types';
import type { DerivedDesign } from '@contract/derive';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { MechanismBadge } from './MechanismBadge';
import { fmt } from '@/lib/format';
import { useHover } from '@/lib/store';
import { PlacementBadge } from '@/components/PlacementBadge';
import { cn } from '@/lib/utils';
import { ScrollArea } from '@/components/ui/scroll-area';
import { MetricHelp } from '@/help/MetricHelp';
import { Rich } from '@/help/Rich';
import { useTexts, useVocab } from '@/lib/packet';
import { usePanelAvailable } from '@/lib/useWorkspace';
import { ModelJump } from '@/help/ModelJump';
import { MechChip, ModelLink } from '@/model/shared';
import { EFFECT_MECH_LABEL, JOIN_BLOCKER_LABEL, JOIN_BLOCKER_SHORT, effectRealised } from '@contract/effects';
import type { DerivedEffect } from '@contract/derive';

const KIND_LABEL: Record<string, string> = { query: 'Q', mutation: 'M', handler: 'E', internal: 'I' };

export function Overview({ run, design }: { run: Run; design: Design }) {
  return (
    <div className="space-y-4 p-3">
      <div className="grid grid-cols-2 gap-2">
        {run.objectives.map((o, k) => (
          <div key={o.key} className="rounded-md border bg-card px-2.5 py-2">
            <div className="flex items-center gap-1 text-[11px] text-muted-foreground">{o.label} {o.direction === 'minimize' ? '↓' : '↑'}<MetricHelp k={o.key} className="ml-auto" /></div>
            <div className="text-base font-semibold">{fmt(design.objectives[k], o.digits ?? 2)}<span className="ml-1 text-xs font-normal text-muted-foreground">{o.unit}</span></div>
          </div>
        ))}
      </div>
      <div>
        <div className="mb-1 text-xs font-medium">Constraints</div>
        <ul className="space-y-1 text-xs">
          {run.constraints.map((c, k) => {
            const v = design.constraints[k] ?? 0;
            return (
              <li key={c.key} className="flex items-center gap-2">
                {v <= 1e-12 ? <Check className="size-3.5 text-[var(--status-good)]" /> : <X className="size-3.5 text-[var(--status-critical)]" />}
                <span>{c.label}</span>
                <MetricHelp k={c.key} />
                <span className="ml-auto tabular text-muted-foreground">{v <= 1e-12 ? 'met' : `violated by ${fmt(v, 3)}`}</span>
              </li>
            );
          })}
        </ul>
      </div>
      {run.metrics.length > 0 && (
        <div>
          <div className="mb-1 text-xs font-medium">Metrics</div>
          <dl className="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-xs">
            {run.metrics.map((m) => <Fragment key={m.key}><dt className="flex items-center gap-1 text-muted-foreground">{m.label}<MetricHelp k={m.key} /></dt><dd className="tabular text-right">{fmt(design.metrics[m.key], m.digits ?? 2)}{m.unit ? ` ${m.unit}` : ''}</dd></Fragment>)}
          </dl>
        </div>
      )}
      <div className="flex flex-wrap gap-1.5 text-xs">
        {design.rank === 0 && <Badge>non-dominated</Badge>}
        {design.inArchive && <Badge variant="secondary">archive</Badge>}
        {design.inFinalPopulation && <Badge variant="secondary">final population</Badge>}
        {design.born !== undefined && <Badge variant="outline">born gen. {design.born}</Badge>}
        {design.died !== undefined && design.died !== null && <Badge variant="outline">left archive gen. {design.died}</Badge>}
      </div>
      <div className="font-mono text-[10px] text-muted-foreground">hash {design.hash}</div>
    </div>
  );
}

export function ServicesPanel({ domain, design, derived, accent, onHover }: { domain: Domain; design: Design; derived: DerivedDesign; accent: (s: Id) => string | null; onHover: (s: Id | null) => void }) {
  const d = design.decisions!;
  return (
    <div className="divide-y">
      {d.services.map((s) => {
        const db = d.databases.find((x) => x.services.includes(s.id));
        const ops = derived.opsByService.get(s.id) ?? [];
        const r = s.replicas;
        return (
          <div key={s.id} className="px-3 py-2.5 text-xs hover:bg-accent/50" onMouseEnter={() => onHover(s.id)} onMouseLeave={() => onHover(null)}>
            <div className="flex items-center gap-2">
              {accent(s.id) ? <span className="h-3 w-1 rounded-full" style={{ background: accent(s.id)! }} /> : <span className="h-3 w-1 rounded-full bg-border" />}
              <span className="font-semibold">{s.name}</span>
              <span className="ml-auto text-muted-foreground">{ops.length} ops</span>
            </div>
            <div className="mt-1 text-muted-foreground">{s.classes.map((c, i) => <Fragment key={c}>{i ? ', ' : ''}<ModelLink target={`class:${c}`} title={`${c} in the Model panel`}>{domain.classes.find((x) => x.id === c)?.name ?? c}</ModelLink></Fragment>)}</div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <Badge variant="outline" className="h-5 text-[10.5px]">{r.mode === 'fixed' ? `${r.count} replica${r.count === 1 ? '' : 's'}` : `HPA ${r.min}–${r.max} @ ${Math.round(r.targetUtilisation * 100)} %`}</Badge>
              <Badge variant="outline" className="h-5 text-[10.5px]">{db?.placement === 'shared' ? `shared db: ${db.services.map((x) => d.services.find((y) => y.id === x)?.name).join(', ')}` : 'own database'}</Badge>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function OperationsPanel({ domain, derived, pinned, onPin }: { domain: Domain; derived: DerivedDesign; pinned: string | null; onPin: (id: string | null) => void }) {
  const [q, setQ] = useState('');
  const setHoveredOp = useHover((s) => s.setHoveredOp);
  const tx = useTexts();
  const model = usePanelAvailable('model');
  const svcName = (s: Id) => s;
  const remote = useMemo(() => {
    const m = new Map<Id, number>();
    for (const a of derived.accesses) if (a.mechanism) m.set(a.op, (m.get(a.op) ?? 0) + 1);
    return m;
  }, [derived]);
  const ops = useMemo(() => {
    const t = q.toLowerCase();
    return domain.operations.filter((o) => !t || o.name.toLowerCase().includes(t) || o.id.toLowerCase().includes(t) || (o.feature ?? '').toLowerCase() === t)
      .sort((a, b) => (b.rate ?? 0) - (a.rate ?? 0));
  }, [domain, q]);
  void svcName;
  return (
    <div className="flex h-full flex-col">
      <div className="relative border-b p-2">
        <Search className="absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Filter ${domain.operations.length} operations (name or feature code)`} className="h-8 pl-7 text-xs" />
      </div>
      <div className="px-3 py-1.5 text-[11px] text-muted-foreground">hover: highlight its classes and calls · click: pin{model ? ' · book: in the Model panel' : ''} · sorted by rate</div>
      <ScrollArea className="min-h-0 flex-1">
        <ul>
          {ops.map((o) => {
            const r = remote.get(o.id) ?? 0;
            return (
              <li key={o.id} data-op-row
                className={cn('group flex cursor-pointer items-center gap-2 border-b border-border/50 px-3 py-1.5 text-xs hover:bg-accent/60', pinned === o.id && 'bg-accent')}
                onMouseEnter={() => setHoveredOp(o.id)} onMouseLeave={() => setHoveredOp(null)} onClick={() => onPin(pinned === o.id ? null : o.id)}>
                <span title={tx(`arch.ops.kind.${o.kind}`) || undefined} className="grid size-4 shrink-0 place-items-center rounded bg-muted text-[9px] font-semibold text-muted-foreground">{KIND_LABEL[o.kind]}</span>
                <span className="min-w-0 flex-1 truncate" title={o.id}>{o.name}</span>
                {r > 0 && <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground" title="cross-service accesses">{r} remote</span>}
                <span className="w-14 shrink-0 text-right tabular text-muted-foreground">{o.rate ? `${fmt(o.rate, o.rate < 1 ? 2 : 1)}/s` : '–'}</span>
                <ModelJump target={`op:${o.id}`} title={`${o.name} in the Model panel: what it touches, how it expands`} />
              </li>
            );
          })}
        </ul>
      </ScrollArea>
    </div>
  );
}

export function AccessesPanel({ domain, design, derived }: { domain: Domain; design: Design; derived: DerivedDesign }) {
  const [filter, setFilter] = useState<Mechanism | null>(null);
  const setHoveredOp = useHover((s) => s.setHoveredOp);
  const name = (s: Id) => design.decisions!.services.find((x) => x.id === s)?.name ?? s;
  const opName = new Map(domain.operations.map((o) => [o.id, o.name]));
  const cross = derived.accesses.filter((a): a is typeof a & { mechanism: Mechanism } => !!a.mechanism).sort((a, b) => b.rate - a.rate);
  const shown = filter ? cross.filter((a) => a.mechanism === filter) : cross;
  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap gap-1 border-b p-2">
        {(['sync', 'copy', 'cache', 'join', 'saga'] as Mechanism[]).map((m) => (
          <button key={m} onClick={() => setFilter(filter === m ? null : m)} className={cn('rounded-md p-0.5', filter === m ? 'ring-2 ring-ring' : 'opacity-90 hover:opacity-100')} aria-pressed={filter === m}>
            <MechanismBadge m={m} /> <span className="text-[10px] tabular text-muted-foreground">{derived.mechanismCounts[m]}</span>
          </button>
        ))}
      </div>
      <div className="px-3 py-1.5 text-[11px] text-muted-foreground">{shown.length} cross-service accesses (remote) · {derived.accesses.length - cross.length} within a service (no hop, no mechanism)</div>
      <ScrollArea className="min-h-0 flex-1">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-card text-left text-[11px] text-muted-foreground"><tr><th className="px-3 py-1 font-medium">operation → class</th><th className="font-medium">mechanism</th><th className="pr-3 text-right font-medium">rate</th></tr></thead>
          <tbody>
            {shown.map((a) => (
              <tr key={a.key} className="border-b border-border/50 hover:bg-accent/60" onMouseEnter={() => setHoveredOp(a.op)} onMouseLeave={() => setHoveredOp(null)}>
                <td className="max-w-0 px-3 py-1.5">
                  <div className="truncate" title={a.op}><ModelLink target={`op:${a.op}`}>{opName.get(a.op)}</ModelLink> <span className="text-muted-foreground">{a.mode === 'write' ? 'writes' : 'reads'}</span> <ModelLink target={`class:${a.cls}`}>{a.cls}</ModelLink></div>
                  <div className="truncate text-[10.5px] text-muted-foreground">{name(a.from)} <PlacementBadge together={false} to={name(a.to)} /></div>
                </td>
                <td className="whitespace-nowrap"><MechanismBadge m={a.mechanism} /></td>
                <td className="pr-3 text-right tabular text-muted-foreground">{fmt(a.rate, a.rate < 1 ? 2 : 1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollArea>
    </div>
  );
}

/**
 * (1.4.0) the design's effect steps: per step its mechanism and whether it joins the caller's transaction
 * (a direct call inside it: no envelope, commit or message), else why not: apart, other database server, orchestrated, external
 */
export function EffectsPanel({ domain, design, derived }: { domain: Domain; design: Design; derived: DerivedDesign }) {
  const [filter, setFilter] = useState<string | null>(null);
  const setHoveredOp = useHover((s) => s.setHoveredOp);
  const tx = useTexts();
  const name = (s: Id) => design.decisions!.services.find((x) => x.id === s)?.name ?? s;
  const opName = new Map(domain.operations.map((o) => [o.id, o.name]));
  const groupOf = (e: DerivedEffect) => (e.state.joined ? 'joined' : e.state.m === 'inTx' ? `inTx:${e.state.why}` : e.state.m);
  const groups = useMemo(() => {
    const m = new Map<string, number>();
    for (const e of derived.effects) m.set(groupOf(e), (m.get(groupOf(e)) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [derived]);
  if (!derived.effects.length) return <div className="p-3 text-xs text-muted-foreground">{tx('arch.effects.none') || 'This run has no effect steps.'}</div>;
  const about = tx('arch.effects.about');
  const shown = (filter ? derived.effects.filter((e) => groupOf(e) === filter) : derived.effects).slice().sort((a, b) => Number(!!b.state.joined) - Number(!!a.state.joined) || a.op.localeCompare(b.op));
  const label = (g: string) => (g === 'joined' ? 'joined' : g.startsWith('inTx:') ? `in tx, not joined: ${JOIN_BLOCKER_SHORT[g.slice(5) as keyof typeof JOIN_BLOCKER_SHORT]}` : EFFECT_MECH_LABEL[g as 'sync' | 'async']);
  return (
    <div className="flex h-full flex-col">
      <div className="space-y-1 border-b p-2">
        {design.decisions!.homes && Object.keys(design.decisions!.homes).length > 0 && (
          // the home of an operation as a decision: where it enters (its root SEFF), among the classes it writes in its transaction
          <div className="rounded border bg-card px-2 py-1 text-[10.5px]">
            <div className="font-medium">{tx('arch.effects.homes.title') || 'Homes'}</div>
            {Object.entries(design.decisions!.homes).map(([op, c]) => [op, c, domain.homes?.find((h) => h.op === op)?.written] as const).sort((x, y) => Number(x[1] === x[2]) - Number(y[1] === y[2])).map(([op, c, w]) => (
              <div key={op} className="flex gap-1"><ModelLink target={`op:${op}`}>{opName.get(op) ?? op}</ModelLink><span className="text-muted-foreground">enters at</span><ModelLink target={`class:${c}`} className={cn(w && c !== w && 'font-semibold')}>{c}</ModelLink>{w && c !== w && <span className="text-muted-foreground">(today {w})</span>}<span className="ml-auto text-muted-foreground">{name(derived.serviceOf.get(c) ?? '')}</span></div>
            ))}
          </div>
        )}
        {about && <p className="text-[10.5px] text-muted-foreground"><Rich text={about} strong="font-medium text-foreground" /></p>}
        <div className="flex flex-wrap gap-1">
          {groups.map(([g, n]) => (
            <button key={g} type="button" onClick={() => setFilter(filter === g ? null : g)} aria-pressed={filter === g}
              className={cn('rounded border px-1.5 py-px text-[10.5px]', filter === g ? 'border-foreground/50 bg-accent font-medium' : 'bg-card text-muted-foreground hover:text-foreground')}>
              {label(g)} <span className="tabular">{n}</span>
            </button>
          ))}
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-card text-left text-[11px] text-muted-foreground"><tr><th className="px-3 py-1 font-medium">step: operation → class</th><th className="pr-3 font-medium">mechanism</th></tr></thead>
          <tbody>
            {shown.map((e) => (
              <tr key={e.id} className="border-b border-border/50 hover:bg-accent/60" onMouseEnter={() => setHoveredOp(e.op)} onMouseLeave={() => setHoveredOp(null)} title={effectRealised(e.state)}>
                <td className="max-w-0 px-3 py-1.5">
                  <div className="[overflow-wrap:anywhere]"><ModelLink target={`op:${e.op}`}>{opName.get(e.op) ?? e.op}</ModelLink> <span className="text-muted-foreground">{e.kind === 'write' ? 'writes' : e.kind === 'event' ? 'raises, reacts at' : 'calls back'}</span> <ModelLink target={`class:${e.class}`}>{e.class}</ModelLink></div>
                  <div className="truncate text-[10.5px] text-muted-foreground">{name(e.from)} <PlacementBadge together={e.from === e.to} to={name(e.to)} />{e.event ? ` · ${e.event}` : ''}</div>
                </td>
                <td className="whitespace-nowrap pr-3">
                  <div className="flex items-center gap-1"><MechChip m={e.state.m} active />{e.state.joined && <Badge variant="secondary" className="h-4 px-1 text-[9.5px]">joined</Badge>}</div>
                  {!e.state.joined && e.state.why && e.state.why !== 'chosen' && <div className="text-[10px] text-muted-foreground" title={JOIN_BLOCKER_LABEL[e.state.why]}>{e.state.m === 'inTx' ? 'sync step: ' : ''}{JOIN_BLOCKER_SHORT[e.state.why]}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ScrollArea>
    </div>
  );
}

export function SagasPanel({ domain, design, derived }: { domain: Domain; design: Design; derived: DerivedDesign }) {
  const name = (s: Id) => design.decisions!.services.find((x) => x.id === s)?.name ?? s;
  const setHoveredOp = useHover((s) => s.setHoveredOp);
  const vocab = useVocab();
  return (
    <div className="space-y-3 p-3 text-xs">
      {domain.processes.filter((p) => !p.transaction?.home || p.transaction.home === (design.decisions!.homes?.[p.trigger] ?? domain.homes?.find((h) => h.op === p.trigger)?.written)).map((p) => {
        const s = derived.sagas.find((x) => x.process === p.id);
        return (
          <div key={p.id} className="rounded-md border bg-card p-2.5">
            <div className="flex items-center gap-2">
              <span className="font-semibold">{p.name}</span>
              {s ? <Badge variant={s.style === 'orchestration' ? 'default' : 'secondary'} className="h-5 text-[10.5px]">{vocab.label('styles', s.style)}</Badge> : <Badge variant="outline" className="h-5 text-[10.5px]">one transaction</Badge>}
              <span className="ml-auto text-muted-foreground">{s ? `${s.services.length} services` : 'one service'}</span>
            </div>
            {s?.orchestrator && <div className="mt-1 text-muted-foreground">orchestrator: {name(s.orchestrator)}</div>}
            {p.transaction ? (
              // a transaction workflow: the trigger's bound writes; a separated one commits on its own
              <ol className="mt-2 space-y-0.5">
                <li className="flex items-center gap-2 rounded px-1 hover:bg-accent/60" onMouseEnter={() => setHoveredOp(p.trigger)} onMouseLeave={() => setHoveredOp(null)}>
                  <span className="w-4" />
                  <span className="min-w-0 flex-1 truncate">{domain.operations.find((o) => o.id === p.trigger)?.name ?? p.trigger} <span className="text-muted-foreground">(trigger)</span></span>
                  <ModelJump target={`op:${p.trigger}`} />
                  <span className="text-muted-foreground">{name(derived.opService.get(p.trigger) ?? '')}</span>
                </li>
                {p.transaction.writes.map((c, i) => {
                  const apart = derived.serviceOf.get(c) !== derived.opService.get(p.trigger);
                  // (1.4.0) the write's effect step: joined = in the trigger's transaction, else a step with its own commit
                  const step = derived.effects.find((e) => e.kind === 'write' && e.op === p.trigger && e.class === c);
                  const tip = step ? effectRealised(step.state) : apart ? 'separated: a saga step that commits on its own' : 'no hop: a direct call in the trigger\'s transaction';
                  const what = step ? (step.state.joined ? '(joined: same transaction)' : `(${step.state.m === 'async' ? 'async message' : 'sync step'}, own commit)`) : apart ? '(own commit)' : '(same transaction)';
                  return (
                    <li key={c} className="flex items-center gap-2 rounded px-1 hover:bg-accent/60" title={tip}>
                      <span className="w-4 text-right tabular text-muted-foreground">{i + 1}</span>
                      <span className="min-w-0 flex-1 truncate">writes {c} <span className="text-muted-foreground">{what}</span></span>
                      <ModelJump target={`class:${c}`} />
                      <span className="text-muted-foreground">{name(derived.serviceOf.get(c) ?? '')}</span>
                    </li>
                  );
                })}
              </ol>
            ) : <ol className="mt-2 space-y-0.5">
              {p.steps.map((st, i) => {
                const op = domain.operations.find((o) => o.id === st);
                return (
                  <li key={st} className="group flex items-center gap-2 rounded px-1 hover:bg-accent/60" onMouseEnter={() => setHoveredOp(st)} onMouseLeave={() => setHoveredOp(null)}>
                    <span className="w-4 text-right tabular text-muted-foreground">{i + 1}</span>
                    <span className="min-w-0 flex-1 truncate">{op?.name ?? st}</span>
                    <ModelJump target={`op:${st}`} />
                    <span className="text-muted-foreground">{name(derived.opService.get(st) ?? '')}</span>
                  </li>
                );
              })}
            </ol>}
          </div>
        );
      })}
    </div>
  );
}

export function RawDecisions({ design }: { design: Design }) {
  const entries = Object.entries(design.rawDecisions ?? {});
  return (
    <div className="p-3 text-xs">
      <p className="mb-2 text-muted-foreground">This design carries no decisions in the domain form: its decisions are a link map of a layer-2 model and cannot be drawn as a domain cut. {entries.length} decisions:</p>
      <table className="w-full">
        <tbody>
          {entries.map(([k, v]) => <tr key={k} className="border-b border-border/50"><td className="py-1 pr-2 font-mono text-[10.5px] text-muted-foreground">{k}</td><td className="font-mono text-[10.5px]">{v}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}

export function DesignTabs({ tab, onTab, tabs }: { tab: string; onTab: (t: string) => void; tabs: { id: string; label: string; content: React.ReactNode; ownScroll?: boolean }[] }) {
  return (
    <Tabs value={tab} onValueChange={onTab} className="flex h-full min-h-0 flex-col gap-0">
      <TabsList className="m-2 mb-0 w-[calc(100%-1rem)]">
        {tabs.map((t) => <TabsTrigger key={t.id} value={t.id} className="text-xs">{t.label}</TabsTrigger>)}
      </TabsList>
      {tabs.map((t) => (
        <TabsContent key={t.id} value={t.id} className="mt-2 min-h-0 flex-1 border-t data-[state=inactive]:hidden">{t.ownScroll ? t.content : <ScrollArea className="h-full">{t.content}</ScrollArea>}</TabsContent>
      ))}
    </Tabs>
  );
}
