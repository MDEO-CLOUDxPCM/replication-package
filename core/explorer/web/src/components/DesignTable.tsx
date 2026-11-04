import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, Check, X } from 'lucide-react';
import type { DesignSummary, Run } from '@contract/types';
import { fmt } from '@/lib/format';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useHover } from '@/lib/store';
import { cn } from '@/lib/utils';
import { MetricHelp } from '@/help/MetricHelp';

interface Props {
  run: Run;
  /** the designs to show (a subset of `universe`, in any order) */
  designs: DesignSummary[];
  /** every design of the run: sorted once per sort order, the shown rows are filtered from it in that order */
  universe?: DesignSummary[];
  a: string | null;
  b: string | null;
  onPick: (id: string, slot: 'a' | 'b') => void;
  onOpen: (id: string) => void;
  sorting: SortingState;
  onSorting: (s: SortingState) => void;
}

export type SortingState = { id: string; desc: boolean }[];

interface Col {
  id: string;
  header: string;
  size: number;
  /** sort key; absent: not sortable */
  value?: (d: DesignSummary) => number | string;
  cell: (d: DesignSummary) => React.ReactNode;
  align?: 'right';
}

/** sort order of `ds` by one column: keys computed once, stable (ties keep the run's order) */
function sortBy(ds: DesignSummary[], col: Col | undefined, desc: boolean): DesignSummary[] {
  if (!col?.value) return ds;
  const n = ds.length;
  const keys = new Array<number | string>(n);
  let strings = false;
  for (let i = 0; i < n; i++) { const v = col.value(ds[i]); keys[i] = v; if (typeof v === 'string') strings = true; }
  const ord = new Uint32Array(n);
  for (let i = 0; i < n; i++) ord[i] = i;
  const sgn = desc ? -1 : 1;
  if (strings) {
    const sk = keys.map(String);
    ord.sort((i, j) => (sk[i] < sk[j] ? -sgn : sk[i] > sk[j] ? sgn : i - j));
  } else {
    const nk = Float64Array.from(keys as number[], (v) => (Number.isFinite(v) ? v : desc ? -Infinity : Infinity));
    ord.sort((i, j) => (nk[i] - nk[j]) * sgn || i - j);
  }
  const out = new Array<DesignSummary>(n);
  for (let i = 0; i < n; i++) out[i] = ds[ord[i]];
  return out;
}

/**
 * virtualised design table; keyboard: ↑/↓ move, Enter open, a / b pick as A / B, Home/End.
 * No table library row model: 60 000 rows are sorted once per sort order (over the whole run) and a filter change
 * only selects from that order (O(n), no per-row objects), so the panel's switches stay fast.
 */
export function DesignTable({ run, designs, universe, a, b, onPick, onOpen, sorting, onSorting }: Props) {
  // hover never re-renders the table: each row subscribes to whether it is the hovered one
  const setHovered = useHover((s) => s.setHovered);
  const active = useRef(-1);
  const columns = useMemo<Col[]>(() => [
    {
      id: 'sel', header: '', size: 34,
      cell: () => null,
    },
    {
      id: 'design', header: 'Design', size: 150, value: (d) => d.label ?? d.id,
      cell: (d) => (
        <span className="truncate">
          {d.label ? <span className="font-medium">{d.label}</span> : <span className="font-mono text-xs text-muted-foreground">{d.id.slice(0, 10)}</span>}
        </span>
      ),
    },
    { id: 'rank', header: 'Rank', size: 80, value: (d) => (d.feasible ? d.rank ?? 99 : 999), cell: (d) => (d.feasible ? (d.rank === 0 ? <span className="font-medium text-series-1">front</span> : d.rank ?? '–') : <span className="text-muted-foreground">–</span>) },
    ...run.objectives.map((o, k): Col => ({
      id: o.key, header: `${o.label}${o.unit ? ` (${o.unit})` : ''}`, size: 124, value: (d) => d.objectives[k],
      cell: (d) => <span className="tabular">{fmt(d.objectives[k], o.digits ?? 2)}</span>, align: 'right',
    })),
    { id: 'feasible', header: 'OK', size: 58, value: (d) => (d.feasible ? 1 : 0), cell: (d) => (d.feasible ? <Check className="size-3.5 text-[var(--status-good)]" aria-label="feasible" /> : <X className="size-3.5 text-[var(--status-critical)]" aria-label="infeasible" />) },
    ...(run.metrics.some((m) => m.key === 'services') ? [{ id: 'services', header: 'Services', size: 86, value: (d: DesignSummary) => d.metrics.services ?? NaN, cell: (d: DesignSummary) => <span className="tabular">{d.metrics.services ?? '–'}</span>, align: 'right' } as Col] : []),
    { id: 'born', header: 'Born', size: 70, value: (d) => d.born ?? -1, cell: (d) => <span className="tabular text-muted-foreground">{(d.born ?? -1) >= 0 ? d.born : '–'}</span>, align: 'right' },
  ], [run]);

  const sortId = sorting[0]?.id, sortDesc = !!sorting[0]?.desc;
  const base = universe ?? designs;
  const sorted = useMemo(() => sortBy(base, columns.find((c) => c.id === sortId), sortDesc), [base, columns, sortId, sortDesc]);
  const rows = useMemo(() => {
    if (designs === base) return sorted;
    if (!universe) return sortBy(designs, columns.find((c) => c.id === sortId), sortDesc);
    const keep = new Set(designs);
    return sorted.filter((d) => keep.has(d));
  }, [sorted, designs, base, universe, columns, sortId, sortDesc]);
  const toggleSort = (c: Col) => {
    if (sortId !== c.id) { onSorting([{ id: c.id, desc: typeof c.value!(base[0] ?? designs[0]) !== 'string' && c.id !== 'rank' }]); return; }
    const firstDesc = typeof c.value!(base[0] ?? designs[0]) !== 'string' && c.id !== 'rank';
    if (sortDesc === firstDesc) onSorting([{ id: c.id, desc: !sortDesc }]);
    else onSorting([]);
  };
  const scroller = useRef<HTMLDivElement>(null);
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => scroller.current, estimateSize: () => ROW_H, overscan: 12, scrollPaddingStart: HEADER_H });

  // row index by id, built only when needed (keyboard, following A) instead of on every filter change
  const indexOf = (id: string) => rows.findIndex((d) => d.id === id);
  // scroll a row into view only when it is not visible (scrollToIndex measures the layout)
  const reveal = (i: number, align: 'auto' | 'center' = 'auto') => {
    const el = scroller.current;
    if (!el) return;
    const top = i * ROW_H, view = el.clientHeight - HEADER_H;
    if (top < el.scrollTop || top + ROW_H > el.scrollTop + view) v.scrollToIndex(i, { align });
  };
  // the table follows the selection (A), not the hover: scrolling on every hovered point would
  // make the table jump (and measure its layout) while the pointer moves over the chart
  useEffect(() => {
    const i = a ? indexOf(a) : -1;
    if (i >= 0 && document.activeElement !== scroller.current) reveal(i, 'center');
  }, [a]); // eslint-disable-line react-hooks/exhaustive-deps

  const move = (i: number) => {
    const j = Math.max(0, Math.min(rows.length - 1, i));
    active.current = j;
    setHovered(rows[j]?.id ?? null);
    reveal(j);
  };
  const onKey = (e: React.KeyboardEvent) => {
    const h = useHover.getState().hovered;
    const cur = active.current < 0 ? (h ? indexOf(h) : -1) : active.current;
    if (e.key === 'ArrowDown') { e.preventDefault(); move(cur + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(cur - 1); }
    else if (e.key === 'PageDown') { e.preventDefault(); move(cur + 15); }
    else if (e.key === 'PageUp') { e.preventDefault(); move(cur - 15); }
    else if (e.key === 'Home') { e.preventDefault(); move(0); }
    else if (e.key === 'End') { e.preventDefault(); move(rows.length - 1); }
    else if (e.key === 'Enter' && rows[cur]) onOpen(rows[cur].id);
    else if ((e.key === 'a' || e.key === 'b') && rows[cur]) onPick(rows[cur].id, e.key);
  };
  const enter = useCallback((id: string, i: number) => { setHovered(id); active.current = i; }, [setHovered]);
  const grid = columns.map((c, i) => (i === 1 ? `minmax(${c.size}px, 1.5fr)` : `${c.size}px`)).join(' ');

  return (
    <div className="flex h-full min-h-0 flex-col text-sm">
      <ScrollArea horizontal className="min-h-0 flex-1" viewportRef={scroller}
        viewportProps={{ tabIndex: 0, onKeyDown: onKey, role: 'grid', 'aria-label': 'Designs', 'aria-rowcount': rows.length, onMouseLeave: () => setHovered(null) }}>
      <div className="sticky top-0 z-10 grid border-b bg-muted text-xs font-medium text-muted-foreground" style={{ gridTemplateColumns: grid }} role="row">
        {columns.map((c) => {
          const sorted = sortId === c.id ? (sortDesc ? 'desc' : 'asc') : false;
          return (
            <div key={c.id} role="columnheader" aria-sort={sorted ? (sorted === 'asc' ? 'ascending' : 'descending') : 'none'} className={cn('flex min-w-0 items-center gap-0.5 px-2', c.align === 'right' && 'justify-end')}>
              <button type="button" className={cn('flex min-w-0 items-center gap-1 py-2 text-left hover:text-foreground', c.value && 'cursor-pointer')}
                onClick={() => c.value && toggleSort(c)} disabled={!c.value}>
                <span className="truncate">{c.header}</span>
                {sorted === 'asc' && <ArrowUp className="size-3 shrink-0" />}
                {sorted === 'desc' && <ArrowDown className="size-3 shrink-0" />}
              </button>
              <MetricHelp k={c.id} />
            </div>
          );
        })}
      </div>
        <div style={{ height: v.getTotalSize(), position: 'relative' }}>
          {v.getVirtualItems().map((vi) => (
            <Row key={rows[vi.index].id} d={rows[vi.index]} columns={columns} index={vi.index} start={vi.start} size={vi.size} grid={grid} a={a} b={b}
              onPick={onPick} onOpen={onOpen} onEnter={enter} />
          ))}
        </div>
      </ScrollArea>
      <div className="shrink-0 border-t px-3 py-1.5 text-[11px] text-muted-foreground">
        {rows.length.toLocaleString()} designs · click / Enter: A · shift-, alt- or right-click: B · keys ↑ ↓ a b
      </div>
    </div>
  );
}

const ROW_H = 30, HEADER_H = 34;

/** one table row; re-renders when its own data, position or hover state change */
const Row = memo(function Row({ d, columns, index, start, size, grid, a, b, onPick, onOpen, onEnter }: {
  d: DesignSummary; columns: Col[]; index: number; start: number; size: number; grid: string; a: string | null; b: string | null;
  onPick: (id: string, slot: 'a' | 'b') => void; onOpen: (id: string) => void; onEnter: (id: string, i: number) => void;
}) {
  const isHover = useHover((s) => s.hovered === d.id);
  const sel = d.id === a || d.id === b;
  return (
    <div role="row" aria-rowindex={index + 1} aria-selected={sel}
      className={cn('absolute left-0 right-0 grid cursor-pointer items-center border-b border-border/50',
        isHover ? 'bg-accent' : index % 2 ? 'bg-muted/20' : '', sel && 'bg-accent/60')}
      style={{ top: start, height: size, gridTemplateColumns: grid }}
      onMouseEnter={() => onEnter(d.id, index)}
      onClick={(e) => onPick(d.id, e.shiftKey || e.altKey ? 'b' : 'a')}
      onContextMenu={(e) => { e.preventDefault(); onPick(d.id, 'b'); }}
      onDoubleClick={() => onOpen(d.id)}>
      {columns.map((c) => (
        <div key={c.id} className={cn('truncate px-2', c.align === 'right' && 'text-right')}>
          {c.id === 'sel'
            ? d.id === a ? <span className="inline-grid size-4 place-items-center rounded-full bg-select-a text-[9px] font-bold text-white">A</span>
              : d.id === b ? <span className="inline-grid size-4 place-items-center rounded-full bg-select-b text-[9px] font-bold text-white">B</span> : null
            : c.cell(d)}
        </div>
      ))}
    </div>
  );
});
