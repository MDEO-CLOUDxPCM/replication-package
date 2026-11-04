import { BookOpenText } from 'lucide-react';
import { usePanelAvailable, workspaceActions } from '@/lib/useWorkspace';
import { cn } from '@/lib/utils';

/** a small "open in the Model panel" icon for list rows (shown on row hover, `group` on the row) */
export function ModelJump({ target, title, className, always }: { target: string; title?: string; className?: string; always?: boolean }) {
  const model = usePanelAvailable('model');
  if (!model) return null;
  return (
    <button type="button" aria-label={title ?? 'Open in the Model panel'} title={title ?? 'Open in the Model panel'}
      onClick={(e) => { e.stopPropagation(); workspaceActions.openModel(target); }}
      className={cn('inline-grid size-5 shrink-0 cursor-pointer place-items-center rounded text-muted-foreground outline-none transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50',
        !always && 'opacity-0 group-hover:opacity-100', className)}>
      <BookOpenText className="size-3" />
    </button>
  );
}
