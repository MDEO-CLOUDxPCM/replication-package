import { Fragment } from 'react';

/** text with `code` spans (the metric docs' and the model texts' only markup) */
export function RichText({ text }: { text: string }) {
  const parts = text.split(/(`[^`]+`)/g);
  return (
    <>
      {parts.map((p, i) => (p.startsWith('`') && p.endsWith('`') && p.length > 1
        ? <code key={i} className="rounded bg-muted px-1 py-px font-mono text-[0.92em]">{p.slice(1, -1)}</code>
        : <Fragment key={i}>{p}</Fragment>))}
    </>
  );
}
