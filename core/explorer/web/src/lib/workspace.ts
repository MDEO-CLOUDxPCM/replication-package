/**
 * The workspace: one page, panels side by side (runs, designs, architecture,
 * performance: a drill-down from left to right; then the input model, a reference beside them).
 * Pure helpers: panel lists, which panels fit, selection references.
 */

export type PanelId = 'runs' | 'designs' | 'arch' | 'perf' | 'model';
export const PANEL_IDS: PanelId[] = ['runs', 'designs', 'arch', 'perf', 'model'];
export const PANEL_TITLE: Record<PanelId, string> = { runs: 'Runs', designs: 'Designs', arch: 'Architecture', perf: 'Performance', model: 'Model' };
/** below its minimum width a panel collapses to a rail */
export const PANEL_MIN: Record<PanelId, number> = { runs: 280, designs: 460, arch: 500, perf: 480, model: 560 };
/** initial width shares */
export const PANEL_WEIGHT: Record<PanelId, number> = { runs: 0.7, designs: 1.2, arch: 1.5, perf: 1.3, model: 1.5 };
/** panels outside the drill-down: closing a panel to their left leaves them open */
export const REFERENCE_PANELS: readonly PanelId[] = ['model'];
export const RAIL_WIDTH = 40;
export const HANDLE_WIDTH = 7;
export const DEFAULT_PANELS: PanelId[] = ['runs', 'designs', 'arch'];

/**
 * `p=designs,arch`: the open panels besides Runs, which is always open (the leftmost panel cannot be
 * closed, only collapsed). Any order, unknown ids ignored; null when absent.
 */
export function parsePanels(s: string | null | undefined): PanelId[] | null {
  if (s === null || s === undefined) return null;
  const set = new Set(['runs', ...s.split(',')]);
  return PANEL_IDS.filter((p) => set.has(p));
}
export const formatPanels = (ps: readonly string[]) => PANEL_IDS.filter((p) => p !== 'runs' && ps.includes(p)).join(',') || 'runs';
/**
 * panels are a drill-down from left to right: closing one closes every panel to its right (Runs
 * stays); the Model panel is a reference beside them and closes only by itself
 */
export function closePanels(open: readonly PanelId[], id: PanelId): PanelId[] {
  if (id === 'runs') return [...open];
  if (REFERENCE_PANELS.includes(id)) return open.filter((p) => p !== id);
  const i = PANEL_IDS.indexOf(id);
  return open.filter((p) => PANEL_IDS.indexOf(p) < i || REFERENCE_PANELS.includes(p));
}
/** list of rails (`rail=`): no implicit Runs */
export function parseRails(s: string | null | undefined): PanelId[] {
  const set = new Set((s ?? '').split(','));
  return PANEL_IDS.filter((p) => set.has(p));
}
export const formatRails = (ps: readonly string[]) => PANEL_IDS.filter((p) => ps.includes(p)).join(',');

/**
 * Which of the open panels are expanded at this width; the others are rails. Panels the user
 * collapsed stay rails; then, while the minimum widths do not fit, the leftmost expanded panel
 * that is not the focus collapses. The focus (the panel last opened or expanded; default the
 * rightmost) always stays expanded.
 */
export function fitPanels(open: readonly PanelId[], width: number, focus: PanelId | null, userCollapsed: readonly PanelId[] = [], mins: Record<PanelId, number> = PANEL_MIN): PanelId[] {
  const f = focus && open.includes(focus) ? focus : null;
  const expanded = open.filter((p) => p === f || !userCollapsed.includes(p));
  const keep = f ?? expanded[expanded.length - 1];
  const need = () => expanded.reduce((s, p) => s + mins[p], 0) + (open.length - expanded.length) * RAIL_WIDTH + Math.max(0, expanded.length - 1) * HANDLE_WIDTH;
  while (expanded.length > 1 && need() > width) expanded.splice(expanded.findIndex((p) => p !== keep), 1);
  return expanded;
}

export interface DesignRef { runId: string; designId: string }

/** "run~design" references (a design in another run than the workspace's) */
export const ref = (runId: string, designId: string) => `${runId}~${designId}`;
export function parseRef(s?: string | null): DesignRef | null {
  if (!s) return null;
  const i = s.lastIndexOf('~');
  return i > 0 ? { runId: s.slice(0, i), designId: s.slice(i + 1) } : null;
}
/** `a=<id>` is a design of the workspace's run, `a=<run>~<id>` one of another run */
export function resolveSel(v: string | null | undefined, run: string | null | undefined): DesignRef | null {
  if (!v) return null;
  return parseRef(v) ?? (run ? { runId: run, designId: v } : null);
}
export function encodeSel(r: DesignRef | null, run: string | null | undefined): string | null {
  if (!r) return null;
  return r.runId === run ? r.designId : ref(r.runId, r.designId);
}
export const sameRef = (x: DesignRef | null, y: DesignRef | null) => !!x && !!y && x.runId === y.runId && x.designId === y.designId;

/** a query string with readable `,` `~` `:` (URLSearchParams would escape them) */
export function toSearch(sp: URLSearchParams): string {
  const parts: string[] = [];
  for (const [k, v] of sp) parts.push(`${enc(k)}=${enc(v)}`);
  return parts.length ? `?${parts.join('&')}` : '';
}
const enc = (s: string) => encodeURIComponent(s).replace(/%2C/gi, ',').replace(/%3A/gi, ':');

/** the run the workspace opens without one: the newest real run (runs come newest first) */
export function defaultRun(runs: { id: string; domainId: string; tags?: string[]; source: { synthetic?: boolean } }[]): string | null {
  const real = runs.filter((r) => !r.source.synthetic && !r.tags?.includes('synthetic'));
  return (real.find((r) => !r.tags?.includes('earlier-model')) ?? real[0] ?? runs[0])?.id ?? null;
}
