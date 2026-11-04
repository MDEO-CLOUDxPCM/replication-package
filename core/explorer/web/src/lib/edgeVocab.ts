/**
 * The words of the architecture graph's edge layers (the mechanisms of the accesses, the copies' feeds, events,
 * references): the packet's vocabulary `edges` (label, `about` the explanation), else the family's defaults
 * (lib/palette.ts MECHANISM_STYLE). The legend, the mechanism badges, the edges' tooltips and the SVG export use them.
 */
import { useMemo } from 'react';
import { useVocab } from './packet';
import { MECHANISM_STYLE } from './palette';

export type EdgeKind = keyof typeof MECHANISM_STYLE;

export interface EdgeVocab {
  label: (k: EdgeKind) => string;
  about: (k: EdgeKind) => string;
}

export const DEFAULT_EDGE_VOCAB: EdgeVocab = { label: (k) => MECHANISM_STYLE[k].label, about: (k) => MECHANISM_STYLE[k].description };

export function useEdgeVocab(): EdgeVocab {
  const v = useVocab();
  return useMemo(() => ({
    label: (k) => v.entry('edges', k)?.label ?? MECHANISM_STYLE[k].label,
    about: (k) => v.entry('edges', k)?.about ?? MECHANISM_STYLE[k].description,
  }), [v]);
}
