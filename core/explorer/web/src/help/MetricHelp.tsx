import { lazy, Suspense, useState } from 'react';
import { CircleHelp } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useMetricDoc } from '@/lib/metricDocs';
import { cn } from '@/lib/utils';

const load = () => import('./MetricHelpContent');
const Content = lazy(load);
let prefetched = false;
/** the content chunk (KaTeX) loads when the pointer first reaches a `?`, so the first open is quick */
const prefetch = () => { if (!prefetched) { prefetched = true; void load(); } };

/**
 * The `?` next to an objective, constraint or metric: a popover that explains how the value is
 * computed (the packet's doc `metrics`, lib/metricDocs.ts); nothing when the packet has no doc for the key. The
 * content (with KaTeX) loads on first open.
 */
export function MetricHelp({ k, className, side = 'bottom' }: { k: string; className?: string; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  const [open, setOpen] = useState(false);
  const doc = useMetricDoc(k);
  if (!doc) return null;
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button type="button" aria-label={`How ${doc.title} is computed`} title={`How ${doc.title} is computed`}
          onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()} onPointerEnter={prefetch} onFocus={prefetch}
          className={cn('inline-grid size-4 shrink-0 cursor-pointer place-items-center rounded-full text-muted-foreground/80 outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50', className)}>
          <CircleHelp className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent side={side} align="start" collisionPadding={12} className="w-[min(34rem,calc(100vw-2rem))] p-0" onClick={(e) => e.stopPropagation()}>
        {open && (
          <Suspense fallback={<div className="p-4 text-xs text-muted-foreground">Loading…</div>}>
            <Content doc={doc} onNavigate={() => setOpen(false)} />
          </Suspense>
        )}
      </PopoverContent>
    </Popover>
  );
}
