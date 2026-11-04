import { AlertTriangle, Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex h-full min-h-40 items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
      <Loader2 className="size-4 animate-spin" /> {label}…
    </div>
  );
}

export function Problem({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex h-full min-h-40 items-center justify-center p-8">
      <div className="max-w-md rounded-lg border bg-card p-5 text-sm">
        <div className="mb-1 flex items-center gap-2 font-medium"><AlertTriangle className="size-4 text-[var(--status-serious)]" /> {title}</div>
        <div className="text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="flex min-h-24 items-center justify-center p-6 text-center text-sm text-muted-foreground">{children}</div>;
}
