import { Fragment, type ReactNode } from 'react';
import { workspaceActions } from '@/lib/useWorkspace';
import { cn } from '@/lib/utils';

/**
 * A packet's text with its inline markup (lib/packet.tsx): `code`, **bold**, [label](target) — a link to a place in
 * the Model panel (`model=` targets, lib/modelTarget.ts). `strong` is the class of bold spans (default font-medium),
 * `code` of code spans (default the metric docs' style).
 */
export function Rich({ text, strong = 'font-medium', code = 'rounded bg-muted px-1 py-px font-mono text-[0.92em]' }: { text: string; strong?: string; code?: string }) {
  return <>{parse(text, strong, code)}</>;
}

const TOKEN = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/g;

function parse(text: string, strong: string, code: string): ReactNode[] {
  return text.split(TOKEN).map((p, i) => {
    if (p.length > 1 && p.startsWith('`') && p.endsWith('`')) return <code key={i} className={code || undefined}>{p.slice(1, -1)}</code>;
    if (p.length > 4 && p.startsWith('**') && p.endsWith('**')) return <b key={i} className={strong || undefined}>{p.slice(2, -2)}</b>;
    const m = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(p);
    if (m) return <RichLink key={i} target={m[2]}>{m[1]}</RichLink>;
    return <Fragment key={i}>{p}</Fragment>;
  });
}

/** as model/shared.tsx ModelLink */
function RichLink({ target, children }: { target: string; children: ReactNode }) {
  return (
    <button type="button" onClick={(e) => { e.stopPropagation(); workspaceActions.openModel(target); }}
      className={cn('cursor-pointer rounded-sm text-left underline decoration-border decoration-1 underline-offset-2 transition-colors hover:text-foreground hover:decoration-foreground/60')}>
      {children}
    </button>
  );
}
