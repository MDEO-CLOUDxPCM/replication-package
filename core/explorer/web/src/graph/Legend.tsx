import { MECHANISM_STYLE, PALETTES, edgeColor } from '@/lib/palette';
import { useTheme } from '@/lib/theme';
import { useEdgeVocab } from '@/lib/edgeVocab';
import { cn } from '@/lib/utils';
import { LAYERS, type EdgeLayer } from './build';

/** legend that doubles as layer toggles; colour + dash pattern per layer */
export function GraphLegend({ hidden, counts, onToggle, className }: { hidden: Set<EdgeLayer>; counts: Partial<Record<EdgeLayer, number>>; onToggle: (l: EdgeLayer) => void; className?: string }) {
  const { theme } = useTheme();
  const p = PALETTES[theme];
  const words = useEdgeVocab();
  return (
    <div className={cn('flex flex-wrap items-center gap-1', className)} role="group" aria-label="Edge layers">
      {LAYERS.map((l) => {
        const st = MECHANISM_STYLE[l];
        const off = hidden.has(l);
        const n = counts[l] ?? 0;
        return (
          <button key={l} onClick={() => onToggle(l)} aria-pressed={!off} title={`${words.about(l)} — click to ${off ? 'show' : 'hide'}`}
            className={cn('flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors hover:bg-accent', off ? 'border-dashed text-muted-foreground/60' : 'bg-card', !n && 'opacity-50')}>
            <svg width="20" height="6" aria-hidden><line x1="0" y1="3" x2="20" y2="3" stroke={edgeColor(p, l)} strokeWidth="2" strokeDasharray={st.dash || undefined} opacity={off ? 0.35 : 1} /></svg>
            <span>{words.label(l)}</span>
            <span className="tabular text-muted-foreground">{n}</span>
          </button>
        );
      })}
    </div>
  );
}
