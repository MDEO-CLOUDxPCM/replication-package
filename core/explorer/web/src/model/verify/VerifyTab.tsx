/**
 * The Model panel's Verify tab: a generic viewer of the packet's Verify files (contract/verify.ts; the packet's
 * builder splits the model into parts): each part's claims checked against the packet's source trees at their
 * commit, with its evidence and documents beside it (SourcePane), and marked verified or an issue (marks.ts, kept in
 * this browser per packet). The kinds of parts, their groups and the operations' scopes come from the parts file,
 * the case's texts from the packet (`verify.*`). URL: `model=verify:<part>`. Keys (outside inputs): j / k next /
 * previous part, v verified, V verified and on to the next open part, i issue, n next open part.
 */
import { Fragment, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Circle, CircleAlert, CircleCheck, Download, ExternalLink, FileUp, ListChecks, PanelLeft, RefreshCw, Search } from 'lucide-react';
import type { InputModel } from '@contract/types';
import type { Causes, Loc, Part, Tok } from '@contract/verify';
import { useTexts } from '@/lib/packet';
import { Rich } from '@/help/Rich';
import { Checkbox } from '@/components/ui/checkbox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Loading, Problem } from '@/components/States';
import { patchUrl, useUrlParams, workspaceActions } from '@/lib/useWorkspace';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { SeffTree } from '../SeffTree';
import { Section } from '../shared';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { isExternal, useVerifyData, useVerifyInfo, VerifyInfoContext, type Trees } from './data';
import { exportMarks, issuesMarkdown, statusOf, useMarks, type Mark, type MarkStatus } from './marks';
import { evidenceFiles, SourcePane, type SourceSel } from './SourcePane';
import { CausesView, causeProgress, EvButtons } from './Causes';
import { OpTree, treeOrder, type OpState } from './OpTree';

// ---------------------------------------------------------------- filters (kept per browser)
/** `others`: every part in a list (classes to parameters); else the operations as the entry-point tree; scope: `all`,
 *  `model` (the scopes in the model), a scope of the parts file, `left` (the others) */
interface Filters { q: string; kind: string; status: MarkStatus | 'todo' | 'all'; scope: string; by: 'service' | 'kind'; others: boolean }
const FILTERS_KEY = 'explorer-verify-filters';
const DEFAULT_FILTERS: Filters = { q: '', kind: 'all', status: 'all', scope: 'all', by: 'service', others: false };
function readFilters(): Filters {
  try { return { ...DEFAULT_FILTERS, ...JSON.parse(localStorage.getItem(FILTERS_KEY) ?? '{}'), q: '' }; } catch { return DEFAULT_FILTERS; }
}

const STATUS_ICON: Record<MarkStatus, { icon: typeof Circle; cls: string; label: string }> = {
  open: { icon: Circle, cls: 'text-muted-foreground/50', label: 'open' },
  ok: { icon: CircleCheck, cls: 'text-emerald-600 dark:text-emerald-400', label: 'verified' },
  changed: { icon: RefreshCw, cls: 'text-sky-600 dark:text-sky-400', label: 'verified, but its claims changed since' },
  issue: { icon: CircleAlert, cls: 'text-amber-600 dark:text-amber-400', label: 'issue' },
};
/** a text of the packet with its markup (help/Rich.tsx), `*text*` in italics */
function RichI({ text }: { text: string }) {
  return <>{text.split(/(?<!\*)\*([^*]+)\*(?!\*)/).map((t, i) => (i % 2 ? <i key={i}>{t}</i> : <Fragment key={i}><Rich text={t} strong="" /></Fragment>))}</>;
}

function StatusIcon({ s, className }: { s: MarkStatus; className?: string }) {
  const { icon: I, cls, label } = STATUS_ICON[s];
  return <I aria-label={label} className={cn('size-3.5 shrink-0', cls, className)}><title>{label}</title></I>;
}

function KindTag({ kind }: { kind: string }) {
  const k = useVerifyInfo().kind(kind);
  return <span title={k.label} className="grid size-4 shrink-0 place-items-center rounded bg-muted text-[9px] font-semibold text-muted-foreground">{k.short}</span>;
}

const select = (key: string) => patchUrl({ model: `verify:${key}`, mtab: null, vreq: null });
const VREQ = ['vreq'] as const;

// ---------------------------------------------------------------- claims
function Toks({ toks }: { toks: Tok[] }) {
  return (
    <>
      {toks.map((t, i) => typeof t === 'string' ? <span key={i}>{t}</span>
        : 'part' in t ? <button key={i} type="button" onClick={(e) => { e.stopPropagation(); select(t.part); }} title={`go to ${t.part}`}
          className="cursor-pointer rounded-sm underline decoration-border decoration-1 underline-offset-2 hover:decoration-foreground/60">{t.label}</button>
          : 'code' in t ? <code key={i} className="rounded bg-muted px-1 font-mono text-[10.5px]">{t.code}</code>
            : <span key={i} className={cn('mx-0.5 inline-block rounded border px-1 text-[10px] leading-tight', t.tone === 'warn' ? 'border-amber-500/40 text-amber-700 dark:text-amber-300' : t.tone === 'ok' ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground')}>{t.chip}</span>)}
    </>
  );
}

function NoteBox({ part, mark }: { part: Part; mark: Mark | undefined }) {
  const setNote = useMarks((s) => s.setNote);
  const [text, setText] = useState(mark?.note ?? '');
  useEffect(() => { setText(mark?.note ?? ''); }, [part.key, mark?.note]);
  const save = () => { if ((mark?.note ?? '') !== text.trim()) setNote(part, text.trim()); };
  return (
    <textarea value={text} onChange={(e) => setText(e.target.value)} onBlur={save} rows={text ? 2 : 1} placeholder="Note (what is wrong, what to check again) — saved with the mark"
      onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); (e.target as HTMLTextAreaElement).blur(); } }}
      className="w-full resize-y rounded-md border bg-transparent px-2 py-1 text-xs outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring/50" />
  );
}

export function PartView({ part, mark, sel, onSelect, trees, nav, model, causes, hasPart, request }: {
  part: Part; mark: Mark | undefined; sel: SourceSel | null; onSelect: (s: SourceSel) => void; trees: Trees | undefined; model?: InputModel;
  nav: { prev?: string; next?: string; nextOpen?: string }; causes?: Causes; hasPart?: (k: string) => boolean;
  /** the request whose context the operation is shown in (URL `vreq`) */
  request?: string;
}) {
  const { toggleOk, toggleIssue } = useMarks();
  const status = statusOf(part, mark);
  const info = useVerifyInfo();
  const tx = useTexts();
  const k = info.kind(part.kind);
  // the facts shown above what it causes; the rest under "More"
  const lead = new Set(info.leadFacts[part.kind] ?? []);
  return (
    <div className="space-y-4 p-3 text-xs">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <KindTag kind={part.kind} />
          <h2 className="min-w-0 truncate text-sm font-semibold" title={part.key}>{part.title}</h2>
          <span className="text-[11px] text-muted-foreground">{k.label} · {part.group}</span>
          <div className="ml-auto flex items-center gap-0.5">
            <button type="button" disabled={!nav.prev} onClick={() => nav.prev && select(nav.prev)} title="previous part (k)" aria-label="Previous part"
              className="cursor-pointer rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-30"><ChevronLeft className="size-4" /></button>
            <button type="button" disabled={!nav.next} onClick={() => nav.next && select(nav.next)} title="next part (j)" aria-label="Next part"
              className="cursor-pointer rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-30"><ChevronRight className="size-4" /></button>
          </div>
        </div>
        {part.subtitle && <p className="font-mono text-[10.5px] text-muted-foreground">{part.subtitle}</p>}
        <div className={cn('flex flex-wrap items-center gap-3 rounded-md border px-2.5 py-1.5', status === 'ok' && 'border-emerald-500/40 bg-emerald-500/5', status === 'issue' && 'border-amber-500/50 bg-amber-500/5', status === 'changed' && 'border-sky-500/40 bg-sky-500/5')}>
          <label className="flex cursor-pointer items-center gap-2 text-[12.5px] font-medium">
            <Checkbox checked={status === 'ok'} onCheckedChange={() => toggleOk(part)} aria-label="Verified" className="size-[18px]" />
            Verified
          </label>
          <button type="button" onClick={() => toggleIssue(part)} aria-pressed={status === 'issue'} title="mark an issue (i)"
            className={cn('flex cursor-pointer items-center gap-1 rounded-md border px-2 py-0.5 text-[11.5px] transition-colors', status === 'issue' ? 'border-amber-500/60 bg-amber-500/15 text-amber-800 dark:text-amber-200' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}>
            <CircleAlert className="size-3.5" /> Issue
          </button>
          <span className="text-[11px] text-muted-foreground">
            {status === 'changed' ? 'verified earlier, but its claims changed since: check again' : mark?.at ? `${STATUS_ICON[status].label} ${new Date(mark.at).toLocaleString()}` : 'not checked yet'}
          </span>
          {nav.nextOpen && (
            <button type="button" onClick={() => { if (status !== 'ok') toggleOk(part); select(nav.nextOpen!); }} title="mark verified and go to the next open part (V)"
              className="ml-auto cursor-pointer rounded-md border px-2 py-0.5 text-[11.5px] text-muted-foreground hover:bg-accent hover:text-foreground">Verified, next open →</button>
          )}
        </div>
        <NoteBox part={part} mark={mark} />
      </div>

      {causes ? (
        <>
          <Facts facts={part.facts.filter((f) => lead.has(f.label))} sel={sel} onSelect={onSelect} trees={trees} />
          <CausesView causes={causes} partKey={part.key} request={request} requests={model?.requests} consistency={model?.consistency} sel={sel} onSelect={onSelect} trees={trees} hasPart={hasPart ?? (() => true)} />
          <Collapsible>
            <CollapsibleTrigger className="group flex cursor-pointer items-center gap-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground hover:text-foreground">
              <ChevronRight className="size-3.5 transition-transform group-data-[state=open]:rotate-90" /> {tx('verify.more') || 'More: the tables, the model\'s, the SEFF'}
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-4 pt-3">
              <Facts facts={part.facts.filter((f) => !lead.has(f.label))} sel={sel} onSelect={onSelect} trees={trees} />
              <Details part={part} sel={sel} onSelect={onSelect} trees={trees} model={model} request={request} />
            </CollapsibleContent>
          </Collapsible>
        </>
      ) : (
        <>
          <Facts facts={part.facts} sel={sel} onSelect={onSelect} trees={trees} />
          <Details part={part} sel={sel} onSelect={onSelect} trees={trees} model={model} />
        </>
      )}
    </div>
  );
}

function Facts({ facts, sel, onSelect, trees }: { facts: Part['facts']; sel: SourceSel | null; onSelect: (s: SourceSel) => void; trees: Trees | undefined }) {
  if (!facts.length) return null;
  return (
      <dl className="grid grid-cols-[8.5rem_1fr] gap-x-3 gap-y-1">
        {facts.map((f, i) => (
          <div key={i} className="contents">
            <dt className="text-muted-foreground">{f.label}</dt>
            <dd className="min-w-0 break-words">
              <Toks toks={f.value} />
              {f.ev && f.ev.length > 0 && <span className="ml-1.5"><EvButtons ev={f.ev} sel={sel} onSelect={onSelect} trees={trees} /></span>}
            </dd>
          </div>
        ))}
      </dl>
  );
}

/** a part's link to the other Model tabs, its code block, its tables and SEFFs */
function Details({ part, sel, onSelect, trees, model, request }: { part: Part; sel: SourceSel | null; onSelect: (s: SourceSel) => void; trees: Trees | undefined; model?: InputModel; request?: string }) {
  // in a request's context: the SEFF that request runs (its own, else the general one; one per home option)
  const seffs = request && part.seffs?.some((x) => x.request) ? part.seffs.filter((x) => (part.seffs!.some((y) => y.request === request) ? x.request === request : !x.request)) : part.seffs;
  const isOn = (ev: Loc[]) => !!sel && ev.some((l) => l.path === sel.path && l.line === sel.line);
  return (
    <>
      {part.modelTarget && (
        <button type="button" onClick={() => workspaceActions.openModel(part.modelTarget!)} className="flex cursor-pointer items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
          <ExternalLink className="size-3" /> In the {part.modelTarget.startsWith('class:') ? 'Domain' : part.modelTarget.startsWith('req:') ? 'Workload' : 'Operations'} tab
        </button>
      )}

      {part.code && (
        <Section title={part.code.label}>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/40 p-2 font-mono text-[10.5px] leading-snug">{part.code.text}</pre>
        </Section>
      )}

      {part.tables.map((t) => (
        <Section key={t.title} title={t.title} right={`${t.rows.length}`}>
          {t.hint && <p className="text-[11px] text-muted-foreground">{t.hint}</p>}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[11px]">
              <thead>
                <tr className="border-b text-left text-[10.5px] text-muted-foreground">
                  {t.columns.map((c) => <th key={c} className="py-0.5 pr-2 font-medium">{c}</th>)}
                  {t.rows.some((r) => r.ev.length) && <th className="py-0.5 font-medium">evidence</th>}
                </tr>
              </thead>
              <tbody>
                {t.rows.map((r, i) => {
                  const on = isOn(r.ev);
                  const pick = r.ev[0] && !isExternal(r.ev[0], trees) ? () => onSelect({ repo: r.ev[0].repo, path: r.ev[0].path, line: r.ev[0].line }) : undefined;
                  return (
                    <RowGroup key={i} on={on} onClick={pick} note={r.note} span={t.columns.length + 1}>
                      {r.cells.map((c, j) => <td key={j} className="py-0.5 pr-2 align-top"><Toks toks={c} /></td>)}
                      {t.rows.some((x) => x.ev.length) && <td className="py-0.5 align-top"><EvButtons ev={r.ev} sel={sel} onSelect={onSelect} trees={trees} /></td>}
                    </RowGroup>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>
      ))}

      {model && seffs?.map((x) => (
        <Section key={x.id} title="SEFF (generated)" right={<code className="font-mono text-[10px]">{x.id}</code>}>
          <div className="rounded-md border p-2"><SeffTree model={model} seff={x.id} ctx={null} label={`${x.label}:`} /></div>
        </Section>
      ))}
    </>
  );
}

function RowGroup({ on, onClick, note, span, children }: { on: boolean; onClick?: () => void; note?: string; span: number; children: ReactNode }) {
  const cls = cn(onClick && 'cursor-pointer hover:bg-accent/50', on && 'bg-amber-500/10');
  return (
    <>
      <tr onClick={onClick} className={cn(cls, !note && 'border-b border-border/50')}>{children}</tr>
      {note && <tr onClick={onClick} className={cn(cls, 'border-b border-border/50')}><td colSpan={span} className="pb-1 pl-2 text-[10.5px] text-muted-foreground">{note}</td></tr>}
    </>
  );
}

// ---------------------------------------------------------------- the list
function Progress({ counts, total }: { counts: Record<MarkStatus, number>; total: number }) {
  const w = (n: number) => `${(100 * n) / Math.max(1, total)}%`;
  return (
    <div className="space-y-1">
      <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
        <div className="bg-emerald-500" style={{ width: w(counts.ok) }} />
        <div className="bg-sky-500" style={{ width: w(counts.changed) }} />
        <div className="bg-amber-500" style={{ width: w(counts.issue) }} />
      </div>
      <p className="text-[10.5px] text-muted-foreground"><b className="font-medium text-foreground">{counts.ok}</b> of {total} verified{counts.issue ? ` · ${counts.issue} issues` : ''}{counts.changed ? ` · ${counts.changed} changed` : ''}</p>
    </div>
  );
}

function OpProgress({ ops, status, rows }: { ops: Part[]; status: (p: Part) => MarkStatus; rows: { ok: number; all: number } }) {
  const ok = ops.filter((p) => status(p) === 'ok').length, issue = ops.filter((p) => status(p) === 'issue').length;
  return (
    <div className="space-y-1">
      <div className="flex h-1.5 overflow-hidden rounded-full bg-muted"><div className="bg-emerald-500" style={{ width: `${(100 * rows.ok) / Math.max(1, rows.all)}%` }} /></div>
      <p className="text-[10.5px] text-muted-foreground"><b className="font-medium text-foreground">{rows.ok}</b> of {rows.all} interactions checked · {ok} of {ops.length} operations verified{issue ? ` · ${issue} issues` : ''}</p>
    </div>
  );
}

function Sel<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: [T, string][]; label: string }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as T)} aria-label={label} title={label}
      className="h-6 min-w-0 flex-1 cursor-pointer rounded border bg-background px-1 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
      {options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}

export const VerifyTab = memo(function VerifyTab({ model, partKey, narrow }: { model: InputModel; partKey?: string; narrow: boolean }) {
  const vd = useVerifyData();
  const { info, trees } = vd;
  const tx = useTexts();
  const parts = useMemo(() => vd.parts.data?.parts ?? [], [vd.parts.data]);
  const byKey = useMemo(() => new Map(parts.map((p) => [p.key, p])), [parts]);
  const hasPart = useCallback((k: string) => byKey.has(k), [byKey]);
  // what each operation of the model causes, by its part's key
  const causes = useMemo(() => new Map<string, Causes>(Object.entries(vd.causes.data ?? {})), [vd.causes.data]);
  // the marks of this packet
  useLayoutEffect(() => { useMarks.getState().open(vd.id); }, [vd.id]);
  const marks = useMarks((s) => s.marks);
  const merge = useMarks((s) => s.merge);
  const [f, setF] = useState<Filters>(readFilters);
  const patch = (p: Partial<Filters>) => setF((x) => { const n = { ...x, ...p }; try { localStorage.setItem(FILTERS_KEY, JSON.stringify(n)); } catch { /* blocked */ } return n; });
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [showList, setShowList] = useState(!narrow);

  const status = useCallback((p: Part) => statusOf(p, marks[p.key]), [marks]);
  const counts = useMemo(() => {
    const c: Record<MarkStatus, number> = { open: 0, ok: 0, changed: 0, issue: 0 };
    for (const p of parts) c[status(p)]++;
    return c;
  }, [parts, status]);
  const visible = useMemo(() => {
    const q = f.q.trim().toLowerCase();
    return parts.filter((p) => {
      if (f.kind !== 'all' && p.kind !== f.kind) return false;
      const s = status(p);
      if (f.status === 'todo' ? s === 'ok' : f.status !== 'all' && s !== f.status) return false;
      if (f.scope !== 'all' && p.scope !== undefined) {
        const inModel = !!info.scopes[p.scope]?.inModel;
        if (f.scope === 'model' ? !inModel : f.scope === 'left' ? inModel : p.scope !== f.scope) return false;
      }
      return !q || p.text.includes(q);
    });
  }, [parts, f, status, info]);
  const groups = useMemo(() => {
    const g = new Map<string, Part[]>();
    const keyOf = (p: Part) => (f.by === 'kind' ? info.kind(p.kind).plural : p.group);
    const kindIdx = (k: string) => info.kinds.findIndex((x) => x.id === k);
    const list = f.by === 'kind' ? [...visible].sort((a, b) => kindIdx(a.kind) - kindIdx(b.kind)) : visible;
    for (const p of list) g.set(keyOf(p), [...(g.get(keyOf(p)) ?? []), p]);
    if (f.by === 'service') for (const late of info.lateGroups) if (g.has(late)) { const x = g.get(late)!; g.delete(late); g.set(late, x); }
    return [...g.entries()];
  }, [visible, f.by, info]);
  const opOrder = useMemo(() => treeOrder(model).map((op) => byKey.get(`op:${op}`)).filter((p): p is Part => !!p), [model, byKey]);
  const order = useMemo(() => (f.others ? groups.flatMap(([, ps]) => ps) : opOrder), [f.others, groups, opOrder]);
  const progress = useCallback((op: string) => { const k = `op:${op}`; return causes.has(k) ? causeProgress(k, causes.get(k), marks) : undefined; }, [causes, marks]);
  /** the tree's state of an operation: its mark together with the rows of what it causes */
  const opState = useCallback((op: string): OpState | undefined => {
    const p = byKey.get(`op:${op}`);
    if (!p) return undefined;
    const s = status(p), pr = progress(op);
    if (s === 'issue' || pr?.issue) return 'issue';
    if (s === 'changed') return 'changed';
    if (s === 'ok') return !pr || pr.ok === pr.all ? 'finished' : 'verified';
    return pr?.ok ? 'progress' : 'open';
  }, [byKey, status, progress]);
  const rowCounts = useMemo(() => {
    const t = { ok: 0, all: 0 };
    for (const p of opOrder) { const x = progress(p.key.slice(3)); if (x) { t.ok += x.ok; t.all += x.all; } }
    return t;
  }, [opOrder, progress]);
  const groupTotals = useMemo(() => {
    const t = new Map<string, { all: number; ok: number }>();
    for (const p of parts) {
      const k = f.by === 'kind' ? info.kind(p.kind).plural : p.group;
      const x = t.get(k) ?? { all: 0, ok: 0 };
      x.all++; if (status(p) === 'ok') x.ok++;
      t.set(k, x);
    }
    return t;
  }, [parts, f.by, status, info]);

  const current = partKey ? byKey.get(partKey) : undefined;
  const vreq = useUrlParams(VREQ).get('vreq') ?? undefined;
  const idx = current ? order.findIndex((p) => p.key === current.key) : -1;
  const nextOpen = useMemo(() => {
    const after = [...order.slice(idx + 1), ...order.slice(0, Math.max(0, idx))];
    return after.find((p) => p.key !== current?.key && status(p) !== 'ok')?.key;
  }, [order, idx, current, status]);
  const nav = { prev: idx > 0 ? order[idx - 1].key : undefined, next: idx >= 0 ? order[idx + 1]?.key : order[0]?.key, nextOpen };

  // the source pane: the first evidence (an operation's entry, a class's table) unless a claim's evidence is picked
  const [sel, setSel] = useState<SourceSel | null>(null);
  useEffect(() => {
    if (!current) { setSel(null); return; }
    const first = evidenceFiles(current, trees)[0];
    const doc = current.docs[0];
    setSel(first ? { repo: first.repo, path: first.path, line: first.first } : doc ? { repo: doc.loc.repo, path: doc.loc.path, find: doc.find } : null);
  }, [current, trees]);

  // keys
  const keys = useRef({ current, nav, toggleOk: useMarks.getState().toggleOk, toggleIssue: useMarks.getState().toggleIssue });
  keys.current = { ...keys.current, current, nav };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable))) return;
      const { current: c, nav: n } = keys.current;
      const go = (k?: string) => { if (k) { e.preventDefault(); select(k); } };
      if (e.key === 'j') go(n.next);
      else if (e.key === 'k') go(n.prev);
      else if (e.key === 'n') go(n.nextOpen);
      else if (c && e.key === 'v') { e.preventDefault(); keys.current.toggleOk(c); }
      else if (c && e.key === 'V') { e.preventDefault(); if (statusOf(c, useMarks.getState().marks[c.key]) !== 'ok') keys.current.toggleOk(c); go(n.nextOpen); }
      else if (c && e.key === 'i') { e.preventDefault(); keys.current.toggleIssue(c); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // the selected part stays in view in the list
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!partKey) return;
    listRef.current?.querySelector(`[data-part="${CSS.escape(partKey)}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [partKey, showList]);

  const fileInput = useRef<HTMLInputElement>(null);
  const onImport = async (file: File) => {
    try {
      const j = JSON.parse(await file.text());
      const m = j && typeof j === 'object' ? (j.marks ?? j) : undefined;
      if (!m || typeof m !== 'object' || Array.isArray(m)) throw new Error('no marks in it');
      const all = Object.keys(m).length;
      const n = merge(m);
      toast.success(`Progress uploaded: ${n} of ${all} marks taken over${all - n ? `, ${all - n} kept (yours as new or newer)` : ''}`);
    } catch (e) { toast.error(`${file.name} is no progress file: ${(e as Error).message}`); }
  };
  const [drop, setDrop] = useState(false);
  const copyIssues = () => {
    const md = issuesMarkdown(parts, marks, { tx, tree: info.label(info.tree) || undefined, commit: info.commit });
    void navigator.clipboard?.writeText(md).then(() => toast.success('Issues and notes copied as Markdown'), () => toast.error('Clipboard not available'));
  };

  if (!vd.id || vd.parts.isLoading) return <Loading label="Loading the Verify parts" />;
  if (vd.parts.error || !vd.parts.data) return <Problem title="No Verify parts">{String(vd.parts.error ?? 'the packet has no Verify parts')}</Problem>;
  const scopeOpts: [string, string][] = Object.keys(info.scopes).length
    ? [['all', 'all operations'], ['model', 'ops in the model'], ...Object.entries(info.scopes).filter(([, s]) => s.inModel).map(([id, s]) => [id, `ops ${s.label}`] as [string, string]), ['left', 'ops left out']] : [];
  const source = info.label(info.tree);
  const introOps = tx('verify.intro.ops'), checks = tx('verify.intro.checks'), scopesText = tx('verify.intro.scopes');
  const kindCounts = info.kinds.map((k) => `${parts.filter((p) => p.kind === k.id).length} ${k.plural.toLowerCase()}`).join(', ');
  const introParts = tx('verify.intro.parts', { n: parts.length, counts: kindCounts, source, commit: info.commit?.slice(0, 12) }) || `${parts.length} parts: ${kindCounts}.`;

  const list = (
    <aside className={cn('flex h-full w-[320px] min-w-[200px] shrink-0 flex-col border-r', drop && 'bg-accent/40 outline-2 -outline-offset-2 outline-dashed outline-ring')}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDrop(true); } }} onDragLeave={() => setDrop(false)}
      onDrop={(e) => { e.preventDefault(); setDrop(false); const x = e.dataTransfer.files[0]; if (x) void onImport(x); }}>
      <div className="space-y-1.5 border-b p-2">
        <div className="flex items-center gap-1.5">
          <div className="min-w-0 flex-1">{f.others ? <Progress counts={counts} total={parts.length} /> : <OpProgress ops={opOrder} status={status} rows={rowCounts} />}</div>
          <button type="button" onClick={() => exportMarks(marks, info.commit, vd.id)} aria-label="Download progress" title={`download the verification progress (${Object.keys(marks).length} marks, JSON)`}
            className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"><Download className="size-4" /></button>
          <button type="button" onClick={() => fileInput.current?.click()} aria-label="Upload progress" title="upload a progress file (or drop it on the list): merged with yours, the later mark of a row wins"
            className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"><FileUp className="size-4" /></button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" aria-label="More: copy issues" title="copy issues and notes" className="cursor-pointer rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"><ListChecks className="size-4" /></button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="text-xs">
              <DropdownMenuItem onSelect={copyIssues}><CircleAlert className="size-3.5" /> Copy issues and notes (Markdown)</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <input ref={fileInput} type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const x = e.target.files?.[0]; if (x) void onImport(x); e.target.value = ''; }} />
        </div>
        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted-foreground" title={tx('verify.others.title') || 'every part of the model in one list'}>
          <Checkbox checked={f.others} onCheckedChange={(v) => patch({ others: v === true })} aria-label="Other parts" className="size-3.5" />
          {tx('verify.others.label') || 'other parts'}
        </label>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <input value={f.q} onChange={(e) => patch({ q: e.target.value })} placeholder={f.others ? 'Filter parts' : 'Filter operations'} aria-label="Filter parts"
            className="h-7 w-full rounded-md border bg-transparent pl-7 pr-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/50" />
        </div>
        {f.others && <><div className="flex gap-1">
          <Sel label="kind" value={f.kind} onChange={(kind) => patch({ kind })} options={[['all', 'all kinds'], ...info.kinds.map((k) => [k.id, k.plural] as [string, string])]} />
          <Sel label="status" value={f.status} onChange={(status) => patch({ status })} options={[['all', 'any status'], ['todo', 'to do'], ['open', 'open'], ['ok', 'verified'], ['issue', 'issues'], ['changed', 'changed']]} />
        </div>
        <div className="flex gap-1">
          {scopeOpts.length > 0 && <Sel label="operations: where they stand in the model" value={f.scope} onChange={(scope) => patch({ scope })} options={scopeOpts} />}
          <Sel label="group by" value={f.by} onChange={(by) => patch({ by })} options={[['service', 'by service'], ['kind', 'by kind']]} />
        </div></>}
      </div>
      <ScrollArea className="min-h-0 flex-1" viewportRef={listRef}>
        {!f.others ? <OpTree model={model} current={current?.kind === 'op' ? current.key.slice(3) : undefined} request={vreq} q={f.q} progress={progress}
          state={opState} /> : (
        <div className="py-1">
          {groups.length === 0 && <p className="p-3 text-xs text-muted-foreground">No part matches.</p>}
          {groups.map(([g, ps]) => {
            const open = !collapsed.has(g);
            const tot = groupTotals.get(g) ?? { all: ps.length, ok: 0 };
            return (
              <div key={g}>
                <button type="button" onClick={() => setCollapsed((c) => { const n = new Set(c); if (n.has(g)) n.delete(g); else n.add(g); return n; })}
                  className="sticky top-0 z-10 flex w-full cursor-pointer items-center gap-1.5 bg-background/95 px-2 py-1 text-left text-[11px] font-semibold backdrop-blur">
                  {open ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />}
                  <span className="min-w-0 flex-1 truncate">{g}</span>
                  <span className="tabular text-[10.5px] font-normal text-muted-foreground">{tot.ok}/{tot.all}</span>
                  <span className="h-1 w-10 overflow-hidden rounded-full bg-muted"><span className="block h-full bg-emerald-500" style={{ width: `${(100 * tot.ok) / Math.max(1, tot.all)}%` }} /></span>
                </button>
                {open && ps.map((p) => {
                  const s = status(p);
                  return (
                    <button key={p.key} type="button" data-part={p.key} onClick={() => select(p.key)} aria-current={p.key === partKey}
                      className={cn('flex w-full cursor-pointer items-center gap-1.5 py-[3px] pl-6 pr-2 text-left text-[11.5px] hover:bg-accent/60', p.key === partKey && 'bg-accent font-medium')}>
                      <StatusIcon s={s} />
                      <KindTag kind={p.kind} />
                      <span className="min-w-0 flex-1 truncate" title={p.subtitle ? `${p.title} — ${p.subtitle}` : p.title}>{p.title}</span>
                      {p.flagged ? <span title={`${p.flagged} entries no part covers`} className="shrink-0 rounded bg-amber-500/15 px-1 text-[9.5px] font-medium text-amber-700 dark:text-amber-300">{p.flagged}</span> : null}
                      {p.scope && info.scopes[p.scope]?.badge && <span title={info.scopes[p.scope].about} className="shrink-0 text-[9.5px] text-muted-foreground/80">{info.scopes[p.scope].badge}</span>}
                      {marks[p.key]?.note && <span title={marks[p.key].note} className="size-1.5 shrink-0 rounded-full bg-foreground/40" />}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>)}
      </ScrollArea>
      <p className="border-t px-2 py-1 text-[10px] text-muted-foreground">j/k next/previous · v verified · V verified, next open · i issue · n next open. Marks stay in this browser.</p>
    </aside>
  );

  return (
    <VerifyInfoContext.Provider value={info}>
    <div className="flex h-full min-h-0">
      {showList && list}
      <div className="flex min-w-0 flex-1 flex-col">
        {!showList || narrow ? (
          <div className="flex items-center gap-2 border-b px-2 py-1 text-[11px] text-muted-foreground">
            <button type="button" onClick={() => setShowList((s) => !s)} aria-pressed={showList} title="the parts list" className="flex cursor-pointer items-center gap-1 rounded px-1 hover:bg-accent hover:text-foreground"><PanelLeft className="size-3.5" /> Parts</button>
            <span>{counts.ok} of {parts.length} verified</span>
          </div>
        ) : null}
        <div className="min-h-0 flex-1">
          {current ? (
            <ResizablePanelGroup key={narrow ? 'v' : 'h'} orientation={narrow ? 'vertical' : 'horizontal'} className="h-full">
              <ResizablePanel defaultSize={narrow ? '50%' : '48%'} minSize="25%">
                <ScrollArea className="h-full"><PartView part={current} mark={marks[current.key]} sel={sel} onSelect={setSel} trees={trees} nav={nav} model={model} causes={causes.get(current.key)} hasPart={hasPart} request={vreq} /></ScrollArea>
              </ResizablePanel>
              <ResizableHandle withHandle />
              <ResizablePanel defaultSize={narrow ? '50%' : '52%'} minSize="25%">
                <SourcePane part={current} sel={sel} onSelect={setSel} trees={trees} />
              </ResizablePanel>
            </ResizablePanelGroup>
          ) : (
            <div className="max-w-xl space-y-2 p-4 text-xs">
              <h2 className="text-sm font-semibold">{tx('verify.title') || `Verify the model${source ? ` against ${source}` : ''}`}</h2>
              {!f.others && introOps && <p><RichI text={introOps} /></p>}
              <p><RichI text={introParts} /></p>
              {checks && <p><RichI text={checks} /></p>}
              {scopesText && <p className="text-muted-foreground"><RichI text={scopesText} /></p>}
              {order[0] && <button type="button" onClick={() => select(nav.nextOpen ?? order[0].key)} className="cursor-pointer rounded-md border px-2 py-1 hover:bg-accent">Start with the first open part →</button>}
            </div>
          )}
        </div>
      </div>
    </div>
    </VerifyInfoContext.Provider>
  );
});
