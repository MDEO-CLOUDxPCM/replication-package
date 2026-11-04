/**
 * The code that contributes a part's steps, beside its evidence files in the source pane: for an operation's part the
 * functions on a path from its entry to its accesses, calls, publishes and transactions and the persistence methods of
 * its `via`s (the packet's verify/chains.json, contract/verify.ts VerifyChains), in call order from the entry, and the
 * call sites between them, which the source view makes clickable. Other parts have no entry of their own and show
 * their evidence only.
 */
import type { Chain, Part, VerifyChains } from '@contract/verify';

/** a function (one declaration of it) that contributes steps; from: its caller on the walk from the entry */
export interface Fn { key: string; label: string; path: string; line: number; end: number; pm: boolean; step: boolean; reached: boolean; entry: boolean; depth: number; from?: string }
export interface CallSite { path: string; line: number; col: number; len: number; to: Fn }
export interface Related { fns: Fn[]; calls: CallSite[]; error?: string }

const NONE: Related = { fns: [], calls: [] };

/** `Class.method`; a top-level function by its name; a route or subscription block by its file and line */
export function fnLabel(key: string) {
  const m = /^<lambda@(.*):(\d+)>$/.exec(key);
  return m ? `${m[1].slice(m[1].lastIndexOf('/') + 1)}:${m[2]} { }` : key.replace(/^None\./, '');
}

/** the chain of the operation a part is about (an operation's part) */
export function chainOf(part: Pick<Part, 'kind' | 'key'>, chains: VerifyChains | undefined): Chain | { error: string } | undefined {
  return part.kind === 'op' ? chains?.[part.key.slice(part.key.indexOf(':') + 1)] : undefined;
}

export function relatedCode(part: Pick<Part, 'kind' | 'key'>, chains: VerifyChains | undefined): Related {
  const c = chainOf(part, chains);
  if (!c) return NONE;
  if ('error' in c) return { ...NONE, error: c.error };
  const nodes = new Map(c.nodes.map((n) => [n.key, n]));
  const out = new Map<string, Fn[]>();
  // depth first from the entry, each function's calls in the order of their sites
  const visit = (k: string, depth: number, from?: string) => {
    const n = nodes.get(k);
    if (!n || out.has(k)) return;
    out.set(k, n.decl.map((d) => ({ key: k, label: fnLabel(k), ...d, pm: n.pm, step: n.step, reached: n.reached, entry: k === c.root, depth, from })));
    for (const x of c.calls) if (x.from === k) visit(x.to, depth + 1, k);
  };
  visit(c.root, 0);
  for (const n of c.nodes) visit(n.key, 0); // steps the walk does not reach
  const fns = [...out.values()].flat();
  const calls = c.calls.flatMap((x) => { const to = out.get(x.to)?.[0]; return to ? [{ path: x.path, line: x.line, col: x.col, len: x.len, to }] : []; });
  return { fns, calls };
}

/** a highlighted token: its text and the theme colours as CSS variables (highlight.ts) */
export interface HlTok { content: string; style?: Record<string, string> }
export interface Seg extends HlTok { link?: CallSite }

/** a line's tokens (or the plain line) cut at the call sites in it, each piece with its call site */
export function segments(line: string, toks: HlTok[] | undefined, links: CallSite[]): Seg[] {
  const ts = toks ?? [{ content: line }];
  if (!links.length) return ts;
  const cuts = [...new Set(links.flatMap((l) => [l.col, l.col + l.len]))].sort((a, b) => a - b);
  const out: Seg[] = [];
  let at = 0;
  for (const t of ts) {
    let s = 0;
    for (const c of cuts) {
      if (c <= at + s || c >= at + t.content.length) continue;
      out.push({ ...t, content: t.content.slice(s, c - at) });
      s = c - at;
    }
    out.push({ ...t, content: t.content.slice(s) });
    at += t.content.length;
  }
  let o = 0;
  return out.map((x) => {
    const link = links.find((l) => o >= l.col && o < l.col + l.len);
    o += x.content.length;
    return link ? { ...x, link } : x;
  });
}
