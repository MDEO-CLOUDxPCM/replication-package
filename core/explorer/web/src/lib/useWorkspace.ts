import { useLayoutEffect, useMemo } from 'react';
import { useLocation, useNavigate, type NavigateFunction } from 'react-router';
import { create } from 'zustand';
import { useCapabilities } from './packet';
import { useFocusPanel } from './store';
import { closePanels, DEFAULT_PANELS, PANEL_IDS, encodeSel, formatPanels, formatRails, parsePanels, parseRails, resolveSel, sameRef, toSearch, type DesignRef, type PanelId } from './workspace';

const PANELS_KEY = 'explorer.panels';
export function storedPanels(): PanelId[] | null {
  try { return parsePanels(localStorage.getItem(PANELS_KEY)); } catch { return null; }
}
export function storePanels(p: string) {
  try { localStorage.setItem(PANELS_KEY, p); } catch { /* private mode */ }
}
const panelsOf = (n: URLSearchParams) => parsePanels(n.get('p')) ?? storedPanels() ?? DEFAULT_PANELS;

/**
 * The query string as a store. Every panel subscribes to the parameters it reads only
 * (`useUrlParams`), so a change of one panel's state (or of A) does not re-render the others;
 * react-router's own hooks would re-render every consumer on every navigation.
 */
const useUrl = create<{ search: string }>(() => ({ search: typeof window === 'undefined' ? '' : window.location.search }));
let navigate: NavigateFunction | null = null;

/** mounted once under the router: mirrors the location into the store, provides navigation */
export function UrlSync() {
  const loc = useLocation();
  navigate = useNavigate();
  useLayoutEffect(() => { useUrl.setState({ search: loc.search }); }, [loc.search]);
  return null;
}

function subset(search: string, keys: readonly string[]): string {
  const sp = new URLSearchParams(search);
  const out = new URLSearchParams();
  for (const [k, v] of sp) if (keys.includes(k)) out.append(k, v);
  return out.toString();
}

/** the URL parameters `keys` (repeated ones included); re-renders only when they change */
export function useUrlParams(keys: readonly string[]): URLSearchParams {
  const s = useUrl((st) => subset(st.search, keys));
  return useMemo(() => new URLSearchParams(s), [s]);
}

export type UrlPatch = Record<string, string | null> | ((n: URLSearchParams) => void);

/** patch the URL's query (replace); reads the current location at call time */
export function patchUrl(patch: UrlPatch) {
  const n = new URLSearchParams(window.location.search);
  if (typeof patch === 'function') patch(n);
  else for (const [k, v] of Object.entries(patch)) (v === null || v === '' ? n.delete(k) : n.set(k, v));
  const search = toSearch(n);
  if (navigate) navigate({ search }, { replace: true });
  else window.history.replaceState(null, '', `${window.location.pathname}${search}`);
}
export const usePatchUrl = () => patchUrl;

const setFocus = (p: PanelId | null) => useFocusPanel.getState().setFocus(p);

/** the panels the packet offers, as the workspace last saw them (null: not known yet, every panel) */
const useOffered = create<{ panels: readonly PanelId[] | null }>(() => ({ panels: null }));
/** the workspace tells the actions and the links which panels the packet offers (Workspace.tsx) */
export function setAvailablePanels(ps: readonly PanelId[] | null) { useOffered.setState({ panels: ps }); }
const offered = (id: PanelId) => { const ps = useOffered.getState().panels; return !ps || ps.includes(id); };

/**
 * The panels the workspace's packet offers: Model with the capability `model`, Performance with `performance`. While
 * the packet loads (or without a packet) every panel.
 */
export function useAvailablePanels(): readonly PanelId[] {
  const caps = useCapabilities();
  return useMemo(() => (caps.loaded ? PANEL_IDS.filter((p) => (p !== 'model' || !!caps.model) && (p !== 'perf' || !!caps.performance)) : PANEL_IDS), [caps]);
}
/**
 * whether the packet offers a panel, as the workspace published it (setAvailablePanels): links into the Model panel
 * show only when it does; a cheap subscription for list rows
 */
export const usePanelAvailable = (id: PanelId) => useOffered((s) => !s.panels || s.panels.includes(id));
/** whether opening a design's performance may simulate it now (capability `simulate`; allowed while the packet loads) */
export function useMaySimulate(): boolean {
  const caps = useCapabilities();
  return !caps.loaded || !!caps.simulate;
}
const setRails = (n: URLSearchParams, rs: PanelId[]) => (rs.length ? n.set('rail', formatRails(rs)) : n.delete('rail'));

/** the workspace's actions: stable functions, no subscription */
export const workspaceActions = {
  patch: patchUrl,
  /** open (and focus, expand) a panel; the others stay as they are */
  openPanel(id: PanelId) {
    if (!offered(id)) return;
    patchUrl((n) => {
      const ps = panelsOf(n);
      if (!ps.includes(id)) n.set('p', formatPanels([...ps, id]));
      setRails(n, parseRails(n.get('rail')).filter((p) => p !== id));
    });
    setFocus(id);
  },
  /** close a panel and every panel to its right (Runs cannot be closed) */
  closePanel(id: PanelId) {
    patchUrl((n) => {
      const ps = closePanels(panelsOf(n), id);
      n.set('p', formatPanels(ps));
      setRails(n, parseRails(n.get('rail')).filter((p) => ps.includes(p)));
    });
  },
  /** collapse a panel to its rail (true) or expand it (false, and focus it) */
  collapsePanel(id: PanelId, on: boolean) {
    patchUrl((n) => {
      const rs = parseRails(n.get('rail')).filter((p) => p !== id);
      setRails(n, on ? [...rs, id] : rs);
    });
    if (!on) setFocus(id);
    else if (useFocusPanel.getState().focus === id) setFocus(null);
  },
  /**
   * open the Model panel at a target (`model=op:<id>`, `class:<id>`, `req:<id>`, `mm:<id>/<Class>`,
   * `param:<Class>`, ...; lib/modelTarget.ts): the panel's tab follows the target
   */
  openModel(target: string) {
    if (!offered('model')) return;
    patchUrl((n) => {
      n.set('model', target);
      n.delete('mtab');
      n.delete('vreq');
      const ps = panelsOf(n);
      if (!ps.includes('model')) n.set('p', formatPanels([...ps, 'model']));
      setRails(n, parseRails(n.get('rail')).filter((p) => p !== 'model'));
    });
    setFocus('model');
  },
  /** pick a design as A or B (B without an A becomes A); opens the architecture panel */
  select(r: DesignRef, slot: 'a' | 'b') {
    patchUrl((n) => {
      const cur = n.get('run');
      const A = resolveSel(n.get('a'), cur), B = resolveSel(n.get('b'), cur);
      if (slot === 'b' && !A) slot = 'a';
      if (slot === 'b' && sameRef(A, r)) return;
      if (slot === 'a') {
        if (sameRef(B, r)) n.delete('b');
        // service ids are per design: the expanded / collapsed services of the old A do not carry over
        if (!sameRef(A, r)) { n.delete('open'); n.delete('collapsed'); }
        n.set('a', encodeSel(r, cur)!);
      } else n.set('b', encodeSel(r, cur)!);
      const ps = panelsOf(n);
      if (!ps.includes('arch')) n.set('p', formatPanels([...ps, 'arch']));
      setRails(n, parseRails(n.get('rail')).filter((p) => p !== 'arch'));
    });
    setFocus('arch');
  },
  /** clear A (B moves up to A) or B */
  clear(slot: 'a' | 'b') {
    patchUrl((n) => {
      if (slot === 'a') {
        const bv = n.get('b');
        if (bv) n.set('a', bv); else n.delete('a');
        n.delete('open'); n.delete('collapsed');
      }
      n.delete('b');
    });
  },
  swap() {
    patchUrl((n) => {
      const av = n.get('a'), bv = n.get('b');
      if (!av || !bv) return;
      n.set('a', bv); n.set('b', av);
      n.delete('open'); n.delete('collapsed');
    });
  },
  /** switch the workspace's run (A and B stay, as references into their run) */
  setRun(id: string) {
    patchUrl((n) => {
      const cur = n.get('run');
      const A = resolveSel(n.get('a'), cur), B = resolveSel(n.get('b'), cur);
      n.set('run', id);
      for (const [k, r] of [['a', A], ['b', B]] as const) { const e = encodeSel(r, id); if (e) n.set(k, e); else n.delete(k); }
    });
  },
};

const WS_KEYS = ['run', 'a', 'b', 'p', 'rail'] as const;
const SEL_KEYS = ['run', 'a', 'b'] as const;

/** run, A and B only */
export function useSelectionState() {
  const sp = useUrlParams(SEL_KEYS);
  const run = sp.get('run'), aRaw = sp.get('a'), bRaw = sp.get('b');
  const a = useMemo(() => resolveSel(aRaw, run), [aRaw, run]);
  const b = useMemo(() => resolveSel(bRaw, run), [bRaw, run]);
  return { run, a, b };
}

/** the workspace state: run, A, B, open and collapsed panels (all in the URL) and its actions */
export function useWorkspace() {
  const sp = useUrlParams(WS_KEYS);
  const run = sp.get('run');
  const aRaw = sp.get('a'), bRaw = sp.get('b'), pRaw = sp.get('p'), railRaw = sp.get('rail');
  const a = useMemo(() => resolveSel(aRaw, run), [aRaw, run]);
  const b = useMemo(() => resolveSel(bRaw, run), [bRaw, run]);
  const panels = useMemo(() => parsePanels(pRaw) ?? storedPanels() ?? DEFAULT_PANELS, [pRaw]);
  const rails = useMemo(() => parseRails(railRaw), [railRaw]);
  return { sp, run, a, b, panels, rails, ...workspaceActions };
}

/** only whether a panel is open (re-renders when that changes) */
export function usePanelOpen(id: PanelId): boolean {
  const p = useUrlParams(['p']).get('p');
  return (parsePanels(p) ?? storedPanels() ?? DEFAULT_PANELS).includes(id);
}
