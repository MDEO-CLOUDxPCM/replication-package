import { describe, expect, it } from 'vitest';
import { bounds, dominates, ranks } from '../contract/pareto';

/** the previous implementation (Deb's fast non-dominated sort, O(N^2) dominance lists), as reference */
function ranksFnds(points: number[][]): number[] {
  const n = points.length;
  const dominatedBy = new Array<number>(n).fill(0);
  const dominatesList: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (dominates(points[i], points[j])) { dominatesList[i].push(j); dominatedBy[j]++; }
      else if (dominates(points[j], points[i])) { dominatesList[j].push(i); dominatedBy[i]++; }
    }
  }
  const rank = new Array<number>(n).fill(-1);
  let front: number[] = [];
  for (let i = 0; i < n; i++) if (dominatedBy[i] === 0) { rank[i] = 0; front.push(i); }
  let r = 0;
  while (front.length) {
    const next: number[] = [];
    for (const i of front) for (const j of dominatesList[i]) if (--dominatedBy[j] === 0) { rank[j] = r + 1; next.push(j); }
    front = next;
    r++;
  }
  return rank;
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('non-dominated sort', () => {
  it('ENS gives the same ranks as the fast non-dominated sort (ties, duplicates, 1-5 objectives)', () => {
    const r = rng(7);
    for (let trial = 0; trial < 300; trial++) {
      const m = 1 + (trial % 5);
      const n = Math.floor(r() * 300);
      const levels = 2 + Math.floor(r() * 12); // few distinct values: many ties
      const pts: number[][] = [];
      for (let i = 0; i < n; i++) {
        if (pts.length && r() < 0.15) pts.push([...pts[Math.floor(r() * pts.length)]]); // exact duplicate
        else pts.push(Array.from({ length: m }, () => (trial % 3 === 0 ? r() : Math.floor(r() * levels)) - (trial % 7 === 0 ? 0.5 : 0)));
      }
      expect(ranks(pts), `trial ${trial}`).toEqual(ranksFnds(pts));
    }
  });

  it('edge cases', () => {
    expect(ranks([])).toEqual([]);
    expect(ranks([[1, 2]])).toEqual([0]);
    expect(ranks([[1, 1], [1, 1], [2, 2], [2, 2], [0, 3]])).toEqual([0, 0, 1, 1, 0]);
    expect(ranks([[Infinity, 0], [0, Infinity], [Infinity, Infinity]])).toEqual(ranksFnds([[Infinity, 0], [0, Infinity], [Infinity, Infinity]]));
  });

  it('handles 50 000 points', () => {
    const r = rng(3);
    const pts = Array.from({ length: 50_000 }, () => [r(), r(), r(), r()].map((v) => Math.round(v * 1000) / 1000));
    const t0 = performance.now();
    const rk = ranks(pts);
    expect(performance.now() - t0).toBeLessThan(20_000);
    expect(rk.every((x) => x >= 0)).toBe(true);
    // spot check: no point of front 0 is dominated by any point
    const f0 = pts.filter((_, i) => rk[i] === 0).slice(0, 20);
    for (const p of f0) expect(pts.some((q) => dominates(q, p))).toBe(false);
  });

  it('bounds without spreading', () => {
    const pts = Array.from({ length: 200_000 }, (_, i) => [i, -i]);
    const { ideal, nadir } = bounds(pts, 2);
    expect(ideal).toEqual([0, -199_999]);
    expect(nadir[0]).toBeCloseTo(199_999 * 1.1);
    expect(nadir[1]).toBeCloseTo(0.1 * 199_999);
  });
});
