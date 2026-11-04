import type { ReactNode } from 'react';

/** stat tile: label, value (proportional figures), optional hint */
export function Stat({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="rounded-lg border bg-card px-3 py-2.5">
      <div className="flex items-center gap-1 text-xs text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-lg font-semibold leading-tight">{value}</div>
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </div>
  );
}
