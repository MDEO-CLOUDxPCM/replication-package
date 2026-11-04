import type { Mechanism } from '@contract/types';
import { MECHANISM_STYLE, PALETTES, edgeColor } from '@/lib/palette';
import { useTheme } from '@/lib/theme';
import { useEdgeVocab } from '@/lib/edgeVocab';

export function MechanismBadge({ m }: { m: Mechanism | 'feed' | 'event' }) {
  const { theme } = useTheme();
  const st = MECHANISM_STYLE[m];
  const words = useEdgeVocab();
  return (
    <span className="inline-flex items-center gap-1 rounded border bg-card px-1.5 py-0.5 text-[10.5px] leading-none text-foreground">
      <svg width="12" height="4" aria-hidden><line x1="0" y1="2" x2="12" y2="2" stroke={edgeColor(PALETTES[theme], m)} strokeWidth="2.5" strokeDasharray={st.dash ? '3 2' : undefined} /></svg>
      {words.label(m)}
    </span>
  );
}
