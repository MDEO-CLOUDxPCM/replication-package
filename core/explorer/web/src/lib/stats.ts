export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** "nice" bins for a histogram */
export function bins(values: number[], n = 24): { x0: number; x1: number; count: number }[] {
  if (!values.length) return [];
  let lo = Math.min(...values), hi = Math.max(...values);
  if (lo === hi) { lo -= 0.5; hi += 0.5; }
  const raw = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const start = Math.floor(lo / step) * step;
  const k = Math.ceil((hi - start) / step) || 1;
  const out = Array.from({ length: k }, (_, i) => ({ x0: start + i * step, x1: start + (i + 1) * step, count: 0 }));
  for (const v of values) out[Math.min(k - 1, Math.floor((v - start) / step))].count++;
  return out;
}
