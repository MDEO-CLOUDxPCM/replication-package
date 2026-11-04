import { create } from 'zustand';
import type { PanelId } from './workspace';

/** transient cross-panel state (hover); persistent selection lives in the URL */
interface Hover {
  hovered: string | null;
  setHovered: (id: string | null) => void;
  hoveredOp: string | null;
  setHoveredOp: (id: string | null) => void;
}

export const useHover = create<Hover>((set) => ({
  hovered: null,
  setHovered: (hovered) => set({ hovered }),
  hoveredOp: null,
  setHoveredOp: (hoveredOp) => set({ hoveredOp }),
}));

/** the workspace's run and designs A/B ("run~id" refs), mirrored from the URL (useWorkspace) */
interface Selection {
  run: string | null;
  a: string | null;
  b: string | null;
  set: (s: Partial<Pick<Selection, 'run' | 'a' | 'b'>>) => void;
}

export const useSelection = create<Selection>((set) => ({
  run: null, a: null, b: null,
  set: (s) => set(s),
}));

/**
 * focus: the panel last opened or expanded (it stays expanded when the others collapse to rails);
 * expanded: the open panels the strip shows expanded at its width (the others are rails)
 */
export const useFocusPanel = create<{ focus: PanelId | null; setFocus: (p: PanelId | null) => void; expanded: PanelId[]; setExpanded: (e: PanelId[]) => void }>((set) => ({
  focus: null,
  setFocus: (focus) => set({ focus }),
  expanded: [],
  setExpanded: (expanded) => set({ expanded }),
}));
