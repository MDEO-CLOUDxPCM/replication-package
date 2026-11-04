import { ArrowLeftRight, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDesign, useRun } from '@/lib/api';
import { useAvailablePanels, useWorkspace } from '@/lib/useWorkspace';
import { useFocusPanel } from '@/lib/store';
import { PANEL_ICON } from '@/lib/panelIcons';
import { PANEL_IDS, PANEL_TITLE, ref as mkRef, type DesignRef } from '@/lib/workspace';
import { cn } from '@/lib/utils';

export function SlotBadge({ slot, className }: { slot: 'a' | 'b'; className?: string }) {
  return <span className={cn('grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-bold text-white', slot === 'a' ? 'bg-select-a' : 'bg-select-b', className)}>{slot.toUpperCase()}</span>;
}

/** a short label of a selected design (its label or the first characters of its id) */
export function useDesignLabel(r: DesignRef | null) {
  const d = useDesign(r?.runId, r?.designId);
  return r ? d.data?.label ?? r.designId.slice(0, 10) : null;
}

function SelChip({ slot, r, run, onClear }: { slot: 'a' | 'b'; r: DesignRef | null; run: string | null; onClear: () => void }) {
  const label = useDesignLabel(r);
  const { data: other } = useRun(r && r.runId !== run ? r.runId : undefined);
  if (!r) return <div className="hidden h-7 items-center rounded-md border border-dashed px-2.5 text-xs text-muted-foreground md:flex">{slot === 'a' ? 'click a design → A' : 'shift-click → B'}</div>;
  return (
    <div className="flex h-7 max-w-[16rem] items-center gap-1.5 rounded-md border bg-card pl-1 pr-0.5 text-xs" title={`${slot.toUpperCase()}: ${mkRef(r.runId, r.designId)}`}>
      <SlotBadge slot={slot} />
      <span className="truncate font-medium">{label}</span>
      {other && <span className="truncate text-muted-foreground">{other.name}</span>}
      <Button variant="ghost" size="icon" className="size-6 shrink-0" onClick={onClear} aria-label={`Clear ${slot.toUpperCase()}`}><X className="size-3" /></Button>
    </div>
  );
}

/** the workspace's controls in the header: which panels are open, designs A and B */
export function WorkspaceToolbar() {
  const ws = useWorkspace();
  const expanded = useFocusPanel((s) => s.expanded);
  const avail = useAvailablePanels();
  return (
    <div className="flex min-w-0 flex-1 items-center gap-3">
      <div className="flex shrink-0 items-center rounded-md border p-0.5 shadow-xs" role="group" aria-label="Panels">
        {PANEL_IDS.filter((p) => avail.includes(p)).map((p) => {
          const Icon = PANEL_ICON[p];
          const open = ws.panels.includes(p), shown = open && expanded.includes(p);
          // closed -> open; open and expanded -> collapse to its rail; a rail -> expand
          const click = () => (!open ? ws.openPanel(p) : ws.collapsePanel(p, shown));
          return (
            <Tooltip key={p}>
              <TooltipTrigger asChild>
                <button onClick={click} aria-pressed={open} aria-label={PANEL_TITLE[p]} data-state={shown ? 'expanded' : open ? 'collapsed' : 'closed'}
                  className={cn('flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 text-xs transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                    shown ? 'bg-accent font-medium text-foreground' : open ? 'bg-accent/45 text-foreground/80 hover:bg-accent' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground')}>
                  <Icon className="size-3.5" /><span className="hidden min-[1280px]:inline">{PANEL_TITLE[p]}</span>
                  {open && !shown && <span className="size-1 rounded-full bg-muted-foreground/70" aria-hidden />}
                </button>
              </TooltipTrigger>
              <TooltipContent>{!open ? `Open ${PANEL_TITLE[p]}` : shown ? `Collapse ${PANEL_TITLE[p]} to a rail` : `Expand ${PANEL_TITLE[p]}`}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      <div className="flex min-w-0 items-center gap-1.5" aria-label="Selected designs">
        <SelChip slot="a" r={ws.a} run={ws.run} onClear={() => ws.clear('a')} />
        {ws.a && ws.b && (
          <Tooltip><TooltipTrigger asChild>
            <Button variant="ghost" size="icon" className="size-7 shrink-0" onClick={ws.swap} aria-label="Swap A and B"><ArrowLeftRight className="size-3.5" /></Button>
          </TooltipTrigger><TooltipContent>Swap A and B</TooltipContent></Tooltip>
        )}
        <SelChip slot="b" r={ws.b} run={ws.run} onClear={() => ws.clear('b')} />
      </div>
    </div>
  );
}
