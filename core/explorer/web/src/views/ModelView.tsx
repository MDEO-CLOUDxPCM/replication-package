/**
 * The Model panel: how the packet's system is the optimisation's input — the domain model, the
 * operations ("functions/endpoints") and what they touch, the workload, the metamodels, and how a
 * design is built from them. The packet's capabilities choose and order the tabs (`modelTabs`, the Verify tab only
 * with `verify`); its texts carry what is specific to the case. URL: `model=<target>` (lib/modelTarget.ts), `mtab`
 * (a tab chosen by hand), `mgroup`, `mattr` (domain diagram), `mview`, `mused` (metamodel diagram).
 */
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { InputModel } from '@contract/types';
import { Search } from 'lucide-react';
import { useDomain } from '@/lib/api';
import { useCapabilities } from '@/lib/packet';
import { Loading, Problem } from '@/components/States';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { useElementWidth } from '@/lib/useWidth';
import { patchUrl, useUrlParams, workspaceActions } from '@/lib/useWorkspace';
import { MODEL_TABS, parseTarget, tabOf, type ModelTab } from '@/lib/modelTarget';
import { cn } from '@/lib/utils';
import { DomainTab } from '@/model/DomainTab';
import { HowTab } from '@/model/HowTab';
import { InteractionsTab } from '@/model/InteractionsTab';
import { MetamodelTab } from '@/model/MetamodelTab';
import { OpsTab } from '@/model/OpsTab';
import { useDesignContext, useModelData } from '@/model/shared';
import { VerifyTab } from '@/model/verify/VerifyTab';
import { WorkloadTab } from '@/model/WorkloadTab';
import { MText, useT, type T } from '@/model/text';

const KEYS = ['model', 'mtab', 'mgroup', 'mattr', 'mview', 'mused'] as const;

/** jump anywhere: classes, operations, request types, sessions, metamodel classes */
function ModelSearch({ items }: { items: { target: string; label: string; kind: string }[] }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const hits = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [];
    return items.filter((x) => x.label.toLowerCase().includes(t)).sort((a, b) => Number(!a.label.toLowerCase().startsWith(t)) - Number(!b.label.toLowerCase().startsWith(t)) || a.label.length - b.label.length).slice(0, 14);
  }, [q, items]);
  const go = (t: string) => { workspaceActions.openModel(t); setOpen(false); setQ(''); };
  return (
    <Popover open={open && hits.length > 0} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className="relative w-[200px] min-w-0 shrink">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input value={q} onChange={(e) => { setQ(e.target.value); setOpen(true); setActive(0); }} onFocus={() => setOpen(true)} placeholder="Find class, operation, …"
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(hits.length - 1, a + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
              else if (e.key === 'Enter' && hits[active]) go(hits[active].target);
              else if (e.key === 'Escape') setOpen(false);
            }}
            className="h-7 w-full rounded-md border bg-transparent pl-7 pr-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50" aria-label="Find in the model" />
        </div>
      </PopoverAnchor>
      <PopoverContent align="end" className="w-80 p-1" onOpenAutoFocus={(e) => e.preventDefault()}>
        <ul>
          {hits.map((h, i) => (
            <li key={h.target}>
              <button type="button" onMouseEnter={() => setActive(i)} onClick={() => go(h.target)} className={cn('flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1 text-left text-xs', i === active && 'bg-accent')}>
                <span className="min-w-0 flex-1 truncate">{h.label}</span><span className="shrink-0 text-[10.5px] text-muted-foreground">{h.kind}</span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

export default memo(function ModelView() {
  const sp = useUrlParams(KEYS);
  const { run, model, error, loading } = useModelData();
  const { data: domain } = useDomain(run?.domainId);
  const ctx = useDesignContext(model);
  const root = useRef<HTMLDivElement>(null);
  const width = useElementWidth(root);
  const narrow = (width ?? 1200) < 820;
  const target = parseTarget(sp.get('model'));
  const caps = useCapabilities();
  const t = useT();
  // the packet's tabs in its order (while it loads: all); the Verify tab only with the capability
  const tabs = useMemo(() => {
    if (!caps.loaded) return MODEL_TABS;
    const order = caps.modelTabs ?? MODEL_TABS.map((x) => x.id);
    return order.flatMap((id) => MODEL_TABS.filter((x) => x.id === id)).filter((x) => x.id !== 'verify' || caps.verify);
  }, [caps]);
  const wanted: ModelTab = (sp.get('mtab') as ModelTab | null) ?? tabOf(target);
  const tab: ModelTab = tabs.some((x) => x.id === wanted) ? wanted : tabs[0]?.id ?? 'how';
  // a link (a new target) brings its node into view in the diagrams
  const [focusKey, setFocusKey] = useState(0);
  const rawTarget = sp.get('model');
  useEffect(() => { setFocusKey((k) => k + 1); }, [rawTarget]);
  const items = useMemo(() => (model ? [
    ...model.classes.map((c) => ({ target: `class:${c.id}`, label: c.id, kind: 'class' })),
    ...model.operations.map((o) => ({ target: `op:${o.id}`, label: o.id, kind: o.kind })),
    ...model.requests.map((r) => ({ target: `req:${r.id}`, label: r.id, kind: 'request type' })),
    ...model.sessions.map((s) => ({ target: `session:${s.id}`, label: s.name, kind: 'session' })),
    ...model.metamodels.flatMap((m) => m.classes.map((c) => ({ target: `mm:${m.id}/${c.name}`, label: c.name, kind: m.layer }))),
    ...[...new Set(model.parameters.map((p) => p.class))].map((c) => ({ target: `param:${c}`, label: c, kind: 'parameter' })),
  ] : []), [model]);

  if (loading) return <Loading label="Loading the input model" />;
  if (error || !model) return <Problem title="No input model">{error ? String(error) : 'Pick a run first.'} <MText code="" text={t('model.view.noModel', 'The input model is models/<domain>.json of the run\'s bundle.')} /></Problem>;

  let body: React.ReactNode;
  if (tab === 'domain') body = <DomainTab model={model} domain={domain} target={target} ctx={ctx} group={sp.get('mgroup') ?? 'service'} attrs={sp.get('mattr') === '1'} narrow={narrow} focusKey={focusKey} />;
  else if (tab === 'ops') body = <OpsTab model={model} opId={target?.kind === 'op' ? target.id : undefined} ctx={ctx} narrow={narrow} />;
  else if (tab === 'workload') body = <WorkloadTab model={model} domain={domain} target={target} ctx={ctx} narrow={narrow} />;
  // the Verify tab opened on a class, operation or request type of another tab shows its part (same keys)
  else if (tab === 'verify') body = <VerifyTab model={model} partKey={target?.kind === 'verify' ? target.id : target && target.id && ['class', 'op', 'req'].includes(target.kind) ? `${target.kind}:${target.id}` : undefined} narrow={narrow} />;
  else if (tab === 'mech') body = <InteractionsTab model={model} kindId={target?.kind === 'mech' ? target.id : undefined} />;
  else if (tab === 'mm') body = <MetamodelTab model={model} mmId={target?.kind === 'mm' ? target.id ?? 'domain' : 'domain'} cls={target?.kind === 'mm' ? target.sub : undefined} part={sp.get('mview')} usedParam={sp.get('mused')} narrow={narrow} focusKey={focusKey} />;
  else body = <HowTab model={model} target={target} />;

  return (
    <div ref={root} className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b px-2 py-1">
        <div role="tablist" aria-label="Model" className="flex shrink-0 items-center rounded-md border p-0.5">
          {tabs.map((x) => (
            <button key={x.id} type="button" role="tab" aria-selected={tab === x.id}
              onClick={() => patchUrl(x.id === tabOf(target) ? { mtab: null } : { mtab: x.id })}
              className={cn('h-6 cursor-pointer rounded-[5px] px-2 text-xs transition-colors', tab === x.id ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground')}>
              {x.label}
            </button>
          ))}
        </div>
        {ctx && <span className="hidden min-w-0 truncate text-[11px] text-muted-foreground @2xl:inline" title="the Model panel shows where things live in design A">design A: <b className="font-medium text-foreground">{ctx.label}</b></span>}
        <div className="ml-auto flex min-w-[6.5rem] shrink justify-end"><ModelSearch items={items} /></div>
      </div>
      {run?.tags?.includes('earlier-model') && (
        // a run of an earlier model (the backend compares its seed's fingerprint with the input model's seeds)
        <div className="border-b bg-[color-mix(in_oklab,var(--status-warning)_12%,transparent)] px-3 py-1 text-[11px]" role="note">
          <b className="font-medium">Earlier model.</b> The run <i>{run.name}</i> started from a seed that is none of the current input model&apos;s (its fingerprint, contract 1.5.0): this panel shows the current input model, whose corrections and decisions the run&apos;s designs may not have.
        </div>
      )}
      <Freshness f={model.freshness} t={t} />
      <div className="min-h-0 flex-1">{body}</div>
    </div>
  );
});

/** the input model against its inputs (server/model-sync.ts): being exported again, stale (no rebuild allowed), or a step before it to run */
function Freshness({ f, t }: { f: InputModel['freshness']; t: T }) {
  if (!f) return null;
  const lines: ReactNode[] = [];
  if (f.state === 'updating') lines.push(<><b className="font-medium">Updating the input model.</b> Changed since its export: {f.changed.join(', ')}. It reloads by itself.</>);
  if (f.state === 'failed') lines.push(<><b className="font-medium">The input model could not be exported again</b> ({f.changed.join(', ')} changed): <code className="whitespace-pre-wrap">{f.error}</code></>);
  if (f.state === 'stale') lines.push(<MText code="" text={t('model.view.stale', '**The input model is older than its inputs** ({{changed}}): rebuild the packet.', { changed: f.changed.join(', ') })} />);
  for (const g of f.ungenerated) lines.push(<MText code="" text={t('model.view.ungenerated', '**{{model}} is older than what it is generated from** ({{inputs}}): generate it again.', { model: g.model, inputs: g.inputs.join(', ') })} />);
  const unrealised = f.unrealised.filter((u) => !f.ungenerated.some((g) => g.model === u.source));
  if (unrealised.length) lines.push(<MText code="" text={t('model.view.unrealised', '**Realised seeds older than their models** ({{seeds}}): realise them again.', { seeds: unrealised.map((u) => `${u.seed} ← ${u.source}`).join(', ') })} />);
  if (!lines.length) return null;
  return (
    <div className={cn('space-y-0.5 border-b px-3 py-1 text-[11px]', f.state === 'updating' ? 'bg-muted/60' : 'bg-[color-mix(in_oklab,var(--status-warning)_12%,transparent)]')} role="status">
      {lines.map((l, i) => <p key={i}>{l}</p>)}
    </div>
  );
}
