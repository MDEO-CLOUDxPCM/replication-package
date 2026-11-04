import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, CircleHelp, Search } from 'lucide-react';
import type { Id, InputModel, ModelOperation, SeffPart } from '@contract/types';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { workspaceActions } from '@/lib/useWorkspace';
import { OwnData, PlacementBadge, placementLabel } from '@/components/PlacementBadge';
import { EffectCallChip, LevelChip } from '@/components/LevelChip';
import { callConsistency, readConsistency } from '@contract/consistency';
import { cn } from '@/lib/utils';
import { OperationDetail } from './details';
import { callGraph, realise, type CallGraph, type CallLink, type Placement } from './callGraph';
import { LinkTag, usePlacement } from './CallTree';
import { KindBadge, MechChip, ModelLink, fmtN, fmtRate, useKindLabel, type DesignContext } from './shared';
import { MText, useT, type T } from './text';

const KINDS = ['query', 'mutation', 'resolver', 'reaction', 'callback'] as const;
type View = 'entries' | 'downstream' | 'all';

const WHY_ENTRIES = 'Users trigger **queries and mutations** (the root resolvers of the request types\' gateway plans), an external provider triggers its **callbacks**. **Field resolvers** and **event reactions** run only as consequences of these, yet they are operations of their own: each has its own home class, so it runs where the cut puts its data, its own accesses and SEFF, it is shared by several triggers, and a reaction runs with its event\'s raise probability.';
const WHY_SITES = 'They are reached only through **call sites** of the entry points, and how each call is made is decided per design: a field is a local call when co-located and a gateway join (federation) or a cache when apart — the join switches with the cut; an event is one site per (raise, reaction), sync or async, and in-process without a broker when co-located; a write of another class is a sync or async saga step; a read of another class is sync, a cache or a local copy fed by events (so a copy adds events) unless its consistency level is **strict** (sync only); a call of another operation is sync or a cache, sync only when strict; an effect call (a registration with an external provider) is sync only.';

/** why field resolvers and reactions are operations of their own, and that their calls are decided per design */
export function WhyDownstream({ className }: { className?: string }) {
  const t = useT();
  const why = [t('model.ops.why.entries', WHY_ENTRIES), t('model.ops.why.sites', WHY_SITES)].filter(Boolean);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" aria-label="Why downstream operations are separate" title="Why downstream operations are separate operations"
          className={cn('inline-grid size-4 shrink-0 cursor-pointer place-items-center rounded-full text-muted-foreground/80 hover:text-foreground', className)}>
          <CircleHelp className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" collisionPadding={12} className="w-[min(30rem,calc(100vw-2rem))] space-y-2 text-xs">
        <p className="font-medium">Entry points and what they reach</p>
        {why.map((x) => <p key={x}><MText text={x} strong="" /></p>)}
        <p className="text-muted-foreground">Each link below shows its kind, its allowed mechanisms and, with design A selected, A's mechanism and its placement in A (else today's): no hop (caller and callee in one container) or remote → service; own data is the home class's own schema, with its fixed mechanism (a read sync, a write in transaction).</p>
      </PopoverContent>
    </Popover>
  );
}

interface Row { key: string; depth: number; op?: ModelOperation; link?: CallLink; part?: SeffPart; request?: Id; seff?: Id; hasKids: boolean; entry: Id }

/** a SEFF's parts in order: its own work and its calls (reads and writes of other classes, its own schema, operations) */
function parts(g: CallGraph, seff: Id): { part: SeffPart; link?: CallLink }[] {
  const s = g.seffs.get(seff);
  if (!s) return [];
  const byKey = new Map(g.links(seff).map((l) => [l.key, l]));
  return s.parts.flatMap((part, i) => {
    if (part.t === 'work') return [{ part }];
    const link = byKey.get(`${seff}#${i}`);
    return link ? [{ part, link }] : [];
  });
}
/** a SEFF that calls nothing: a leaf, its work shown on its row */
const calls = (g: CallGraph, seff: Id) => parts(g, seff).some((x) => x.link);

/** the visible rows of the entry-point tree: entries, their request SEFFs when several, the parts of opened nodes */
function treeRows(g: CallGraph, entries: Id[], open: Set<string>): Row[] {
  const out: Row[] = [];
  const kids = (seff: Id, key: string, depth: number, entry: Id, path: Set<Id>) => {
    parts(g, seff).forEach(({ part, link: l }, i) => {
      if (!l) { out.push({ key: `${key}/${seff}~${i}`, depth, part, hasKids: false, entry }); return; }
      const k = `${key}/${l.key}`;
      const cyc = path.has(l.to);
      const has = !cyc && calls(g, l.to);
      out.push({ key: k, depth, op: l.op ? g.ops.get(l.op) : undefined, link: l, seff: l.to, hasKids: has, entry });
      if (has && open.has(k)) kids(l.to, k, depth + 1, entry, new Set(path).add(l.to));
    });
  };
  for (const id of entries) {
    const e = g.entryOf.get(id)!;
    const key = `e:${id}`;
    const multi = e.roots.length > 1;
    out.push({ key, depth: 0, op: g.ops.get(id), hasKids: multi || e.roots.some((r) => parts(g, r.seff).length > 0), entry: id, seff: multi ? undefined : e.roots[0]?.seff });
    if (!open.has(key)) continue;
    if (multi) for (const r of e.roots) {
      const k = `${key}|${r.seff}`;
      const has = parts(g, r.seff).length > 0;
      out.push({ key: k, depth: 1, request: r.request, seff: r.seff, hasKids: has, entry: id });
      if (has && open.has(k)) kids(r.seff, k, 2, id, new Set([r.seff]));
    }
    else if (e.roots[0]) kids(e.roots[0].seff, key, 1, id, new Set([e.roots[0].seff]));
  }
  return out;
}

/** a work part as a short label: CPU work, the mapping, the DB server's SQL, a step's envelope, a latency-only wait */
const workLabel = (p: SeffPart) => (p.resource === 'DELAY' ? 'wait' : p.name === 'map' ? 'map' : p.name === 'sql' ? 'sql' : p.name === 'envelope' ? 'envelope' : p.name === 'cacheHit' ? 'cache hit' : 'work');
const workTitle = (p: SeffPart, t: T) => (p.resource === 'DELAY' ? t('model.work.wait', 'latency-only wait: statements × round trip + commits × commit delay (no CPU)')
  : p.name === 'map' ? 'mapping CPU (app-side persistence)' : p.name === 'sql' ? 'the database server\'s CPU for the statements' : p.name === 'envelope' ? t('model.work.envelopeShort', 'the receiving envelope of a step form{{#est}}, an estimate{{/est}}', { est: p.estimate }) : 'own CPU work');
/** the work of a leaf's SEFF, per execution of the caller, by resource */
function leafWork(g: CallGraph, seff: Id, p: number): string {
  const by = new Map<string, number>();
  for (const x of g.seffs.get(seff)?.parts ?? []) if (x.t === 'work') { const r = x.resource === 'DELAY' ? 'wait' : x.name === 'sql' ? 'sql' : 'CPU'; by.set(r, (by.get(r) ?? 0) + (x.ms ?? 0) * (x.p ?? 1) * p); }
  return [...by].map(([r, ms]) => `${fmtN(ms, 2)} ${r}`).join(' · ');
}

/** the key of an operation's node under its first entry point, and the keys to open on the way */
function firstPath(g: CallGraph, op: Id): { key: string; open: string[] } | null {
  if (g.entryOf.has(op)) return { key: `e:${op}`, open: [`e:${op}`] };
  const p = g.paths(op, 1)[0];
  if (!p) return null;
  const e = g.entryOf.get(p.entry)!;
  let key = `e:${p.entry}`;
  const open = [key];
  if (e.roots.length > 1) { key = `${key}|${p.links[0].from}`; open.push(key); }
  p.links.forEach((l, i) => { key = `${key}/${l.key}`; if (i < p.links.length - 1) open.push(key); });
  return { key, open };
}

/**
 * in the compact list only what makes a link sync only by its level: a strict read of another class or a strict
 * call (the level and its rules; the reason in the tooltip), an effect call behind a provider callback
 */
function StrictMark({ l, g, texts }: { l: CallLink; g: CallGraph; texts?: InputModel['consistency'] }) {
  const caller = l.caller ? g.ops.get(l.caller) : undefined;
  const c = l.kind === 'access' && l.mode === 'read' ? readConsistency(caller, l.cls) : l.kind === 'call' ? callConsistency(caller, l.op) : undefined;
  if (c?.level === 'strict') return <LevelChip c={c} texts={texts} what={l.kind === 'call' ? 'call' : 'read'} className="max-w-[7rem]" />;
  if (l.kind === 'callback' && caller?.effectCalls?.length) return <EffectCallChip to={caller.effectCalls[0].to} rules={caller.effectCalls[0].rules} reason={caller.effectCalls[0].reason} texts={texts} />;
  return null;
}

const NavRow = memo(function NavRow({ r, g, pl, selected, sameOp, onToggle: toggleKey, onSelect: selectRow, isOpen, texts }: { r: Row; g: CallGraph; pl: Placement; selected: boolean; sameOp: boolean; onToggle: (k: string) => void; onSelect: (r: Row) => void; isOpen: boolean; texts?: InputModel['consistency'] }) {
  const onToggle = () => toggleKey(r.key);
  const onSelect = () => selectRow(r);
  const op = r.op;
  const cls = r.link && !op ? r.link.cls : undefined;
  const t = useT();
  const real = r.link && r.link.kind !== 'db' ? realise(g, r.link, pl, t) : undefined;
  const leaf = r.link && !r.hasKids && r.seff ? leafWork(g, r.seff, r.link.p) : '';
  const others = op && r.depth > 0 ? (g.reachedFrom.get(op.id) ?? []).filter((e) => e !== r.entry) : [];
  return (
    <li data-key={r.key} onClick={() => (op ? onSelect() : onToggle())}
      className={cn('flex cursor-pointer items-center gap-1.5 border-b border-border/40 py-1 pr-2 text-xs hover:bg-accent/60', selected ? 'bg-accent' : sameOp && 'bg-accent/40')}
      style={{ paddingLeft: 6 + r.depth * 14 }}>
      {r.hasKids ? (
        <button type="button" onClick={(e) => { e.stopPropagation(); onToggle(); }} aria-label={isOpen ? 'Collapse' : 'Expand'} aria-expanded={isOpen}
          className="grid size-4 shrink-0 cursor-pointer place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground">
          <ChevronRight className={cn('size-3 transition-transform', isOpen && 'rotate-90')} />
        </button>
      ) : <span className="size-4 shrink-0" />}
      {r.link && <LinkTag l={r.link} g={g} compact />}
      {op ? <KindBadge op={op} /> : null}
      {r.part && <span className="shrink-0 rounded bg-muted px-1 text-[9.5px] font-semibold uppercase text-muted-foreground" title={workTitle(r.part, t)}>{workLabel(r.part)}</span>}
      <span className="min-w-0 flex-1 truncate" title={op?.id ?? cls ?? r.part?.name ?? r.request}>
        {r.part ? <span className="tabular text-muted-foreground">{fmtN(r.part.ms, 3)} ms{r.part.p !== undefined && r.part.p !== 1 ? ` × ${fmtN(r.part.p, 3)}` : ''}{r.part.estimate ? '*' : ''}</span>
          : cls ? <><ModelLink target={`class:${cls}`} className={r.link!.kind === 'db' ? 'text-muted-foreground' : undefined}>{r.link!.what ?? cls}</ModelLink>{r.link!.p !== 1 && <span className="ml-1 text-[10px] tabular text-muted-foreground">× {fmtN(r.link!.p, 3)}</span>}</>
          : op ? <>{op.kind === 'reaction' || op.kind === 'callback' ? <span className="text-muted-foreground">{op.service}.</span> : null}{op.name}</> : <span className="text-muted-foreground">as the root of <span className="text-foreground">{r.request}</span></span>}
        {op && r.depth === 0 && <span className="ml-1.5 text-[10.5px] text-muted-foreground">{pl.serviceOf(op.homeClass)?.name ?? op.service}</span>}
      </span>
      {leaf && <span className="shrink-0 text-[10px] tabular text-muted-foreground" title="the work below, ms per execution of the caller: own CPU, the database server's SQL, latency-only waits">{leaf}</span>}
      {others.length > 0 && <span className="shrink-0 rounded bg-muted px-1 text-[9.5px] text-muted-foreground" title={`also reached from ${others.map((e) => g.ops.get(e)?.name ?? e).join(', ')}`}>+{others.length}</span>}
      {real && r.link!.kind === 'event' && <span className="shrink-0 text-[10px] tabular text-muted-foreground" title="raise probability">p {r.link!.p < 0.995 ? r.link!.p.toFixed(2) : '1'}</span>}
      {r.link && <StrictMark l={r.link} g={g} texts={texts} />}
      {r.link?.kind === 'db' && !r.link.commit && <OwnData mode={r.link.mode} />}
      {real && <MechChip m={real.mech} active title={`${pl.label}: ${real.mech}${real.together === undefined ? '' : `, ${placementLabel(real.together, real.calleeSvc?.name)}`} · allowed ${real.allowed.join(', ')} · ${real.text}`} />}
      {real && real.together !== undefined && <PlacementBadge together={real.together} to={real.calleeSvc?.name} where={pl.label} className="max-w-[9rem]" />}
      {op && r.depth === 0 && <span className="w-14 shrink-0 text-right tabular text-muted-foreground">{fmtRate(op.rate)}</span>}
    </li>
  );
});

/** the operations: entry points (queries, mutations, provider callbacks) and, below each, what it reaches through its call sites */
export function OpsTab({ model, opId, ctx, narrow }: { model: InputModel; opId?: string; ctx: DesignContext | null; narrow: boolean }) {
  const g = useMemo(() => callGraph(model), [model]);
  const pl = usePlacement(model, ctx);
  const [q, setQ] = useState('');
  const [view, setView] = useState<View>('entries');
  const [kinds, setKinds] = useState<Set<string>>(new Set());
  const [svc, setSvc] = useState('all');
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [selKey, setSelKey] = useState<string | null>(null);
  const services = useMemo(() => [...new Set(model.operations.map((o) => o.service))].sort(), [model]);
  const tx = useT();
  const kindLabel = useKindLabel();
  const t = q.trim().toLowerCase();
  const match = (o: ModelOperation) => !t || o.id.toLowerCase().includes(t) || o.homeClass.toLowerCase().includes(t) || (o.trigger ?? '').toLowerCase().includes(t) || o.accesses.some((a) => a.class.toLowerCase() === t);
  const flat = useMemo(() => model.operations.filter((o) => (view === 'all' || !g.entryOf.has(o.id)) && (!kinds.size || kinds.has(o.kind)) && (svc === 'all' || o.service === svc) && match(o))
    .sort((a, b) => b.rate - a.rate), [model, g, view, kinds, svc, t]); // eslint-disable-line react-hooks/exhaustive-deps
  // entry points whose name or anything downstream matches the filter
  const entries = useMemo(() => g.entries.filter((e) => {
    const o = g.ops.get(e.op)!;
    if (svc !== 'all' && o.service !== svc) return false;
    if (!t) return true;
    return match(o) || model.operations.some((x) => match(x) && (g.reachedFrom.get(x.id) ?? []).includes(e.op));
  }).map((e) => e.op), [g, model, svc, t]); // eslint-disable-line react-hooks/exhaustive-deps
  // rows keep their object while unchanged, so the memoised rows do not re-render when another node opens
  const rowCache = useRef(new Map<string, Row>());
  const rows = useMemo(() => {
    if (view !== 'entries') return [];
    const c = rowCache.current;
    return treeRows(g, entries, open).map((r) => { const o = c.get(r.key); if (o && o.hasKids === r.hasKids && o.op === r.op) return o; c.set(r.key, r); return r; });
  }, [view, g, entries, open]);

  // a link (op:<id>) opens the tree at that operation, under its first entry point; a click in the tree keeps its own row
  useEffect(() => {
    if (!opId) return;
    if (selKey && rows.some((r) => r.key === selKey && r.op?.id === opId)) return;
    if (view !== 'entries') return;
    const p = firstPath(g, opId);
    if (!p) return;
    setOpen((o) => { const n = new Set(o); for (const k of p.open) n.add(k); return n; });
    setSelKey(p.key);
  }, [opId, g, view]); // eslint-disable-line react-hooks/exhaustive-deps
  const list = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!selKey) return;
    const el = list.current?.querySelector(`[data-key="${CSS.escape(selKey)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selKey, rows.length]);

  const op = opId ? g.ops.get(opId) : undefined;
  const toggle = useCallback((k: string) => setOpen((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n; }), []);
  const selectRow = useCallback((r: Row) => { setSelKey(r.key); if (r.op) workspaceActions.openModel(`op:${r.op.id}`); }, []);
  const toggleKind = (k: string) => { const n = new Set(kinds); if (n.has(k)) n.delete(k); else n.add(k); setKinds(n); };
  const downstreamN = model.operations.length - g.entries.length;
  return (
    <ResizablePanelGroup key={narrow ? 'v' : 'h'} orientation={narrow ? 'vertical' : 'horizontal'} className="h-full">
      <ResizablePanel defaultSize={narrow ? '42%' : '40%'} minSize="24%">
        <div className="flex h-full flex-col">
          <div className="space-y-1.5 border-b p-2">
            <div className="flex items-center gap-1.5">
              <div className="relative min-w-0 flex-1">
                <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Filter ${model.operations.length} operations (name, topic, class)`} className="h-7 pl-7 text-xs" />
              </div>
              <div role="tablist" aria-label="Operations shown" className="flex shrink-0 items-center rounded-md border p-0.5">
                {([['entries', 'Entry points'], ['downstream', 'Downstream'], ['all', 'All']] as const).map(([v, label]) => (
                  <button key={v} type="button" role="tab" aria-selected={view === v} onClick={() => setView(v)}
                    className={cn('h-5 cursor-pointer rounded-[4px] px-1.5 text-[11px] transition-colors', view === v ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground')}>{label}</button>
                ))}
              </div>
              <WhyDownstream />
            </div>
            <div className="flex flex-wrap items-center gap-1">
              {view !== 'entries' && KINDS.map((k) => (
                <button key={k} type="button" onClick={() => toggleKind(k)} aria-pressed={kinds.has(k)}
                  className={cn('cursor-pointer rounded-md border px-1.5 py-0.5 text-[10.5px] transition-colors', kinds.has(k) ? 'border-foreground/40 bg-accent font-medium' : 'text-muted-foreground hover:bg-accent/60')}>
                  {kindLabel.label(k)} <span className="tabular opacity-70">{model.operations.filter((o) => o.kind === k && (view === 'all' || !g.entryOf.has(o.id))).length}</span>
                </button>
              ))}
              {view === 'entries' && <span className="min-w-0 truncate text-[10.5px] text-muted-foreground" title="the request types' root resolvers and the provider callbacks reach the downstream operations through call sites">{g.entries.length} entry points → {downstreamN} downstream</span>}
              <Select value={svc} onValueChange={setSvc}>
                <SelectTrigger size="sm" className="ml-auto h-6 w-[120px] text-[11px]" aria-label="Service of origin"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="all">all services</SelectItem>{services.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          <div className="truncate px-3 py-1 text-[10.5px] text-muted-foreground">
            {view === 'entries' ? <span title={`chip: the call's mechanism in ${pl.label}; badge: no hop or remote → service (the placement); +n: also reached from n other entry points`}>{entries.length} shown · by rate · chip: {pl.design ? "A's" : "today's"} mechanism · badge: placement · +n: shared</span> : <>{flat.length} shown · by rate · service = today's</>}
          </div>
          <ScrollArea className="min-h-0 flex-1">
            {view === 'entries' ? (
              <ul ref={list}>
                {rows.map((r) => <NavRow key={r.key} r={r} g={g} pl={pl} texts={model.consistency} selected={r.key === selKey && r.op?.id === opId} sameOp={!!opId && r.op?.id === opId} isOpen={open.has(r.key)}
                  onToggle={toggle} onSelect={selectRow} />)}
              </ul>
            ) : (
              <ul>
                {flat.map((o) => (
                  <li key={o.id} onClick={() => workspaceActions.openModel(`op:${o.id}`)}
                    className={cn('flex cursor-pointer items-center gap-2 border-b border-border/50 px-3 py-1.5 text-xs hover:bg-accent/60', o.id === opId && 'bg-accent')}>
                    <KindBadge op={o} />
                    <span className="min-w-0 flex-1 truncate" title={o.id}>{o.name}<span className="ml-1.5 text-[10.5px] text-muted-foreground">{o.service}</span></span>
                    {!g.entryOf.has(o.id) && <span className="shrink-0 text-[10px] text-muted-foreground" title={`reached from ${(g.reachedFrom.get(o.id) ?? []).join(', ')}`}>from {(g.reachedFrom.get(o.id) ?? []).length}</span>}
                    <span className="w-14 shrink-0 text-right tabular text-muted-foreground">{fmtRate(o.rate)}</span>
                  </li>
                ))}
              </ul>
            )}
          </ScrollArea>
        </div>
      </ResizablePanel>
      <ResizableHandle withHandle />
      <ResizablePanel defaultSize={narrow ? '58%' : '60%'} minSize="30%">
        <ScrollArea className="h-full">
          {op ? <OperationDetail model={model} op={op} ctx={ctx} /> : (
            <div className="space-y-2 p-4 text-xs text-muted-foreground">
              <p className="text-sm text-foreground">The {model.operations.length} operations of the derived model: {g.entries.length} entry points and {downstreamN} downstream operations.</p>
              {[tx('model.ops.about', 'An operation is one entry point that does work: a GraphQL query or mutation, a field resolver that loads related classes, an entity resolver, a reaction to a domain event, a callback of an external provider. The model holds the ones the workload reaches: each runs in the component of its home class, as a SEFF of timed parts — its own work, one call per accessed class and mode, its calls of other operations, the request\'s further fields and its events.'),
                tx('model.ops.reach', 'Users trigger the queries and mutations, the provider its callbacks; field resolvers and event reactions follow through call sites whose mechanism each design decides. Open an entry point for what it reaches; pick an operation for what it touches, who reaches it and how.')].filter(Boolean).map((x) => <p key={x}>{x}</p>)}
            </div>
          )}
        </ScrollArea>
      </ResizablePanel>
    </ResizablePanelGroup>
  );
}
