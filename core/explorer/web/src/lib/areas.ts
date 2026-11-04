/**
 * Marked areas of the designs chart: rectangles in data coordinates over two axes,
 * kept in the URL as `area=<x key>,<y key>,<x0>,<x1>,<y0>,<y1>` (repeated). A design is marked
 * when it lies in any area.
 */
export interface Area { x: string; y: string; x0: number; x1: number; y0: number; y1: number }

const num = (v: number) => String(Number(v.toPrecision(6)));

export function formatArea(a: Area): string {
  return [a.x, a.y, num(a.x0), num(a.x1), num(a.y0), num(a.y1)].join(',');
}

export function parseArea(s: string): Area | null {
  const p = s.split(',');
  if (p.length !== 6) return null;
  const [x0, x1, y0, y1] = p.slice(2).map(Number);
  if (![x0, x1, y0, y1].every(Number.isFinite) || !p[0] || !p[1]) return null;
  return { x: p[0], y: p[1], x0: Math.min(x0, x1), x1: Math.max(x0, x1), y0: Math.min(y0, y1), y1: Math.max(y0, y1) };
}

export const parseAreas = (vals: string[]) => vals.map(parseArea).filter((a): a is Area => !!a);

/** the ids of the items inside any area whose axes are known (`get(key)` gives an axis' value getter) */
export function markedBy<T extends { id: string }>(items: readonly T[], areas: readonly Area[], get: (key: string) => ((d: T) => number) | undefined): Set<string> {
  const usable = areas.map((a) => ({ a, gx: get(a.x), gy: get(a.y) })).filter((u) => u.gx && u.gy);
  const out = new Set<string>();
  for (const d of items) {
    for (const { a, gx, gy } of usable) {
      const x = gx!(d), y = gy!(d);
      if (x >= a.x0 && x <= a.x1 && y >= a.y0 && y <= a.y1) { out.add(d.id); break; }
    }
  }
  return out;
}
