/**
 * A request's GraphQL document on an operation's Verify page: the document pretty-printed, the operation's own
 * selection highlighted (what it reads for the request: its fields), the further fields of the gateway plan that other
 * operations resolve linked to them (`plan[i].parent` is the entry whose objects the field is resolved on).
 */
import type { Id, ModelRequest } from '@contract/types';
import { planVia } from '@contract/plan';
import { patchUrl } from '@/lib/useWorkspace';
import { cn } from '@/lib/utils';
import { opKey } from './data';
import { PLAN_VIA_LABEL } from '../CallTree';

/** a plan entry's `via` in words (contract PlanVia; accepts the older spelling `local`) */
const viaLabel = (v: string) => PLAN_VIA_LABEL[planVia(v) ?? ''] ?? v;

export interface GNode { name: string; alias?: string; args?: string; kids?: GNode[] }

/** the operation's head (`query name($v: T)`) and its top-level selection; null if it does not parse */
export function parseDocument(doc: string): { head: string; roots: GNode[] } | null {
  let i = 0;
  const ws = () => { while (i < doc.length && /[\s,]/.test(doc[i])) i++; };
  const name = () => { const m = /^[_A-Za-z][_0-9A-Za-z]*/.exec(doc.slice(i)); if (!m) return null; i += m[0].length; return m[0]; };
  // a balanced (...) with strings, its whitespace collapsed
  const parens = () => {
    const from = i;
    let depth = 0;
    for (; i < doc.length; i++) {
      const c = doc[i];
      if (c === '"') { i++; while (i < doc.length && doc[i] !== '"') i += doc[i] === '\\' ? 2 : 1; continue; }
      if (c === '(') depth++;
      if (c === ')' && --depth === 0) { i++; break; }
    }
    return doc.slice(from, i).replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')');
  };
  const selection = (): GNode[] | null => {
    if (doc[i] !== '{') return null;
    i++;
    const out: GNode[] = [];
    for (;;) {
      ws();
      if (i >= doc.length) return null;
      if (doc[i] === '}') { i++; return out; }
      let n: GNode;
      if (doc.startsWith('...', i)) {
        i += 3; ws();
        const a = name(); ws();
        const b = a === 'on' ? name() : null;
        n = { name: b ? `... on ${b}` : `...${a ?? ''}` };
      } else {
        const a = name();
        if (!a) return null;
        ws();
        if (doc[i] === ':') { i++; ws(); const b = name(); if (!b) return null; n = { name: b, alias: a }; } else n = { name: a };
      }
      ws();
      if (doc[i] === '(') n.args = parens();
      ws();
      while (doc[i] === '@') { i++; const d = name(); ws(); n.args = `${n.args ?? ''} @${d}${doc[i] === '(' ? parens() : ''}`.trim(); ws(); }
      if (doc[i] === '{') { const k = selection(); if (!k) return null; n.kids = k; }
      out.push(n);
    }
  };
  // the head ends at the first `{` outside parentheses (a variable's default can be `{}`)
  let depth = 0;
  for (; i < doc.length; i++) {
    if (doc[i] === '(') depth++;
    else if (doc[i] === ')') depth--;
    else if (doc[i] === '{' && depth === 0) break;
  }
  const head = doc.slice(0, i).replace(/\s+/g, ' ').trim();
  const roots = selection();
  return roots ? { head, roots } : null;
}

/**
 * the document's node of each plan entry: the root field, then each further field below its parent's node; an entity
 * fetch (`<svc>._entities.<Type>`) has no field of its own: it resolves the objects of its parent's field (a
 * connection's `nodes`), `entity` maps that selection to it
 */
export function planNodes(r: ModelRequest, roots: GNode[]): { at: Map<GNode, number>; entity: Map<GNode, number> } {
  const field = (op: Id) => op.split('.').pop()!;
  const find = (ns: GNode[], nm: string): GNode | undefined => {
    for (const n of ns) if (n.name === nm) return n;
    for (const n of ns) { const f = n.kids && find(n.kids, nm); if (f) return f; }
    return undefined;
  };
  const nodes: (GNode | undefined)[] = [];
  const at = new Map<GNode, number>(), entity = new Map<GNode, number>();
  r.plan.forEach((p, idx) => {
    const parent = idx === 0 ? undefined : nodes[p.parent ?? 0];
    if (idx > 0 && p.op.includes('._entities.')) {
      const scope = parent?.kids?.find((k) => k.name === 'nodes' || k.name === 'edges') ?? parent;
      nodes[idx] = scope;
      if (scope) entity.set(scope, idx);
      return;
    }
    const within = idx === 0 ? roots : parent?.kids;
    nodes[idx] = within ? find(within, field(p.op)) : undefined;
    if (nodes[idx]) at.set(nodes[idx]!, idx);
  });
  return { at, entity };
}

export function GraphqlDoc({ r, op }: { r: ModelRequest; op: Id }) {
  const doc = r.document ? parseDocument(r.document) : null;
  if (!doc) return <pre className="whitespace-pre-wrap break-words rounded border bg-muted/30 p-2 font-mono text-[10.5px]">{r.document}</pre>;
  const { at: plan, entity } = planNodes(r, doc.roots);
  const mine = [...plan].filter(([, i]) => r.plan[i].op === op).map(([n]) => n);
  const lines: { depth: number; node?: GNode; text: string; close?: boolean; own: boolean; leaves?: GNode[] }[] = [];
  const walk = (ns: GNode[], depth: number, own: boolean) => {
    // leaves that are no plan entry on one line, the rest one per line
    const leaves = ns.filter((n) => !n.kids && !plan.has(n));
    if (leaves.length) lines.push({ depth, text: '', own, leaves });
    for (const n of ns) {
      if (!n.kids && !plan.has(n)) continue;
      const isMine = mine.includes(n);
      const o = own || isMine;
      // a nested plan entry of another operation ends this operation's selection; an entity fetch's objects are its
      const e = entity.get(n);
      const sub = e !== undefined ? r.plan[e].op === op : isMine ? true : plan.has(n) ? false : o;
      lines.push({ depth, node: n, text: '', own: plan.has(n) && !isMine ? false : o });
      if (n.kids) { walk(n.kids, depth + 1, sub); lines.push({ depth, text: '}', close: true, own: sub }); }
    }
  };
  walk(doc.roots, 1, false);
  const label = (n: GNode) => `${n.alias ? `${n.alias}: ` : ''}${n.name}${n.args ? n.args : ''}`;
  return (
    <div className="overflow-x-auto rounded border bg-muted/30 py-1 font-mono text-[10.5px] leading-[1.45]">
      <div className="px-2 text-muted-foreground">{doc.head} {'{'}</div>
      {lines.map((l, k) => {
        const ei = l.node ? entity.get(l.node) : undefined;
        const pi = l.node ? plan.get(l.node) : undefined;
        const other = pi !== undefined && r.plan[pi].op !== op;
        const self = pi !== undefined && r.plan[pi].op === op;
        return (
          <div key={k} style={{ paddingLeft: 8 + l.depth * 14 }} className={cn('whitespace-pre pr-2', l.own ? 'bg-amber-500/10 text-foreground' : 'text-muted-foreground')}>
            {l.leaves ? l.leaves.map((n) => label(n)).join(' ')
              : l.close ? '}'
                : <>
                  {other ? (
                    <button type="button" title={`resolved by ${r.plan[pi!].op} (${viaLabel(r.plan[pi!].via)}): check it in ${r.id}`} onClick={() => patchUrl({ model: `verify:${opKey(r.plan[pi!].op)}`, mtab: null, vreq: r.id })}
                      className="cursor-pointer underline decoration-border decoration-1 underline-offset-2 hover:text-foreground hover:decoration-foreground/60">{label(l.node!)}</button>
                  ) : <span className={cn(self && 'font-semibold')}>{label(l.node!)}</span>}
                  {l.node!.kids ? ' {' : ''}
                  {other && <span className="text-[9.5px] text-muted-foreground"> {'  '}# {r.plan[pi!].op.split('.').slice(0, -1).join('.')} · {viaLabel(r.plan[pi!].via)}</span>}
                  {ei !== undefined && (
                    <span className="text-[9.5px] text-muted-foreground"> {'  '}# objects resolved by{' '}
                      {r.plan[ei].op === op ? <span className="font-semibold text-foreground">this operation</span> : (
                        <button type="button" onClick={() => patchUrl({ model: `verify:${opKey(r.plan[ei].op)}`, mtab: null, vreq: r.id })} className="cursor-pointer underline decoration-border underline-offset-2 hover:text-foreground">{r.plan[ei].op}</button>
                      )} · {viaLabel(r.plan[ei].via)}</span>
                  )}
                </>}
          </div>
        );
      })}
      <div className="px-2 text-muted-foreground">{'}'}</div>
    </div>
  );
}

/** the requests whose gateway plan runs the operation, with or without a document */
export const requestsRunning = (requests: ModelRequest[], op: Id) => requests.filter((r) => r.plan.some((p) => p.op === op));
