import type { Direction } from './types';

/** to minimisation form */
export function minForm(o: number[], dirs: Direction[]): number[] {
  return o.map((v, i) => (dirs[i] === 'maximize' ? -v : v));
}

export function dominates(a: number[], b: number[]): boolean {
  let better = false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] > b[i]) return false;
    if (a[i] < b[i]) better = true;
  }
  return better;
}

/**
 * Non-domination ranks of points in minimisation form (0 = non-dominated). Efficient non-dominated
 * sort (ENS, Zhang et al. 2015) with binary search over the fronts: the points are sorted
 * lexicographically, so no point can dominate one before it; each point goes into the first front
 * none of whose members dominates it. O(N) memory; equal points share a front. Gives the same
 * ranks as the classic fast non-dominated sort.
 */
export function ranks(points: number[][]): number[] {
  const n = points.length;
  const rank = new Array<number>(n).fill(-1);
  if (!n) return rank;
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => {
    const p = points[a], q = points[b];
    for (let k = 0; k < p.length; k++) if (p[k] !== q[k]) return p[k] < q[k] ? -1 : 1;
    return a - b;
  });
  const fronts: number[][] = [];
  const dominatedBy = (front: number[], p: number[]) => {
    // the latest members are the closest in the sort order, the likeliest to dominate
    for (let j = front.length - 1; j >= 0; j--) if (dominates(points[front[j]], p)) return true;
    return false;
  };
  for (const i of order) {
    const p = points[i];
    // "dominated by front k" is monotone in k (a dominator in front k has one in front k-1)
    let lo = 0, hi = fronts.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (dominatedBy(fronts[mid], p)) lo = mid + 1;
      else hi = mid;
    }
    if (lo === fronts.length) fronts.push([]);
    fronts[lo].push(i);
    rank[i] = lo;
  }
  return rank;
}

/** ideal and nadir (minimisation form) of points, the nadir pushed out by `margin` of the range */
export function bounds(points: number[][], m: number, margin = 0.1): { ideal: number[]; nadir: number[] } {
  const ideal = new Array<number>(m).fill(Infinity);
  const hi = new Array<number>(m).fill(-Infinity);
  for (const p of points) for (let k = 0; k < m; k++) {
    if (p[k] < ideal[k]) ideal[k] = p[k];
    if (p[k] > hi[k]) hi[k] = p[k];
  }
  const nadir = hi.map((h, k) => h + margin * (h - ideal[k] || 1));
  return { ideal, nadir };
}

export function nondominated(points: number[][]): number[][] {
  const r = ranks(points);
  return points.filter((_, i) => r[i] === 0);
}

/** Halton sequence value (radical inverse) */
function halton(i: number, base: number): number {
  let f = 1, r = 0;
  while (i > 0) { f /= base; r += f * (i % base); i = Math.floor(i / base); }
  return r;
}
const PRIMES = [2, 3, 5, 7, 11, 13, 17, 19];

/**
 * Hypervolume of points (minimisation form) in the box ideal..nadir, normalised to [0, 1],
 * estimated on `samples` Halton points (deterministic, the same samples for every set).
 */
export function hypervolume(points: number[][], ideal: number[], nadir: number[], samples = 20000): number {
  const m = ideal.length;
  const norm = points
    .map((p) => p.map((v, k) => (v - ideal[k]) / (nadir[k] - ideal[k])))
    .filter((p) => p.every((v) => v < 1));
  if (!norm.length) return 0;
  let hit = 0;
  const s = new Array<number>(m);
  for (let i = 1; i <= samples; i++) {
    for (let k = 0; k < m; k++) s[k] = halton(i, PRIMES[k]);
    for (const p of norm) {
      let dom = true;
      for (let k = 0; k < m; k++) if (p[k] > s[k]) { dom = false; break; }
      if (dom) { hit++; break; }
    }
  }
  return hit / samples;
}
