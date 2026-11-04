import { useEffect, useMemo, useRef } from 'react';
import { ArrowDown } from 'lucide-react';
import type { InputModel, ModelSite } from '@contract/types';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ParamTable } from '@/help/MetricHelpContent';
import { RichText } from '@/help/RichText';
import type { ModelTarget } from '@/lib/modelTarget';
import { cn } from '@/lib/utils';
import type { TextVars } from '@/lib/packet';
import { useDoc } from '@/lib/packet';
import { MechChip, ModelLink, RepoPath, Section, fmtN } from './shared';
import { timingLabel } from './SeffTree';
import { MText, fill, useT, type T } from './text';

/** the packet's How doc (docs `how`): the pipeline, the decisions' realisation, the parameter groups (templates, see lib/packet.tsx) */
interface HowDoc {
  steps?: { title: string; ref?: string; origin: string; text: string; links?: [string, string][] }[];
  decides?: string[];
  realise?: { ref?: string; rows: [string, string, string][] };
  paramGroups?: { title: string; classes: string[]; note: string }[];
}

/** without a packet: the steps of the input model's origin table */
const originSteps = (m: InputModel): NonNullable<HowDoc['steps']> => [...new Set(m.origin.map((o) => o.step))].map((s, i) => ({ title: `${i + 1} · ${s}`, origin: s, text: '' }));

/** without a packet: what a design decides, in general */
const DECIDES = [
  'where each class component runs (an application container) and where each schema lives (a database server): {{classes}} + {{classes}} placements;',
  'the mechanism of each call site: {{byKind}} (allowed options per site in the Operations tab);',
  'the coordination of the sagas: {{sagaList}};',
];

/** the flags the realisation rows' templates select by: the model family's variants (per-site hit ratios, the provider's cache as built, latency waits) */
function realiseFlags(m: InputModel): TextVars {
  return {
    siteHits: m.sites.some((s) => s.hitRatio !== undefined),
    asBuilt: m.sites.some((s) => s.cachedService),
    readCpu: m.parameters.some((p) => p.class === 'LocalCopy' && typeof p.properties.readCpuMs === 'number'),
    latency: m.parameters.some((p) => p.class === 'Latency'),
    networkMs: m.parameters.some((p) => p.class === 'RemoteCalls' && typeof p.properties.networkMs === 'number'),
    homes: (m.homes?.length ?? 0) > 0,
    tx: m.processes.some((p) => p.transaction),
    // effect steps: step forms, joined in transaction
    steps: m.sites.some((s) => s.effect?.step),
    est: m.sites.some((s) => s.effect?.step?.estimate),
    // (1.11.0) receiving envelopes of synchronous calls across containers
    envelopes: (m.envelopes?.length ?? 0) > 0,
    envEst: (m.envelopes ?? []).some((e) => e.estimate),
  };
}

/** how each decision becomes PCM: the doc's rows filled with the model's flags; a row whose decision is empty does not apply */
function realiseRows(m: InputModel, rows: [string, string, string][]): [string, string, string][] {
  const v = realiseFlags(m);
  return rows.map((r) => r.map((x) => fill(x, v)) as [string, string, string]).filter(([d]) => d);
}

/** the hit ratio a site's cache uses: its own, else its mechanism's (CachedCall, or the ComposedCall joinCache) */
function hitOf(m: InputModel, s: ModelSite, mech: 'cache' | 'joinCache'): { v?: number; own: boolean } {
  if (s.hitRatio !== undefined) return { v: s.hitRatio, own: true };
  const p = m.parameters.find((x) => (mech === 'cache' ? x.class === 'CachedCall' : x.class === 'ComposedCall' && typeof x.properties.hitRatio === 'number'));
  return { v: typeof p?.properties.hitRatio === 'number' ? p.properties.hitRatio : undefined, own: false };
}

const CACHE_ROW = 'grid grid-cols-[minmax(0,1fr)_7.5rem_3.6rem_3.6rem_3.2rem] items-start gap-x-2';

/** the call sites that allow a cache: hit ratio, stale share, the provider's cache as built */
function CacheSites({ model, t }: { model: InputModel; t: T }) {
  const rows = useMemo(() => model.sites.filter((s) => s.allowed.includes('cache') || s.allowed.includes('joinCache'))
    .sort((a, b) => (b.hitRatio ?? -1) - (a.hitRatio ?? -1) || a.id.localeCompare(b.id)), [model]);
  const own = rows.some((s) => s.hitRatio !== undefined);
  const note = own ? t('model.how.cache.ownNote') : 'This model has no per-site values: every cache uses its mechanism\'s hit ratio, and O4 weighs a cache\'s hits with min(1, w × TTL).';
  const pct = (v?: number) => (v === undefined ? '–' : v > 0 && v < 0.001 ? `${(v * 100).toPrecision(2)} %` : `${fmtN(v * 100, 1)} %`);
  return (
    <Section title="Caches per call site" right={`${rows.length} sites with a cache option${own ? t('model.how.cache.own', ' · per-site values') : " · the mechanism's hit ratio everywhere"}`}>
      {note && <p className="text-[10.5px] text-muted-foreground">{note}</p>}
      {/* rows as a grid, not a table: the caller wraps and the values keep their columns at any panel width */}
      <div className="text-[11px]">
        <div className={cn(CACHE_ROW, 'pb-0.5 text-[10.5px] text-muted-foreground')}>
          <span>caller · reads</span><span>options</span><span className="text-right">hit cache</span><span className="text-right">hit join+c.</span><span className="text-right" title="share of the hits that are stale (per key)">stale</span>
        </div>
        {rows.map((s) => {
          const hc = s.allowed.includes('cache') ? hitOf(model, s, 'cache') : undefined;
          const hj = s.allowed.includes('joinCache') ? hitOf(model, s, 'joinCache') : undefined;
          return (
            <div key={s.id} className={cn(CACHE_ROW, 'border-t border-border/50 py-0.5')} title={s.id}>
              <span className="min-w-0 [overflow-wrap:anywhere]">
                {s.op ? <ModelLink target={`op:${s.op}`}>{s.op}</ModelLink> : '–'}{s.request && <span className="text-muted-foreground"> ({s.request})</span>}
                <span className="text-muted-foreground"> → </span>
                {s.class ? <ModelLink target={`class:${s.class}`}>{s.class}</ModelLink> : s.callee ? <ModelLink target={`op:${s.callee}`}>{s.callee.slice(s.callee.indexOf('.') + 1)}</ModelLink> : '–'}
                <span className="text-muted-foreground"> {s.kind === 'access' ? 'read' : s.kind}</span>
              </span>
              <span className="inline-flex flex-wrap items-start gap-0.5">
                {s.allowed.filter((x) => x === 'cache' || x === 'joinCache').map((x) => <MechChip key={x} m={x} active={x === s.today} title={x === 'joinCache' && s.cachedService ? `${s.cachedService}: the provider's entity cache (as built)` : undefined} />)}
              </span>
              <span className={cn('text-right tabular', !hc?.own && 'text-muted-foreground')}>{hc ? pct(hc.v) : ''}</span>
              <span className={cn('text-right tabular', !hj?.own && 'text-muted-foreground')}>{hj ? pct(hj.v) : ''}</span>
              <span className="text-right tabular">{pct(s.staleShare)}</span>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

/** the overview: how a design is built from the input model, where the model comes from, the decision layer's parameters */
export function HowTab({ model, target }: { model: InputModel; target: ModelTarget | null }) {
  const box = useRef<HTMLDivElement>(null);
  const param = target?.kind === 'param' ? target.id : undefined;
  const section = target?.kind === 'how' ? target.id : undefined;
  useEffect(() => {
    if (!param) return;
    const el = box.current?.querySelector(`[data-param="${CSS.escape(param)}"]`);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [param]);
  useEffect(() => {
    if (!section) return;
    const el = box.current?.querySelector(`[data-section="${CSS.escape(section)}"]`);
    if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, [section]);
  const counts = useMemo(() => ({
    sites: model.sites.length, options: model.sites.reduce((s, x) => s + x.allowed.length, 0),
    byKind: Object.entries(model.sites.reduce<Record<string, number>>((m, s) => ({ ...m, [s.kind]: (m[s.kind] ?? 0) + 1 }), {})),
  }), [model]);
  const sagas = model.processes.filter((p) => !p.transaction);
  const txs = model.processes.filter((p) => p.transaction && (!p.transaction.home || p.transaction.home.written));
  const t = useT();
  const doc = useDoc<HowDoc>('how');
  const steps = doc?.steps ?? originSteps(model);
  const groups = doc?.paramGroups ?? [{ title: 'Parameters', classes: [...new Set(model.parameters.map((p) => p.class))], note: '' }];
  const decides = (doc?.decides ?? DECIDES).map((x) => fill(x, {
    classes: model.classes.length, byKind: counts.byKind.map(([k, n]) => `${n} ${k}`).join(', '),
    steps: model.sites.some((x) => x.effect?.step), effectSteps: model.sites.filter((x) => x.family === 'effect').length,
    sagaList: sagas.map((p) => `${p.id} (${p.styles.join(' / ')}, today ${p.today ?? '?'})`).join(', '),
    txs: txs.length, txStyles: [...new Set(txs.map((p) => p.styles.join(' / ')))].join(', '), txToday: [...new Set(txs.map((p) => p.today ?? '?'))].join(', '),
    txList: txs.map((p) => `${p.trigger} (${p.transaction!.sites.length})`).join(', '),
    homes: model.homes?.length ?? 0, homeOptions: (model.homes ?? []).reduce((a, h) => a + h.options.length, 0),
  })).filter(Boolean);
  const title = t('model.how.title', 'How the input model is built, and how a design is built from it');
  const intro = t('model.how.intro');
  return (
    <ScrollArea className="h-full">
      <div ref={box} className="mx-auto max-w-[1100px] space-y-5 p-4 text-xs">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold">{title}</h2>
          {intro && <p className="text-muted-foreground"><MText text={intro} /></p>}
        </div>
        <ol className="space-y-1">
          {steps.map((s, i) => (
            <li key={s.title}>
              <div className="rounded-lg border bg-card px-3 py-2">
                <div className="flex flex-wrap items-baseline gap-2"><span className="text-[12.5px] font-semibold">{s.title}</span>{s.ref && <span className="text-[10.5px] text-muted-foreground">{s.ref}</span>}
                  {s.links && <span className="ml-auto flex gap-2">{s.links.map(([l, t]) => <ModelLink key={t} target={t} className="text-[11px]">{l}</ModelLink>)}</span>}</div>
                {s.text && <p className="mt-0.5"><MText text={s.text} /></p>}
                <div className="mt-1 flex flex-wrap gap-1">{model.origin.filter((o) => o.step === s.origin).map((o) => <RepoPath key={o.path} path={o.path} />)}</div>
              </div>
              {i < steps.length - 1 && <ArrowDown className="mx-auto my-0.5 size-3.5 text-muted-foreground" />}
            </li>
          ))}
        </ol>
        <Section title="What a design decides" right={`${model.classes.length * 2} placements · ${counts.sites} call sites with ${counts.options} options · ${sagas.length} sagas${txs.length ? ` · ${txs.length} transaction workflows` : ''}`}>
          {decides.length > 0 && <ul className="list-disc space-y-0.5 pl-4">
            {decides.map((x) => <li key={x}><MText text={x} /></li>)}
          </ul>}
        </Section>
        <Section title="How the decisions become PCM" right={doc?.realise?.ref}>
          <p className="text-muted-foreground">Every interaction kind with its mechanisms as sequence diagrams: <ModelLink target="mech">Interactions</ModelLink>.</p>
          <table className="w-full">
            <thead className="text-left text-[10.5px] text-muted-foreground"><tr><th className="font-medium">decision</th><th className="font-medium">realised as</th><th className="font-medium">parameters</th></tr></thead>
            <tbody>{realiseRows(model, doc?.realise?.rows ?? []).map(([d, r, p]) => <tr key={d} className="border-t border-border/50 align-top"><td className="py-1 pr-2 font-medium">{d}</td><td className="pr-2"><MText text={r} /></td><td className="text-muted-foreground"><MText text={p} /></td></tr>)}</tbody>
          </table>
        </Section>
        <CacheSites model={model} t={t} />
        <Section title="Parameters of the decision layer" right={`values in today's seed model · demands: ${timingLabel(model)}`}>
          <div className="grid gap-3 @3xl:grid-cols-2">
            {groups.map((g) => (
              <div key={g.title} className="space-y-1">
                <div className="text-[11.5px] font-medium">{g.title} <span className="font-normal text-muted-foreground">{g.note}</span></div>
                {g.classes.filter((c) => model.parameters.some((p) => p.class === c)).map((c) => (
                  <div key={c} data-param={c} className={cn('rounded-md transition-shadow', param === c && 'ring-2 ring-ring')}>
                    <ParamTable classes={[c]} params={model.parameters} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Section>
        <Section title="Where the model comes from">
          <table className="w-full">
            <tbody>{model.origin.map((o) => <tr key={o.path} className="border-t border-border/50 align-top"><td className="w-[6.5rem] py-1 pr-2 text-muted-foreground">{o.step}</td><td className="w-[1%] whitespace-nowrap py-1 pr-2"><RepoPath path={o.path} /></td><td className="py-1">{o.what}{o.design && <span className="text-muted-foreground">{t('model.how.originRef', ' ({{design}})', { design: o.design })}</span>}</td></tr>)}</tbody>
          </table>
          <p className="text-muted-foreground"><MText code="font-mono" text={t('model.how.exported', 'This input model was exported {{date}} from:', { commit: model.commit?.slice(0, 12), date: new Date(model.generatedAt).toLocaleString('en-GB') })} /></p>
          <ul className="list-disc pl-4 text-muted-foreground">{model.inputs.map((x) => <li key={`${x.label}|${x.path}`}>{x.label}: <code className="font-mono text-[10.5px]">{x.path}</code>{x.note ? ` (${x.note})` : ''}</li>)}</ul>
        </Section>
        {!!model.notes?.length && (
          <Section title="Notes of the export">
            <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">{model.notes.map((n) => <li key={n}><RichText text={n} /></li>)}</ul>
          </Section>
        )}
        <p className="tabular text-muted-foreground">Design load {fmtN(model.designSessionsPerS, 1)} sessions/s, {fmtN(model.requests.reduce((s, r) => s + r.rate, 0), 0)} requests/s.</p>
      </div>
    </ScrollArea>
  );
}
