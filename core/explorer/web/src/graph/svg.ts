/** Standalone SVG of a laid-out design graph (export, light theme). */
import type { LayoutResult } from '@layout/types';
import { bounds } from '@layout/pin';
import { MECHANISM_STYLE, edgeColor, type Palette } from '@/lib/palette';
import { DEFAULT_EDGE_VOCAB, type EdgeVocab } from '@/lib/edgeVocab';
import { edgeVisible, edgeWidth, type DesignGraph, type EdgeLayer } from './build';

/** ellipsis to roughly fit a width (system sans, ~0.6 em per character) */
const fit = (s: string, width: number, size: number) => {
  const n = Math.max(3, Math.floor(width / (size * 0.6)));
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export interface SvgOptions {
  title?: string;
  subtitle?: string;
  hidden: Set<EdgeLayer>;
  accent: (service: string) => string | null;
  serviceInfo?: (service: string) => string;
  moved?: Set<string>;
  changedEdges?: Set<string>;
  bundle?: boolean;
  merge?: boolean;
  /** the legend's words (default: the family's) */
  words?: EdgeVocab;
}

export function pathD(pts: { x: number; y: number }[], r = 6, curve = false): string {
  if (pts.length < 2) return '';
  if (curve && pts.length === 4) return `M${pts[0].x},${pts[0].y} C${pts[1].x},${pts[1].y} ${pts[2].x},${pts[2].y} ${pts[3].x},${pts[3].y}`;
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
    const d1 = Math.hypot(p1.x - p0.x, p1.y - p0.y), d2 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    const rr = Math.min(r, d1 / 2, d2 / 2);
    const a = { x: p1.x - ((p1.x - p0.x) / (d1 || 1)) * rr, y: p1.y - ((p1.y - p0.y) / (d1 || 1)) * rr };
    const b = { x: p1.x + ((p2.x - p1.x) / (d2 || 1)) * rr, y: p1.y + ((p2.y - p1.y) / (d2 || 1)) * rr };
    d += ` L${a.x},${a.y} Q${p1.x},${p1.y} ${b.x},${b.y}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${last.x},${last.y}`;
}

export function graphToSvg(g: DesignGraph, L: LayoutResult, p: Palette, o: SvgOptions): string {
  const top = o.title ? 52 : 12;
  const words = o.words ?? DEFAULT_EDGE_VOCAB;
  const legendLayers = (['reference', 'sync', 'copy', 'cache', 'join', 'saga', 'feed', 'event'] as EdgeLayer[]).filter((l) => !o.hidden.has(l) && g.edges.some((e) => e.parts.some((pt) => pt.layer === l)));
  const anyMerged = g.edges.some((e) => e.merged && edgeVisible(e, o.hidden));
  // a pinned layout (compare) may start anywhere: draw the bounding box of what is there
  const bb = bounds(L);
  const W = Math.ceil(bb.width + 24), H = Math.ceil(bb.height + top + 44);
  const out: string[] = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif">`);
  const colors = new Set([...(anyMerged ? [] : legendLayers.map((l) => edgeColor(p, l))), ...(anyMerged ? [p.ink2] : [])]);
  out.push('<defs>');
  for (const c of colors) out.push(`<marker id="arr-${c.slice(1)}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${c}"/></marker>`);
  out.push('</defs>');
  out.push(`<rect width="${W}" height="${H}" fill="${p.surface}"/>`);
  if (o.title) out.push(`<text x="16" y="26" font-size="15" font-weight="600" fill="${p.ink}">${esc(o.title)}</text>`);
  if (o.subtitle) out.push(`<text x="16" y="43" font-size="11" fill="${p.ink2}">${esc(o.subtitle)}</text>`);
  out.push(`<g transform="translate(${12 - bb.x},${top - bb.y})">`);
  // services
  for (const n of g.nodes.values()) {
    const b = L.nodes[n.id];
    if (!b || n.kind === 'class') continue;
    const acc = o.accent(n.service);
    if (n.kind === 'service') {
      out.push(`<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="10" fill="${p.page}" stroke="${p.axis}" stroke-width="1"/>`);
      if (acc) out.push(`<rect x="${b.x}" y="${b.y + 10}" width="3" height="${b.height - 20}" rx="1.5" fill="${acc}"/>`);
      out.push(`<text x="${b.x + 14}" y="${b.y + 22}" font-size="12" font-weight="600" fill="${p.ink}">${esc(fit(n.label, b.width - 24, 12))}</text>`);
      if (o.serviceInfo) out.push(`<text x="${b.x + 14}" y="${b.y + 34}" font-size="9.5" fill="${p.ink2}">${esc(fit(o.serviceInfo(n.service), b.width - 24, 9.5))}</text>`);
    } else {
      out.push(`<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="10" fill="${p.page}" stroke="${p.ink2}" stroke-width="1.2"/>`);
      if (acc) out.push(`<rect x="${b.x}" y="${b.y + 8}" width="3" height="${b.height - 16}" rx="1.5" fill="${acc}"/>`);
      out.push(`<text x="${b.x + 14}" y="${b.y + 24}" font-size="12" font-weight="600" fill="${p.ink}">${esc(fit(n.label, b.width - 24, 12))}</text>`);
      out.push(`<text x="${b.x + 14}" y="${b.y + 41}" font-size="9.5" fill="${p.ink2}">${n.classes?.length ?? 0} classes (collapsed)</text>`);
    }
  }
  // edges
  for (const e of g.edges) {
    if (!edgeVisible(e, o.hidden)) continue;
    const pts = L.edges[e.id]?.points;
    if (!pts?.length) continue;
    const curve = !!L.edges[e.id].curve;
    const c = e.merged ? p.ink2 : edgeColor(p, e.layer);
    const dash = e.merged ? '' : MECHANISM_STYLE[e.layer].dash;
    const base = edgeWidth(e, o.hidden, !!o.bundle);
    const w = o.changedEdges?.has(e.id) ? Math.max(3, base + 1) : base;
    out.push(`<path d="${pathD(pts, 6, curve)}" fill="none" stroke="${c}" stroke-width="${w}"${dash ? ` stroke-dasharray="${dash}"` : ''} marker-end="url(#arr-${c.slice(1)})" opacity="${e.merged ? 0.85 : e.layer === 'reference' ? 0.8 : 0.95}"/>`);
  }
  // classes
  for (const n of g.nodes.values()) {
    if (n.kind !== 'class') continue;
    const b = L.nodes[n.id];
    if (!b) continue;
    const moved = o.moved?.has(n.cls!);
    out.push(`<rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="7" fill="${p.surface}" stroke="${moved ? p.b : p.axis}" stroke-width="${moved ? 2 : 1}"/>`);
    out.push(`<text x="${b.x + 10}" y="${b.y + b.height / 2 + 4}" font-size="11.5" font-weight="${n.aggregateRoot ? 600 : 400}" fill="${p.ink}">${esc(fit(n.label, b.width - 14, 11.5))}</text>`);
  }
  out.push('</g>');
  // legend
  let x = 16;
  const y = H - 18;
  if (anyMerged) {
    out.push(`<line x1="${x}" y1="${y}" x2="${x + 22}" y2="${y}" stroke="${p.ink2}" stroke-width="2"/>`);
    out.push(`<text x="${x + 28}" y="${y + 4}" font-size="11" fill="${p.ink2}">${esc(`dependencies (${legendLayers.map((l) => words.label(l)).join(', ')}), width by rate`)}</text>`);
    x += 60 + legendLayers.join(', ').length * 7;
  }
  for (const l of anyMerged ? [] : legendLayers) {
    const st = MECHANISM_STYLE[l];
    const c = edgeColor(p, l);
    out.push(`<line x1="${x}" y1="${y}" x2="${x + 22}" y2="${y}" stroke="${c}" stroke-width="2"${st.dash ? ` stroke-dasharray="${st.dash}"` : ''}/>`);
    out.push(`<text x="${x + 28}" y="${y + 4}" font-size="11" fill="${p.ink2}">${esc(words.label(l))}</text>`);
    x += 40 + words.label(l).length * 6.4;
  }
  if (o.moved?.size) {
    out.push(`<rect x="${x}" y="${y - 7}" width="18" height="14" rx="3" fill="none" stroke="${p.b}" stroke-width="2"/><text x="${x + 24}" y="${y + 4}" font-size="11" fill="${p.ink2}">moved class</text>`);
  }
  out.push('</svg>');
  return out.join('\n');
}
