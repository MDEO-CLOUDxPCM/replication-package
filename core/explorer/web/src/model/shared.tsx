import { useMemo, type ReactNode } from 'react';
import type { Design, Id, InputModel, ModelOperation, Run } from '@contract/types';
import { useDesign, useInputModel, useRun } from '@/lib/api';
import { usePacket, useTexts, useVocab } from '@/lib/packet';
import { MECHANISM_STYLE, PALETTES, edgeColor } from '@/lib/palette';
import { useTheme } from '@/lib/theme';
import { usePanelAvailable, useSelectionState, workspaceActions } from '@/lib/useWorkspace';
import { cn } from '@/lib/utils';

/** a link to a place in the Model panel (opens the panel when used elsewhere) */
export function ModelLink({ target, children, className, title }: { target: string; children: ReactNode; className?: string; title?: string }) {
  // a packet without the Model panel: plain text (the link would lead nowhere)
  if (!usePanelAvailable('model')) return <span title={title} className={className}>{children}</span>;
  return (
    <button type="button" title={title} onClick={(e) => { e.stopPropagation(); workspaceActions.openModel(target); }}
      className={cn('cursor-pointer rounded-sm text-left underline decoration-border decoration-1 underline-offset-2 transition-colors hover:text-foreground hover:decoration-foreground/60', className)}>
      {children}
    </button>
  );
}

/** a call site's mechanism (sync, async, inTx, cache, copy, join, joinCache) as the graph draws it */
const SITE_STYLE: Record<string, keyof typeof MECHANISM_STYLE> = { sync: 'sync', async: 'saga', inTx: 'inTx', cache: 'cache', copy: 'copy', join: 'join', joinCache: 'join' };

/** a mechanism's label (the packet's vocabulary, else its id) */
export function useMechLabel(): (m: string) => string {
  const v = useVocab();
  return useMemo(() => (m: string) => v.label('mechanisms', m), [v]);
}

export function MechChip({ m, active, muted, title }: { m: string; active?: boolean; muted?: boolean; title?: string }) {
  const { theme } = useTheme();
  const v = useVocab();
  const tx = useTexts();
  const st = MECHANISM_STYLE[SITE_STYLE[m] ?? 'sync'];
  return (
    <span title={title ?? (tx(`model.mechTitle.${m}`) || st.description)} className={cn('inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10.5px] leading-tight', active ? 'border-foreground/40 bg-card font-medium text-foreground' : 'bg-card/50 text-muted-foreground', muted && 'opacity-60')}>
      <svg width="10" height="4" aria-hidden><line x1="0" y1="2" x2="10" y2="2" stroke={edgeColor(PALETTES[theme], SITE_STYLE[m] ?? 'sync')} strokeWidth="2.5" strokeDasharray={st.dash ? '3 2' : undefined} /></svg>
      {v.label('mechanisms', m)}
    </span>
  );
}

/** an operation kind's label and short letter (the packet's vocabulary, else the id and its initial) */
export function useKindLabel(): { label: (k: string) => string; short: (k: string) => string } {
  const v = useVocab();
  return useMemo(() => ({ label: (k: string) => v.label('operationKinds', k), short: (k: string) => v.entry('operationKinds', k)?.short ?? k.charAt(0).toUpperCase() }), [v]);
}

export function KindBadge({ op }: { op: Pick<ModelOperation, 'kind'> }) {
  const k = useKindLabel();
  return <span title={k.label(op.kind)} className="grid size-4 shrink-0 place-items-center rounded bg-muted text-[9px] font-semibold text-muted-foreground">{k.short(op.kind)}</span>;
}

/** design A as the Model panel reads it: where classes and operations live, each site's mechanism */
export interface DesignContext {
  label: string;
  design: Design;
  run: Run;
  serviceOf: Map<Id, { id: Id; name: string }>;
  /** the schema's database server (seed placement overlaid with the design's decision links) */
  serverOf: (cls: Id) => string;
  opService: (op: ModelOperation) => { id: Id; name: string } | undefined;
  /** the mechanism of a call site in the design (the design's link, else the run seed's) */
  siteMech: (site: Id) => string | undefined;
  /** the run's seed: neutral, today or monolith */
  seed: string;
}

export function useDesignContext(model: InputModel | undefined): DesignContext | null {
  const { a } = useSelectionState();
  const { data: run } = useRun(a?.runId);
  const { data: design } = useDesign(a?.runId, a?.designId);
  return useMemo(() => {
    if (!model || !run || !design?.decisions || run.domainId !== model.domainId) return null;
    const seedPath = String(run.config.raw?.modelSeed ?? '');
    const seed = /today/.test(seedPath) ? 'today' : /monolith/.test(seedPath) ? 'monolith' : 'neutral';
    const raw = design.rawDecisions ?? {};
    const serviceOf = new Map<Id, { id: Id; name: string }>();
    for (const s of design.decisions.services) for (const c of s.classes) serviceOf.set(c, { id: s.id, name: s.name });
    const cls = new Map(model.classes.map((c) => [c.id, c]));
    const sites = new Map(model.sites.map((s) => [s.id, s]));
    return {
      label: design.label ?? design.id.slice(0, 10), design, run, serviceOf, seed,
      serverOf: (c: Id) => { const x = cls.get(c); return raw[`alloc_${x?.schema}.resourceContainer`] ?? x?.placement?.[seed]?.server ?? '?'; },
      opService: (op: ModelOperation) => serviceOf.get(op.homeClass),
      siteMech: (id: Id) => { const s = sites.get(id); return raw[`${id}.mechanism`] ?? (s ? (s as unknown as Record<string, string | undefined>)[seed] : undefined); },
    };
  }, [model, run, design]);
}

/** the workspace run's domain and its input model */
export function useModelData() {
  const ws = useSelectionState();
  const { data: run } = useRun(ws.run ?? ws.a?.runId ?? undefined);
  const q = useInputModel(run?.domainId);
  return { run, model: q.data, error: q.error, loading: q.isLoading || (!run && !!ws.run) };
}

/** request rate × visits: executions per second of an operation per session class */
export function sessionRates(model: InputModel, op: ModelOperation) {
  const visits = new Map(op.reach.map((r) => [r.request, r.visits]));
  return model.sessions.map((s) => ({ session: s, rate: s.visits.reduce((x, v) => x + s.sessionsPerS * v.visits * (visits.get(v.request) ?? 0), 0) })).filter((x) => x.rate > 0);
}

export function Section({ title, children, right, className }: { title: ReactNode; children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <section className={cn('space-y-1.5', className)}>
      <div className="flex items-baseline gap-2"><h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{title}</h3>{right && <div className="ml-auto text-[11px] text-muted-foreground">{right}</div>}</div>
      {children}
    </section>
  );
}

/**
 * a repo path of the project (or, with a commit, of the system under study at the extraction's commit: the label of
 * the packet's first `git` source tree, or of the tree named), copied on click
 */
export function RepoPath({ path, commit, tree, className }: { path: string; commit?: string; tree?: string; className?: string }) {
  const sources = usePacket()?.manifest.sources;
  const src = tree ? sources?.[tree] : Object.values(sources ?? {}).find((s) => s.kind === 'git');
  const label = commit ? src?.label : undefined;
  const text = commit ? `${label ? `${label}@` : ''}${commit.slice(0, 12)}:${path}` : path;
  return (
    <button type="button" title={`${text} (click to copy)`} onClick={(e) => { e.stopPropagation(); void navigator.clipboard?.writeText(commit ? path : path).catch(() => undefined); }}
      className={cn('max-w-full cursor-pointer truncate rounded bg-muted px-1 py-px text-left font-mono text-[10.5px] text-muted-foreground hover:text-foreground', className)}>
      {label && <span className="opacity-70">{label} </span>}{path}
    </button>
  );
}

export const fmtN = (v: number | undefined, d = 2) => (v === undefined || !Number.isFinite(v) ? '–' : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(d));
export const fmtRate = (v: number) => (v >= 10 ? `${v.toFixed(1)}/s` : v >= 0.1 ? `${v.toFixed(2)}/s` : v > 0 ? `${v.toPrecision(2)}/s` : '–');
