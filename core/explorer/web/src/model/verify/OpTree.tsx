/**
 * The Verify tab's list of operations: the requests, each with its root resolver below it, and the other entry points
 * (provider callbacks, jobs); below each operation the operations it reaches (calls, events, provider callbacks, fields), each with its mark and how many of the rows of
 * what it causes are checked. A request's row sums up the operations below it (finished of all). A filter shows the
 * matching operations flat.
 */
import { memo, useEffect, useMemo, useState } from 'react';
import { ChevronRight, Circle, CircleAlert, CircleCheck, CircleDashed, RefreshCw } from 'lucide-react';
import type { Id, InputModel } from '@contract/types';
import { patchUrl } from '@/lib/useWorkspace';
import { cn } from '@/lib/utils';
import { callGraph, type CallGraph, type CallLink } from '../callGraph';
import { LinkTag } from '../CallTree';
import { KindBadge } from '../shared';
import { opKey } from './data';

/** an operation's state in the tree: `finished` its mark and every row of what it causes checked, `verified` its mark
 *  with rows left, `progress` rows checked without its mark */
export type OpState = 'finished' | 'verified' | 'progress' | 'open' | 'changed' | 'issue';

const STATE_ICON: Record<OpState, { icon: typeof Circle; cls: string; label: string }> = {
  open: { icon: Circle, cls: 'text-muted-foreground/50', label: 'open' },
  progress: { icon: CircleDashed, cls: 'text-emerald-600/80 dark:text-emerald-400/80', label: 'partly checked' },
  verified: { icon: CircleCheck, cls: 'text-emerald-600 dark:text-emerald-400', label: 'verified, rows of what it causes left' },
  finished: { icon: CircleCheck, cls: 'fill-emerald-600 text-background dark:fill-emerald-500', label: 'finished: verified, every row checked' },
  changed: { icon: RefreshCw, cls: 'text-sky-600 dark:text-sky-400', label: 'verified, but its claims changed since' },
  issue: { icon: CircleAlert, cls: 'text-amber-600 dark:text-amber-400', label: 'issue' },
};

export function OpStateIcon({ s, title }: { s?: OpState; title?: string }) {
  if (!s) return <span className="size-3.5 shrink-0" />;
  const { icon: I, cls, label } = STATE_ICON[s];
  return <I aria-label={label} className={cn('size-3.5 shrink-0', cls)}><title>{title ?? label}</title></I>;
}

/** the state of a set of operations: an issue or a change first, finished when all are, open when none is begun */
function sumState(ss: OpState[]): OpState {
  if (ss.includes('issue')) return 'issue';
  if (ss.includes('changed')) return 'changed';
  if (ss.length && ss.every((s) => s === 'finished')) return 'finished';
  return ss.some((s) => s !== 'open') ? 'progress' : 'open';
}

/** `request`: the request the row is reached in (its request row's, or the link's SEFF's), the context its page opens
 *  in; `req`: a request row, its root resolver below it */
interface TreeRow { key: string; depth: number; op: Id; link?: CallLink; hasKids: boolean; request?: string; req?: boolean }

const rootSeffs = (g: CallGraph, op: Id) => g.entryOf.get(op)?.roots.map((r) => r.seff) ?? [];
const kidsOf = (g: CallGraph, seffs: Id[]) => seffs.flatMap((s) => g.opLinks(s));
/** the requests with their root resolver, busiest first */
const requestsOf = (model: InputModel) => model.requests.map((r) => ({ id: r.id, op: r.plan[0]?.op, rate: r.rate }))
  .filter((r): r is { id: Id; op: Id; rate: number } => !!r.op).sort((a, b) => b.rate - a.rate || a.id.localeCompare(b.id));

/** per request the operations its tree holds: the root resolver and every operation below it */
function requestOps(model: InputModel, g: CallGraph): Map<Id, Id[]> {
  const out = new Map<Id, Id[]>();
  for (const r of requestsOf(model)) {
    const ops = new Set<Id>([r.op]);
    const todo = g.entryOf.get(r.op)?.roots.filter((x) => x.request === r.id).map((x) => x.seff) ?? [];
    const seen = new Set(todo);
    while (todo.length) {
      for (const l of g.opLinks(todo.pop()!)) {
        if (l.op) ops.add(l.op);
        if (!seen.has(l.to)) { seen.add(l.to); todo.push(l.to); }
      }
    }
    out.set(r.id, [...ops]);
  }
  return out;
}

function rows(model: InputModel, g: CallGraph, open: Set<string>): TreeRow[] {
  const out: TreeRow[] = [];
  const walk = (seffs: Id[], key: string, depth: number, path: Set<Id>, request?: string) => {
    for (const l of kidsOf(g, seffs)) {
      const k = `${key}/${l.key}`;
      const has = !path.has(l.to) && g.opLinks(l.to).length > 0;
      const rq = l.request ?? request;
      out.push({ key: k, depth, op: l.op!, link: l, hasKids: has, request: rq });
      if (has && open.has(k)) walk([l.to], k, depth + 1, new Set(path).add(l.to), rq);
    }
  };
  // the requests first, each with its root resolver in it below; then the entries that are no request's root
  const roots = new Set<Id>();
  for (const r of requestsOf(model)) {
    roots.add(r.op);
    const key = `r:${r.id}`, k = `${key}/root`;
    const seffs = g.entryOf.get(r.op)?.roots.filter((x) => x.request === r.id).map((x) => x.seff) ?? [];
    out.push({ key, depth: 0, op: r.op, hasKids: true, request: r.id, req: true });
    if (!open.has(key)) continue;
    out.push({ key: k, depth: 1, op: r.op, hasKids: kidsOf(g, seffs).length > 0, request: r.id });
    if (open.has(k)) walk(seffs, k, 2, new Set(seffs), r.id);
  }
  for (const e of g.entries) {
    if (roots.has(e.op)) continue;
    const key = `e:${e.op}`;
    const seffs = rootSeffs(g, e.op);
    out.push({ key, depth: 0, op: e.op, hasKids: kidsOf(g, seffs).length > 0 });
    if (open.has(key)) walk(seffs, key, 1, new Set(seffs));
  }
  return out;
}

/** every operation the entry points reach, depth first (the order of j / k) */
export function treeOrder(model: InputModel): Id[] {
  const g = callGraph(model);
  const seen = new Set<Id>();
  const walk = (seffs: Id[], path: Set<Id>) => {
    for (const l of kidsOf(g, seffs)) {
      if (l.op) seen.add(l.op);
      if (!path.has(l.to)) walk([l.to], new Set(path).add(l.to));
    }
  };
  for (const e of g.entries) { seen.add(e.op); walk(rootSeffs(g, e.op), new Set(rootSeffs(g, e.op))); }
  return [...seen];
}

/** the keys to open so that an operation shows, in the request if it is reached in it */
function pathKeys(model: InputModel, g: CallGraph, op: Id, request?: Id): string[] {
  const rqs = requestsOf(model);
  const own = rqs.filter((r) => r.op === op);
  if (own.length) return [`r:${(own.find((r) => r.id === request) ?? own[0]).id}`];
  if (g.entryOf.has(op)) return [];
  const ps = g.paths(op, 50);
  const p = ps.find((x) => request && x.links[0]?.request === request) ?? ps[0];
  if (!p) return [];
  const rq = p.links[0]?.request;
  let key = rq && rqs.some((r) => r.id === rq && r.op === p.entry) ? `r:${rq}/root` : `e:${p.entry}`;
  const keys = key.startsWith('r:') ? [`r:${rq}`, key] : [key];
  p.links.forEach((l, i) => { key = `${key}/${l.key}`; if (i < p.links.length - 1) keys.push(key); });
  return keys;
}

export const OpTree = memo(function OpTree({ model, current, request, q, state, progress }: {
  model: InputModel; current?: Id; request?: Id; q: string;
  state: (op: Id) => OpState | undefined; progress: (op: Id) => { ok: number; issue: number; all: number } | undefined;
}) {
  const g = callGraph(model);
  const reqOps = useMemo(() => requestOps(model, g), [model, g]);
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!current) return;
    const ks = pathKeys(model, g, current, request);
    if (ks.some((k) => !open.has(k))) setOpen((o) => new Set([...o, ...ks]));
  }, [current, request, g]); // eslint-disable-line react-hooks/exhaustive-deps
  const t = q.trim().toLowerCase();
  const list = useMemo<TreeRow[]>(() => (t
    ? treeOrder(model).filter((op) => op.toLowerCase().includes(t)).map((op) => ({ key: `q:${op}`, depth: 0, op, hasKids: false }))
    : rows(model, g, open)), [g, open, t, model]);
  const toggle = (k: string) => setOpen((o) => { const n = new Set(o); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const select = (op: Id, request?: string) => patchUrl({ model: `verify:${opKey(op)}`, mtab: null, vreq: request ?? null });
  return (
    <ul className="py-1">
      {list.length === 0 && <li className="p-3 text-xs text-muted-foreground">No operation matches.</li>}
      {list.map((r) => {
        const o = g.ops.get(r.op);
        const pr = progress(r.op);
        const isOpen = open.has(r.key);
        const here = !r.req && r.op === current && (!request || !r.request || r.request === request);
        const ss = r.req ? (reqOps.get(r.request!) ?? []).map(state).filter((x): x is OpState => !!x) : [];
        const fin = ss.filter((x) => x === 'finished').length;
        return (
          <li key={r.key} data-part={opKey(r.op)} onClick={() => { if (r.req && !isOpen) toggle(r.key); select(r.op, r.request); }} aria-current={here}
            className={cn('flex cursor-pointer items-center gap-1 py-[3px] pr-2 text-[11.5px] hover:bg-accent/60', here && 'bg-accent font-medium')}
            style={{ paddingLeft: 4 + r.depth * 12 }}>
            {r.hasKids ? (
              <button type="button" onClick={(e) => { e.stopPropagation(); toggle(r.key); }} aria-label={isOpen ? 'Collapse' : 'Expand'} aria-expanded={isOpen}
                className="grid size-4 shrink-0 cursor-pointer place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground">
                <ChevronRight className={cn('size-3 transition-transform', isOpen && 'rotate-90')} />
              </button>
            ) : <span className="size-4 shrink-0" />}
            {r.req ? <>
              <OpStateIcon s={ss.length ? sumState(ss) : undefined} title={`${fin} of ${ss.length} operations of ${r.request} finished`} />
              {o && <KindBadge op={o} />}
              <span className="min-w-0 flex-1 truncate" title={`the request ${r.request}, its root resolver ${r.op}`}>{r.request}</span>
            </> : <>
              <OpStateIcon s={state(r.op)} title={pr && pr.all ? `${STATE_ICON[state(r.op) ?? 'open'].label}; ${pr.ok} of ${pr.all} rows checked` : undefined} />
              {r.link && <LinkTag l={r.link} g={g} compact />}
              {o && <KindBadge op={o} />}
              <span className="min-w-0 flex-1 truncate" title={r.op}>{o && (o.kind === 'reaction' || o.kind === 'callback') ? <span className="font-normal text-muted-foreground">{o.service}.</span> : null}{o?.name ?? r.op}</span>
            </>}
            {r.req && ss.length > 0 && <span className={cn('shrink-0 text-[9.5px] tabular', fin === ss.length ? 'text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground')} title={`${fin} of ${ss.length} operations finished`}>{`${fin}/${ss.length}`}</span>}
            {pr && !r.req && pr.all > 0 && <span className={cn('shrink-0 text-[9.5px] tabular', pr.issue ? 'text-amber-700 dark:text-amber-300' : pr.ok === pr.all ? 'text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground')} title={`${pr.ok} of ${pr.all} rows of what it causes checked${pr.issue ? `, ${pr.issue} issues` : ''}`}>{pr.ok}/{pr.all}</span>}
          </li>
        );
      })}
    </ul>
  );
});
