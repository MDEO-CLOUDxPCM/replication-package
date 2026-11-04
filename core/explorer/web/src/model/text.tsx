import { Fragment, useCallback, type ReactNode } from 'react';
import { renderTemplate, useTexts, type TextVars } from '@/lib/packet';
import { ModelLink } from './shared';

/**
 * The Model panel's texts from the packet (lib/packet.tsx): what is specific to the case (design references, the
 * case's names, files and facts) comes from the packet's texts and docs; the code computes the variables and keeps a
 * generic fallback where a label must not vanish.
 *
 *   t(key, fallback?, vars?)   the packet's text `key` filled with vars, else the fallback (a template too), else ''
 */
export type T = (key: string, fallback?: string, vars?: TextVars) => string;

export function useT(): T {
  const tx = useTexts();
  return useCallback((key: string, fallback?: string, vars?: TextVars) => tx(key, vars) || (fallback ? renderTemplate(fallback, vars) : ''), [tx]);
}

/** fill a doc's template (a missing one is '') */
export const fill = (tpl: string | undefined, vars?: TextVars) => (tpl ? renderTemplate(tpl, vars) : '');

const TOKEN = /(\[`[^`\]]+`\]\([^)\s]+\)|\[[^\]]+\]\([^)\s]+\)|`[^`]+`|\*\*[^*]+\*\*)/g;

/**
 * A packet text with its inline markup (as help/Rich.tsx): `code`, **bold**, [label](model target) — and
 * [`label`](target), a link set in the monospace of identifiers (operations). `strong` and `code` are the classes of
 * bold and code spans ('' for none); `nodes` fills the variables made with nodeVar.
 */
export function MText({ text, strong = 'font-medium', code = 'rounded bg-muted px-1 py-px font-mono text-[0.92em]', nodes }: { text: string; strong?: string; code?: string; nodes?: Record<string, ReactNode> }) {
  if (nodes) return <>{text.split(NODE).map((p, i) => (i % 2 ? <Fragment key={i}>{nodes[p]}</Fragment> : <MText key={i} text={p} strong={strong} code={code} />))}</>;
  return <>{text.split(TOKEN).map((p, i): ReactNode => {
    const mono = /^\[`([^`\]]+)`\]\(([^)\s]+)\)$/.exec(p);
    if (mono) return <ModelLink key={i} target={mono[2]} className="font-mono text-[10.5px]">{mono[1]}</ModelLink>;
    const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(p);
    if (link) return <ModelLink key={i} target={link[2]}>{link[1]}</ModelLink>;
    if (p.length > 1 && p.startsWith('`') && p.endsWith('`')) return <code key={i} className={code || undefined}>{p.slice(1, -1)}</code>;
    if (p.length > 4 && p.startsWith('**') && p.endsWith('**')) return <b key={i} className={strong || undefined}>{p.slice(2, -2)}</b>;
    return <Fragment key={i}>{p}</Fragment>;
  })}</>;
}

const NODE = /\u0000(\w+)\u0000/;
/** a variable whose value is a React node (a list of links as the code builds it): MText's `nodes[name]` takes its place */
export const nodeVar = (name: string) => `\u0000${name}\u0000`;
