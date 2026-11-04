import type { MetricDef, ObjectiveDef } from '@contract/types';

// Intl.NumberFormat per digit count: toLocaleString with options builds a formatter per call
// (the table and the tooltips format thousands of numbers)
const nfs = new Map<number, Intl.NumberFormat>();
const nf = (d: number) => { let f = nfs.get(d); if (!f) nfs.set(d, f = new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })); return f; };
const compactNf = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export function fmt(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '–';
  const a = Math.abs(v);
  if (a >= 100000) return compact(v);
  return nf(digits).format(v);
}

export function compact(v: number): string {
  return compactNf.format(v);
}

export function fmtDef(v: number | null | undefined, d: ObjectiveDef | MetricDef): string {
  return fmt(v, d.digits ?? 2);
}

export function fmtMs(v: number | null | undefined): string {
  if (v === null || v === undefined) return '–';
  if (v >= 1000) return `${fmt(v / 1000, 2)} s`;
  return `${fmt(v, v < 10 ? 2 : 1)} ms`;
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined) return '–';
  return `${fmt(v * 100, digits)} %`;
}

export function fmtDuration(ms?: number): string {
  if (!ms) return '–';
  const s = Math.round(ms / 1000);
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} min`;
  return `${fmt(m / 60, 1)} h`;
}

export function fmtDate(iso?: string): string {
  if (!iso) return '–';
  return new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** signed relative delta b vs a, e.g. "+12.3 %" */
export function fmtDelta(a: number, b: number): string {
  if (!a) return b ? '+∞' : '0';
  const d = (b - a) / Math.abs(a);
  return `${d >= 0 ? '+' : '−'}${fmt(Math.abs(d) * 100, 1)} %`;
}

export const unitSuffix = (u?: string) => (u ? ` ${u}` : '');

/** a readable name from an id like "area.Class.field" (the part after the first dot) */
export function slugless(id: string): string {
  const i = id.indexOf('.');
  return i > 0 ? id.slice(i + 1) : id;
}
