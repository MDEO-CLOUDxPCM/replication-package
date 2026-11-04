/**
 * The Verify tab's source pane: the files a part's evidence points at (and those of the code contributing its steps
 * the evidence does not show, related.ts) and the documents to read it against, one shown at a time, highlighted
 * (highlight.ts), with the part's evidence lines marked, the calls between the contributing functions clickable and
 * the selected line (or the document's anchor) in view.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Copy, WrapText } from 'lucide-react';
import type { Loc, Part } from '@contract/verify';
import { usePacketSourceFile } from '@/lib/api';
import { usePacketId, useTexts, type Tx } from '@/lib/packet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { isExternal, useChains, useVerifyInfo, type Trees } from './data';
import { useHighlight } from './highlight';
import { relatedCode, segments, type CallSite, type Fn } from './related';

/** what the pane shows: a file (in a source tree, `repo`), a line in it or the anchor of a document */
export interface SourceSel { repo: Loc['repo']; path: string; line?: number; find?: string[] }

export const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
export const sameFile = (a: { repo: string; path: string } | null | undefined, b: { repo: string; path: string }) => !!a && a.repo === b.repo && a.path === b.path;

/** every evidence location of a part (facts and rows) */
export function partEvidence(p: Pick<Part, 'facts' | 'tables'>): Loc[] {
  return [...p.facts.flatMap((f) => f.ev ?? []), ...p.tables.flatMap((t) => t.rows.flatMap((r) => r.ev))];
}

/** the files of a part's evidence, in order of first mention, with their lines */
export function evidenceFiles(p: Pick<Part, 'facts' | 'tables'>, trees: Trees | undefined) {
  const files = new Map<string, { repo: Loc['repo']; path: string; lines: Set<number>; first?: number }>();
  for (const l of partEvidence(p)) {
    if (isExternal(l, trees)) continue;
    const k = `${l.repo}:${l.path}`;
    if (!files.has(k)) files.set(k, { repo: l.repo, path: l.path, lines: new Set(), first: l.line });
    if (l.line) files.get(k)!.lines.add(l.line);
  }
  return [...files.values()];
}

/** the line of a document's anchor: each regex from the previous match on */
function locate(lines: string[], find: string[] | undefined): number | undefined {
  if (!find?.length) return undefined;
  let at = 0;
  for (const f of find) {
    let re: RegExp;
    try { re = new RegExp(f); } catch { return undefined; }
    const i = lines.findIndex((l, k) => k >= at && re.test(l));
    if (i < 0) return at > 0 ? at + 1 : undefined;
    at = i;
  }
  return at + 1;
}

/** the theme's colour of a highlighted token (highlight.ts) */
const TOK = 'text-[color:var(--shiki-light)] dark:text-[color:var(--shiki-dark)]';
const fnTitle = (f: Fn, fns: Fn[], tx: Tx) => `${f.label} (${f.path.slice(f.path.lastIndexOf('/') + 1)}:${f.line})${f.entry ? ': the entry' : f.from ? `, called by ${fns.find((g) => g.key === f.from)?.label ?? f.from}` : ''}${f.pm ? '; a persistence method' : ''}${f.reached ? '' : `; ${tx('verify.chain.unreached') || 'has steps, but the call graph does not reach it from the entry'}`}`;

export function SourcePane({ part, sel, onSelect, trees }: { part: Part; sel: SourceSel | null; onSelect: (s: SourceSel) => void; trees: Trees | undefined }) {
  const tx = useTexts();
  const info = useVerifyInfo();
  // the tree the chains' code is in
  const code = info.tree;
  const files = useMemo(() => evidenceFiles(part, trees), [part, trees]);
  const chains = useChains();
  const rel = useMemo(() => relatedCode(part, chains.data), [part, chains.data]);
  const { data, error, isLoading } = usePacketSourceFile(usePacketId(), sel?.repo, sel?.path);
  const lines = useMemo(() => data?.text.replace(/\n$/, '').split('\n') ?? [], [data]);
  const toks = useHighlight(data?.path, data?.text);
  // the files of contributing functions the evidence does not show, as tabs after it
  const callees = useMemo(() => {
    const m = new Map<string, Fn[]>();
    for (const f of rel.fns) if (!files.some((e) => e.repo === code && e.path === f.path)) m.set(f.path, [...(m.get(f.path) ?? []), f]);
    return [...m];
  }, [rel, files, code]);
  // the calls in this file (by line) and the lines of its contributing functions
  const here = useMemo(() => {
    const calls = new Map<number, CallSite[]>();
    const fnLines = new Set<number>();
    if (!code || sel?.repo !== code) return { calls, fnLines };
    for (const c of rel.calls) if (c.path === sel.path) calls.set(c.line, [...(calls.get(c.line) ?? []), c]);
    for (const f of rel.fns) if (f.path === sel.path) for (let n = f.line; n <= f.end; n++) fnLines.add(n);
    return { calls, fnLines };
  }, [rel, sel?.repo, sel?.path, code]);
  const marked = useMemo(() => (sel ? files.find((f) => sameFile(sel, f))?.lines ?? new Set<number>() : new Set<number>()), [files, sel]);
  const anchor = useMemo(() => sel?.line ?? locate(lines, sel?.find), [sel, lines]);
  const [wrap, setWrap] = useState(true);
  const [q, setQ] = useState('');
  const [hit, setHit] = useState(-1);
  const matches = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? lines.flatMap((l, i) => (l.toLowerCase().includes(t) ? [i + 1] : [])) : [];
  }, [q, lines]);
  useEffect(() => { setHit(-1); }, [q, sel?.path]);
  const focusLine = hit >= 0 ? matches[hit] : anchor;
  const target = useRef<HTMLDivElement>(null);
  useEffect(() => { target.current?.scrollIntoView({ block: 'center' }); }, [focusLine, data, sel]);
  const step = (d: number) => matches.length && setHit((h) => (h < 0 ? (d > 0 ? 0 : matches.length - 1) : (h + d + matches.length) % matches.length));

  const chipCls = (on: boolean) => cn('max-w-full cursor-pointer truncate rounded border px-1.5 py-px font-mono text-[10.5px] transition-colors', on ? 'border-foreground/40 bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground');
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-1 border-b p-2">
        {files.length + callees.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="w-16 shrink-0 text-[10.5px] text-muted-foreground">evidence</span>
            {files.map((f) => (
              <button key={`${f.repo}:${f.path}`} type="button" title={`${f.path} (lines ${[...f.lines].sort((a, b) => a - b).join(', ') || '–'})`}
                onClick={() => onSelect({ repo: f.repo, path: f.path, line: f.first })} className={chipCls(sameFile(sel, f))}>
                {base(f.path)}{f.lines.size > 0 && <span className="opacity-60"> ·{f.lines.size}</span>}
              </button>
            ))}
            {callees.map(([path, fs]) => (
              <button key={path} type="button" title={`${path}: ${fs.map((f) => fnTitle(f, rel.fns, tx)).join('; ')}`} onClick={() => onSelect({ repo: code!, path, line: fs[0].line })}
                className={cn(chipCls(!!sel && sel.repo === code && sel.path === path), 'border-dashed')}>
                <span className="opacity-60">calls </span>{base(path)}
              </button>
            ))}
          </div>
        )}
        {part.docs.length > 0 && (
          <div className="flex flex-wrap items-center gap-1">
            <span className="w-16 shrink-0 text-[10.5px] text-muted-foreground">read against</span>
            {part.docs.map((d) => (
              <button key={`${d.loc.repo}:${d.loc.path}`} type="button" title={d.loc.path} onClick={() => onSelect({ repo: d.loc.repo, path: d.loc.path, find: d.find })}
                className={chipCls(sameFile(sel, d.loc))}>
                <span className="opacity-60">{info.docKinds[d.kind] ?? d.kind} </span>{base(d.loc.path)}
              </button>
            ))}
          </div>
        )}
      </div>
      {sel ? (
        <>
          <div className="flex items-center gap-1.5 border-b px-2 py-1">
            <button type="button" title={`${sel.path}${focusLine ? `:${focusLine}` : ''} (click to copy)`} onClick={() => void navigator.clipboard?.writeText(`${sel.path}${focusLine ? `:${focusLine}` : ''}`).catch(() => undefined)}
              className="flex min-w-0 cursor-pointer items-center gap-1 truncate font-mono text-[10.5px] text-muted-foreground hover:text-foreground">
              <Copy className="size-3 shrink-0" /><span className="truncate">{info.source(sel.repo)?.kind === 'git' ? `${info.label(sel.repo)} ` : ''}{sel.path}</span>
            </button>
            {data?.commit && <span className="shrink-0 font-mono text-[10px] text-muted-foreground/70">@{data.commit.slice(0, 8)}</span>}
            <div className="ml-auto flex shrink-0 items-center gap-1">
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="find" aria-label="Find in the file"
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); } if (e.key === 'Escape') setQ(''); }}
                className="h-6 w-28 rounded border bg-transparent px-1.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring/50" />
              {q && <span className="tabular text-[10.5px] text-muted-foreground">{matches.length ? `${hit < 0 ? '–' : hit + 1}/${matches.length}` : '0'}</span>}
              <button type="button" aria-label="Previous match" onClick={() => step(-1)} className="cursor-pointer rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"><ChevronUp className="size-3.5" /></button>
              <button type="button" aria-label="Next match" onClick={() => step(1)} className="cursor-pointer rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"><ChevronDown className="size-3.5" /></button>
              <button type="button" aria-label="Wrap lines" aria-pressed={wrap} title="wrap long lines" onClick={() => setWrap((w) => !w)}
                className={cn('cursor-pointer rounded p-0.5 hover:bg-accent hover:text-foreground', wrap ? 'text-foreground' : 'text-muted-foreground')}><WrapText className="size-3.5" /></button>
            </div>
          </div>
          <ScrollArea className="min-h-0 flex-1" horizontal={!wrap}>
            {isLoading ? <p className="p-3 text-xs text-muted-foreground">Loading {sel.path} …</p>
              : error ? <p className="p-3 text-xs text-destructive">{String((error as Error).message ?? error)}</p>
                : (
                  <div className="py-1 font-mono text-[11px] leading-[1.45]">
                    {sel.find && anchor === undefined && <p className="px-3 pb-1 font-sans text-[11px] text-muted-foreground">No anchor found for this part; use find.</p>}
                    {lines.map((l, i) => {
                      const n = i + 1;
                      return (
                        <div key={n} ref={n === focusLine ? target : undefined}
                          className={cn('flex', marked.has(n) && 'bg-amber-500/12', n === focusLine && 'bg-amber-500/30', hit >= 0 && matches.includes(n) && n !== focusLine && 'bg-sky-500/12')}>
                          <span className={cn('w-11 shrink-0 select-none border-l-2 pr-2 text-right tabular text-muted-foreground/60', here.fnLines.has(n) ? 'border-sky-500/45' : 'border-transparent', marked.has(n) && 'font-semibold text-amber-700 dark:text-amber-300')}>{n}</span>
                          <span className={cn('min-w-0 pr-3', wrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre')}>
                            {l ? segments(l, toks?.[i], here.calls.get(n) ?? []).map((g, k) => (g.link ? (
                              <span key={k} role="link" tabIndex={0} style={g.style} title={`${g.link.to.label} (${g.link.to.path.slice(g.link.to.path.lastIndexOf('/') + 1)}:${g.link.to.line})`}
                                onClick={() => onSelect({ repo: code!, path: g.link!.to.path, line: g.link!.to.line })}
                                onKeyDown={(e) => { if (e.key === 'Enter') onSelect({ repo: code!, path: g.link!.to.path, line: g.link!.to.line }); }}
                                className={cn(g.style && TOK, 'cursor-pointer rounded-sm underline decoration-sky-500/80 decoration-dotted underline-offset-2 hover:bg-sky-500/20 hover:decoration-solid')}>{g.content}</span>
                            ) : <span key={k} style={g.style} className={g.style && TOK}>{g.content}</span>)) : ' '}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
          </ScrollArea>
        </>
      ) : <p className="p-3 text-xs text-muted-foreground">No sources for this part.</p>}
    </div>
  );
}
