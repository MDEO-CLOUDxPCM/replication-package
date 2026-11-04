import { useMemo } from 'react';
import { ArrowUpRight } from 'lucide-react';
import type { ModelParameter } from '@contract/types';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useInputModel, useRun } from '@/lib/api';
import { refLink, refShort, type MetricDoc } from '@/lib/metricDocs';
import { usePanelAvailable, useSelectionState, workspaceActions } from '@/lib/useWorkspace';
import { RichText } from './RichText';
import { Tex } from './Tex';

const fmtVal = (v: unknown) => (typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(+v.toPrecision(6))) : String(v));

/** instances of a parameter class, the ones with equal properties merged (many equal change units: one line) */
export function groupParams(ps: ModelParameter[]): { names: string[]; props: [string, unknown][]; links: [string, number][] }[] {
  const groups = new Map<string, { names: string[]; props: [string, unknown][]; links: [string, number][] }>();
  for (const p of ps) {
    const props = Object.entries(p.properties).filter(([, v]) => v !== null && v !== undefined);
    const key = JSON.stringify(props);
    const g = groups.get(key) ?? { names: [], props, links: [] };
    g.names.push(p.name);
    for (const [k, v] of Object.entries(p.links ?? {})) {
      const i = g.links.findIndex(([x]) => x === k);
      if (i >= 0) g.links[i] = [k, g.links[i][1] + v.length]; else g.links.push([k, v.length]);
    }
    groups.set(key, g);
  }
  return [...groups.values()];
}

export function ParamTable({ classes, params }: { classes: string[]; params: ModelParameter[] }) {
  return (
    <div className="space-y-1.5">
      {classes.map((c) => {
        const ps = params.filter((p) => p.class === c);
        if (!ps.length) return null;
        return groupParams(ps).map((g, i) => (
          <div key={`${c}-${i}`} className="rounded-md border bg-muted/30 px-2 py-1.5">
            <div className="text-[11px] font-medium">{c} <span className="font-normal text-muted-foreground">{g.names.length > 1 ? `${g.names.length} objects` : g.names[0]}</span></div>
            <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10.5px] text-muted-foreground">
              {g.props.map(([k, v]) => <span key={k}>{k} <b className="font-medium text-foreground">{fmtVal(v)}</b></span>)}
              {g.links.map(([k, n]) => <span key={k}>{k} <b className="font-medium text-foreground">{n / g.names.length}{g.names.length > 1 ? ' each' : ''}</b></span>)}
            </div>
          </div>
        ));
      })}
    </div>
  );
}

const REL_CLS: Record<string, string> = {
  source: 'bg-primary/10 text-primary',
  'based on': 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
  'adapted from': 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
  related: 'bg-muted text-muted-foreground',
};

/** literature: short form linking to the DOI (or URL), the full title on the second line; or the project's own construction */
function References({ doc }: { doc: MetricDoc }) {
  return (
    <section>
      <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">References</h4>
      {doc.origin && <p className="mb-1 text-[11px] text-muted-foreground">Formula: {doc.origin}{doc.refs?.length ? '; literature:' : '.'}</p>}
      {doc.refs && (
        <ul className="space-y-1.5">
          {doc.refs.map((r) => (
            <li key={`${r.relation}-${refShort(r)}-${r.title}`} className="text-[11px] leading-snug">
              <div className="flex flex-wrap items-baseline gap-x-1.5">
                <span className={`rounded px-1 py-px text-[10px] font-medium ${REL_CLS[r.relation]}`}>{r.relation}</span>
                <a href={refLink(r)} target="_blank" rel="noreferrer noopener" title={refLink(r)}
                  className="inline-flex cursor-pointer items-center gap-0.5 font-medium text-foreground underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-foreground">
                  {refShort(r)}<ArrowUpRight className="size-3" />
                </a>
                <span className="text-muted-foreground"><i>{r.title}</i>. {r.venue}.</span>
              </div>
              {r.note && <div className="mt-0.5 pl-1 text-muted-foreground/90"><RichText text={r.note} /></div>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** the popover's body: definition, formula, inputs, assumptions, the model's parameter values, sources, links */
export default function MetricHelpContent({ doc, onNavigate }: { doc: MetricDoc; onNavigate: () => void }) {
  const ws = useSelectionState();
  const { data: run } = useRun(ws.run ?? undefined);
  const { data: model } = useInputModel(doc.params?.length ? run?.domainId : undefined);
  const params = useMemo(() => model?.parameters ?? [], [model]);
  const go = (t: string) => { onNavigate(); workspaceActions.openModel(t); };
  const modelPanel = usePanelAvailable('model');
  return (
    <ScrollArea className="max-h-[min(72vh,640px)]" viewportClassName="max-h-[min(72vh,640px)]">
      <div className="space-y-3 p-4 text-xs leading-relaxed">
        <div>
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-semibold">{doc.title}</span>
            {doc.code && <span className="rounded bg-muted px-1.5 py-px text-[10.5px] font-semibold text-muted-foreground">{doc.code}</span>}
            <span className="text-muted-foreground">{doc.direction}{doc.unit ? ` · ${doc.unit}` : ''}</span>
          </div>
          <p className="mt-1 text-[12.5px]"><RichText text={doc.summary} /></p>
        </div>
        {doc.formula && (
          <div className="space-y-1 overflow-x-auto rounded-md border bg-muted/25 px-2 py-1.5 [scrollbar-width:none]">
            {doc.formula.map((f, i) => <Tex key={i} tex={f} display className="block text-[12px]" />)}
          </div>
        )}
        {doc.where && (
          <dl className="grid grid-cols-[minmax(4.5rem,auto)_1fr] gap-x-3 gap-y-1">
            {doc.where.map(([s, m]) => (
              <div key={s} className="contents">
                <dt className="text-right"><Tex tex={s} /></dt>
                <dd className="text-muted-foreground"><RichText text={m} /></dd>
              </div>
            ))}
          </dl>
        )}
        <section>
          <h4 className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Computed from</h4>
          <ul className="list-disc space-y-0.5 pl-4">{doc.inputs.map((x) => <li key={x}><RichText text={x} /></li>)}</ul>
        </section>
        {doc.assumptions && (
          <section>
            <h4 className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Assumptions</h4>
            <ul className="list-disc space-y-0.5 pl-4">{doc.assumptions.map((x) => <li key={x}><RichText text={x} /></li>)}</ul>
          </section>
        )}
        {doc.params && params.length > 0 && (
          <section>
            <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Values in the model</h4>
            <ParamTable classes={doc.params} params={params} />
          </section>
        )}
        {(doc.refs?.length || doc.origin) && <References doc={doc} />}
        <div className="flex flex-wrap items-center gap-1.5 border-t pt-2 text-[11px] text-muted-foreground">
          {doc.cite.map((c) => <code key={c} className="rounded bg-muted px-1 py-px font-mono text-[10.5px]">{c}</code>)}
        </div>
        {doc.links && modelPanel && (
          <div className="flex flex-wrap gap-1.5">
            {doc.links.map((l) => (
              <button key={l.target} type="button" onClick={() => go(l.target)}
                className="inline-flex cursor-pointer items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] hover:bg-accent">
                {l.label}<ArrowUpRight className="size-3" />
              </button>
            ))}
          </div>
        )}
      </div>
    </ScrollArea>
  );
}
