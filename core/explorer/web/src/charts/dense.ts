/**
 * Dense layers: the many-points part of the explorer's charts (designs in the scatter, the matrix
 * and the parallel coordinates), drawn on a canvas under the ECharts canvas instead of as ECharts
 * items. ECharts keeps the axes, the brush, the few overlay points (A/B, references) and the SVG
 * export; this module draws, hit-tests and exports the dense part:
 *  - points: per layer a sprite blitted per point (overlaps accumulate), points falling on the same
 *    pixel drawn once; hover and click through a pixel grid index;
 *  - lines (parallel coordinates): drawn one by one while a layer is small, decimated beyond
 *    `LINE_LIMIT`: per pair of neighbouring axes the segments are binned (bin of the left value x
 *    bin of the right value) and drawn once per occupied bin pair, the opacity by log count;
 *    hover by interpolating every line at the pointer;
 *  - export: the same picture as SVG paths (ECharts `graphic` elements) in the light theme.
 */

export interface PointLayer {
  kind: 'points';
  grid: number;
  x: Float64Array;
  y: Float64Array;
  /** index into DenseSpec.keys per point */
  idx: Int32Array;
  fill: string | null;
  stroke?: string | null;
  alpha: number;
  r: number;
  /** false: drawn but not hoverable */
  hit?: boolean;
}

export interface LineLayer {
  kind: 'lines';
  /** n * dims values, row-major */
  v: Float64Array;
  idx: Int32Array;
  color: string;
  alpha: number;
  width: number;
  hit?: boolean;
}

export type Layer = PointLayer | LineLayer;

export interface DenseSpec {
  keys: string[];
  layers: Layer[];
  /** parallel coordinates: number of axes */
  dims?: number;
  /** hover marker colour */
  ink: string;
  surface: string;
  /** where to mark key i on hover (xy charts: every grid it appears in; parallel: its values) */
  locate: (i: number) => { grid: number; x: number; y: number }[] | number[] | null;
}

export const LINE_LIMIT = 2500;

// ---------------------------------------------------------------------------------------------
// projection from the ECharts instance (value axes are linear: two points per axis suffice)

export interface XYMap { ax: number; bx: number; ay: number; by: number; rect: { x: number; y: number; width: number; height: number } }
export interface ParMap { x: number[]; ay: number[]; by: number[]; top: number; bottom: number }
export type Projection = { kind: 'xy'; grids: (XYMap | null)[] } | { kind: 'par'; map: ParMap | null };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyChart = any;

export function project(chart: AnyChart, spec: DenseSpec): Projection {
  if (spec.dims) {
    const coord = chart.getModel?.()?.getComponent?.('parallel', 0)?.coordinateSystem;
    if (!coord) return { kind: 'par', map: null };
    const x: number[] = [], ay: number[] = [], by: number[] = [];
    let top = Infinity, bottom = -Infinity;
    for (let d = 0; d < spec.dims; d++) {
      const p0 = coord.dataToPoint(0, `dim${d}`), p1 = coord.dataToPoint(1, `dim${d}`);
      x.push(p0[0]); ay.push(p0[1]); by.push(p1[1] - p0[1]);
    }
    const r = coord.getRect?.();
    if (r) { top = r.y; bottom = r.y + r.height; }
    return { kind: 'par', map: { x, ay, by, top, bottom } };
  }
  const grids: (XYMap | null)[] = [];
  const n = Math.max(0, ...spec.layers.map((l) => (l.kind === 'points' ? l.grid : 0))) + 1;
  for (let g = 0; g < n; g++) {
    try {
      const p0 = chart.convertToPixel({ gridIndex: g }, [0, 0]), p1 = chart.convertToPixel({ gridIndex: g }, [1, 1]);
      const rect = chart.getModel().getComponent('grid', g).coordinateSystem.getRect();
      grids.push(p0 && p1 ? { ax: p0[0], bx: p1[0] - p0[0], ay: p0[1], by: p1[1] - p0[1], rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } } : null);
    } catch { grids.push(null); }
  }
  return { kind: 'xy', grids };
}

export const projectionKey = (p: Projection) => JSON.stringify(p);

// ---------------------------------------------------------------------------------------------
// drawing

const sprites = new Map<string, HTMLCanvasElement>();
function sprite(fill: string | null, stroke: string | null | undefined, r: number, dpr: number): HTMLCanvasElement {
  const k = `${fill}|${stroke}|${r}|${dpr}`;
  let c = sprites.get(k);
  if (c) return c;
  c = document.createElement('canvas');
  const s = Math.ceil((r + 1.5) * 2 * dpr);
  c.width = c.height = s;
  const g = c.getContext('2d')!;
  g.scale(dpr, dpr);
  g.beginPath();
  g.arc(s / dpr / 2, s / dpr / 2, r, 0, Math.PI * 2);
  if (fill) { g.fillStyle = fill; g.fill(); }
  if (stroke) { g.strokeStyle = stroke; g.lineWidth = 1; g.stroke(); }
  sprites.set(k, c);
  return c;
}

/** a sprite's non-transparent device pixels, premultiplied with the layer's alpha, for stamping */
interface Stamp { size: number; dx: Int16Array; dy: Int16Array; pr: Float32Array; pg: Float32Array; pb: Float32Array; pa: Float32Array }
const stamps = new Map<string, Stamp>();
function stamp(fill: string | null, stroke: string | null | undefined, r: number, dpr: number, alpha: number): Stamp {
  const k = `${fill}|${stroke}|${r}|${dpr}|${alpha}`;
  let st = stamps.get(k);
  if (st) return st;
  const c = sprite(fill, stroke, r, dpr);
  const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
  const px: number[][] = [];
  for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
    const o = (y * c.width + x) * 4, a = (d[o + 3] / 255) * alpha;
    if (a > 0.002) px.push([x, y, (d[o] / 255) * a, (d[o + 1] / 255) * a, (d[o + 2] / 255) * a, a]);
  }
  st = {
    size: c.width, dx: Int16Array.from(px, (p) => p[0]), dy: Int16Array.from(px, (p) => p[1]),
    pr: Float32Array.from(px, (p) => p[2]), pg: Float32Array.from(px, (p) => p[3]), pb: Float32Array.from(px, (p) => p[4]), pa: Float32Array.from(px, (p) => p[5]),
  };
  stamps.set(k, st);
  return st;
}

/** the accumulation buffer, reused between draws (a fresh 4 × w × h float buffer per draw is garbage) */
let accBuf = new Float32Array(0);
function accBuffer(n: number): Float32Array {
  if (accBuf.length < n) accBuf = new Float32Array(n);
  const b = accBuf.subarray(0, n);
  b.fill(0);
  return b;
}

/** pixel positions of every hoverable point / line, for hit tests */
export interface HitIndex {
  kind: 'xy' | 'par';
  // xy: points in a uniform grid (CSR)
  px?: Float32Array; py?: Float32Array; key?: Int32Array; cellStart?: Int32Array; cellItems?: Int32Array; cols?: number; rows?: number; cell?: number;
  // par: per line its pixel y on every axis
  ly?: Float32Array; lkey?: Int32Array; ax?: number[]; dims?: number;
}

const CELL = 10;

function buildXYIndex(pts: { x: number[]; y: number[]; k: number[] }, w: number, h: number): HitIndex {
  const n = pts.x.length;
  const cols = Math.ceil(w / CELL) + 1, rows = Math.ceil(h / CELL) + 1;
  const counts = new Int32Array(cols * rows + 1);
  const cellOf = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const c = Math.min(cols - 1, Math.max(0, Math.floor(pts.x[i] / CELL))) + Math.min(rows - 1, Math.max(0, Math.floor(pts.y[i] / CELL))) * cols;
    cellOf[i] = c;
    counts[c + 1]++;
  }
  for (let c = 0; c < cols * rows; c++) counts[c + 1] += counts[c];
  const fillPos = counts.slice(0, cols * rows);
  const items = new Int32Array(n);
  for (let i = 0; i < n; i++) items[fillPos[cellOf[i]]++] = i;
  return { kind: 'xy', px: Float32Array.from(pts.x), py: Float32Array.from(pts.y), key: Int32Array.from(pts.k), cellStart: counts, cellItems: items, cols, rows, cell: CELL };
}

export function hitTest(ix: HitIndex | null, mx: number, my: number, radius = 7): number | null {
  if (!ix) return null;
  if (ix.kind === 'xy') {
    const { px, py, key, cellStart, cellItems, cols, rows } = ix as Required<HitIndex>;
    const cx = Math.floor(mx / CELL), cy = Math.floor(my / CELL);
    let best = -1, bd = radius * radius;
    for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) {
      if (x < 0 || y < 0 || x >= cols || y >= rows) continue;
      const c = x + y * cols;
      for (let j = cellStart[c]; j < cellStart[c + 1]; j++) {
        const i = cellItems[j];
        const d = (px[i] - mx) ** 2 + (py[i] - my) ** 2;
        if (d <= bd) { bd = d; best = key[i]; }
      }
    }
    return best >= 0 ? best : null;
  }
  const { ly, lkey, ax, dims } = ix as Required<HitIndex>;
  let seg = -1;
  for (let d = 0; d < dims - 1; d++) if (mx >= ax[d] && mx <= ax[d + 1]) { seg = d; break; }
  if (seg < 0) return null;
  const t = (mx - ax[seg]) / (ax[seg + 1] - ax[seg] || 1);
  let best = -1, bd = 4;
  for (let i = 0, n = lkey.length; i < n; i++) {
    const y = ly[i * dims + seg] * (1 - t) + ly[i * dims + seg + 1] * t;
    const d = Math.abs(y - my);
    if (d < bd) { bd = d; best = lkey[i]; }
  }
  return best >= 0 ? best : null;
}

/** segments of a decimated line layer: per alpha level a flat list x0,y0,x1,y1,... */
export function binLines(v: Float64Array, dims: number, m: ParMap, levels = 6): { alpha: number; segs: number[] }[] {
  const n = v.length / dims;
  const out: { alpha: number; segs: number[] }[] = Array.from({ length: levels }, (_, k) => ({ alpha: (k + 1) / levels, segs: [] }));
  const span = Math.max(1, m.bottom - m.top);
  const B = Math.max(16, Math.min(160, Math.round(span / 2.5)));
  const binOf = (py: number) => Math.min(B - 1, Math.max(0, Math.floor(((py - m.top) / span) * B)));
  const centre = (b: number) => m.top + ((b + 0.5) / B) * span;
  const counts = new Uint32Array(B * B);
  for (let d = 0; d < dims - 1; d++) {
    counts.fill(0);
    let max = 0;
    for (let i = 0; i < n; i++) {
      const a = v[i * dims + d], b = v[i * dims + d + 1];
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const k = binOf(m.ay[d] + m.by[d] * a) * B + binOf(m.ay[d + 1] + m.by[d + 1] * b);
      const c = ++counts[k];
      if (c > max) max = c;
    }
    const lmax = Math.log1p(max);
    for (let k = 0; k < B * B; k++) {
      const c = counts[k];
      if (!c) continue;
      const lvl = Math.min(levels - 1, Math.floor((Math.log1p(c) / lmax) * levels - 1e-9));
      out[Math.max(0, lvl)].segs.push(m.x[d], centre(Math.floor(k / B)), m.x[d + 1], centre(k % B));
    }
  }
  return out;
}

export interface DrawResult { index: HitIndex | null; ms: number; drawn: number }

export function drawDense(canvas: HTMLCanvasElement, spec: DenseSpec, proj: Projection, w: number, h: number, dpr: number): DrawResult {
  const t0 = performance.now();
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
  const g = canvas.getContext('2d')!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  let drawn = 0;
  if (proj.kind === 'xy') {
    // points are stamped into a premultiplied RGBA buffer (source-over per sprite pixel) and put once: a drawImage per
    // point cost ~1.5 µs each, 90 ms for 60 000 designs on every filter or colour change
    const hit = { x: [] as number[], y: [] as number[], k: [] as number[] };
    const seen = new Uint8Array(Math.ceil(w) * Math.ceil(h) + 1);
    const W = Math.ceil(w);
    const PW = canvas.width, PH = canvas.height;
    const acc = accBuffer(PW * PH * 4);
    let any = false;
    for (const l of spec.layers) {
      if (l.kind !== 'points') continue;
      const m = proj.grids[l.grid];
      if (!m) continue;
      seen.fill(0);
      const st = stamp(l.fill, l.stroke, l.r, dpr, l.alpha);
      const half = st.size / dpr / 2;
      // clip: the grid's rect plus a point radius (device pixels)
      const cx0 = Math.max(0, Math.floor((m.rect.x - l.r - 1) * dpr)), cy0 = Math.max(0, Math.floor((m.rect.y - l.r - 1) * dpr));
      const cx1 = Math.min(PW, Math.ceil((m.rect.x + m.rect.width + l.r + 1) * dpr)), cy1 = Math.min(PH, Math.ceil((m.rect.y + m.rect.height + l.r + 1) * dpr));
      const { dx, dy, pr, pg, pb, pa } = st;
      const np = dx.length;
      for (let i = 0, n = l.x.length; i < n; i++) {
        const xv = l.x[i], yv = l.y[i];
        if (!Number.isFinite(xv) || !Number.isFinite(yv)) continue;
        const px = m.ax + m.bx * xv, py = m.ay + m.by * yv;
        if (l.hit !== false) { hit.x.push(px); hit.y.push(py); hit.k.push(l.idx[i]); }
        const cx = Math.round(px), cy = Math.round(py);
        if (cx >= 0 && cy >= 0 && cx < W && cy < h) {
          const s = cx + cy * W;
          if (seen[s]) continue;
          seen[s] = 1;
        }
        const ox = Math.round((px - half) * dpr), oy = Math.round((py - half) * dpr);
        for (let k = 0; k < np; k++) {
          const x = ox + dx[k], y = oy + dy[k];
          if (x < cx0 || y < cy0 || x >= cx1 || y >= cy1) continue;
          const o = (y * PW + x) * 4, inv = 1 - pa[k];
          acc[o] = pr[k] + acc[o] * inv;
          acc[o + 1] = pg[k] + acc[o + 1] * inv;
          acc[o + 2] = pb[k] + acc[o + 2] * inv;
          acc[o + 3] = pa[k] + acc[o + 3] * inv;
        }
        any = true;
        drawn++;
      }
    }
    if (any) {
      const img = g.createImageData(PW, PH);
      const out = img.data;
      for (let o = 0, n = PW * PH * 4; o < n; o += 4) {
        const a = acc[o + 3];
        if (a <= 0) continue;
        out[o] = (acc[o] / a) * 255; out[o + 1] = (acc[o + 1] / a) * 255; out[o + 2] = (acc[o + 2] / a) * 255; out[o + 3] = a * 255;
      }
      g.putImageData(img, 0, 0);
    }
    return { index: buildXYIndex(hit, w, h), ms: performance.now() - t0, drawn };
  }
  const m = proj.map;
  const dims = spec.dims!;
  if (!m) return { index: null, ms: 0, drawn };
  const ly: number[] = [], lk: number[] = [];
  for (const l of spec.layers) {
    if (l.kind !== 'lines') continue;
    const n = l.v.length / dims;
    if (l.hit !== false) for (let i = 0; i < n; i++) {
      for (let d = 0; d < dims; d++) ly.push(m.ay[d] + m.by[d] * l.v[i * dims + d]);
      lk.push(l.idx[i]);
    }
    g.lineWidth = l.width;
    g.strokeStyle = l.color;
    g.lineJoin = 'round';
    if (n <= LINE_LIMIT) {
      g.globalAlpha = l.alpha;
      g.beginPath();
      for (let i = 0; i < n; i++) {
        for (let d = 0; d < dims; d++) {
          const y = m.ay[d] + m.by[d] * l.v[i * dims + d];
          if (d === 0) g.moveTo(m.x[d], y); else g.lineTo(m.x[d], y);
        }
      }
      g.stroke();
      drawn += n;
    } else {
      for (const lvl of binLines(l.v, dims, m)) {
        if (!lvl.segs.length) continue;
        g.globalAlpha = Math.max(0.03, l.alpha * lvl.alpha);
        g.beginPath();
        for (let k = 0; k < lvl.segs.length; k += 4) { g.moveTo(lvl.segs[k], lvl.segs[k + 1]); g.lineTo(lvl.segs[k + 2], lvl.segs[k + 3]); }
        g.stroke();
        drawn += lvl.segs.length / 4;
      }
    }
  }
  g.globalAlpha = 1;
  return { index: { kind: 'par', ly: Float32Array.from(ly), lkey: Int32Array.from(lk), ax: m.x, dims }, ms: performance.now() - t0, drawn };
}

/** hover marker on the top canvas */
export function drawHighlight(canvas: HTMLCanvasElement, spec: DenseSpec | null, proj: Projection | null, key: number | null, w: number, h: number, dpr: number) {
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
  }
  const g = canvas.getContext('2d')!;
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.clearRect(0, 0, canvas.width, canvas.height);
  if (!spec || !proj || key === null) return;
  const at = spec.locate(key);
  if (!at) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.strokeStyle = spec.ink;
  if (proj.kind === 'xy') {
    for (const p of at as { grid: number; x: number; y: number }[]) {
      const m = proj.grids[p.grid];
      if (!m || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
      const px = m.ax + m.bx * p.x, py = m.ay + m.by * p.y;
      g.lineWidth = 3.5;
      g.strokeStyle = spec.surface;
      g.beginPath(); g.arc(px, py, 7, 0, Math.PI * 2); g.stroke();
      g.lineWidth = 2;
      g.strokeStyle = spec.ink;
      g.beginPath(); g.arc(px, py, 7, 0, Math.PI * 2); g.stroke();
    }
  } else if (proj.map) {
    const v = at as number[];
    const m = proj.map;
    for (const [lw, col] of [[4, spec.surface], [2, spec.ink]] as [number, string][]) {
      g.lineWidth = lw;
      g.strokeStyle = col;
      g.beginPath();
      v.forEach((val, d) => { const y = m.ay[d] + m.by[d] * val; if (d === 0) g.moveTo(m.x[d], y); else g.lineTo(m.x[d], y); });
      g.stroke();
    }
  }
}

// ---------------------------------------------------------------------------------------------
// SVG export: the dense layers as SVG paths, put under the export's own chart drawing

const f1 = (v: number) => Math.round(v * 10) / 10;
const path = (d: string, attrs: string) => `<path d="${d}" ${attrs}/>`;

export function denseSvg(spec: DenseSpec, proj: Projection): string {
  const out: string[] = [];
  if (proj.kind === 'xy') {
    for (const l of spec.layers) {
      if (l.kind !== 'points') continue;
      const m = proj.grids[l.grid];
      if (!m) continue;
      const seen = new Set<number>();
      const parts: string[] = [];
      const r = l.r;
      for (let i = 0; i < l.x.length; i++) {
        if (!Number.isFinite(l.x[i]) || !Number.isFinite(l.y[i])) continue;
        const px = f1(m.ax + m.bx * l.x[i]), py = f1(m.ay + m.by * l.y[i]);
        const k = Math.round(px * 2) * 100000 + Math.round(py * 2);
        if (seen.has(k)) continue;
        seen.add(k);
        parts.push(`M${f1(px - r)} ${py}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`);
      }
      if (parts.length) out.push(path(parts.join(''), `fill="${l.fill ?? 'none'}" stroke="${l.stroke ?? 'none'}"${l.stroke ? ' stroke-width="1"' : ''} opacity="${l.alpha}"`));
    }
    return out.join('');
  }
  const m = proj.map, dims = spec.dims!;
  if (!m) return '';
  for (const l of spec.layers) {
    if (l.kind !== 'lines') continue;
    const n = l.v.length / dims;
    const attrs = (a: number) => `fill="none" stroke="${l.color}" stroke-width="${l.width}" stroke-linejoin="round" opacity="${Math.round(a * 1000) / 1000}"`;
    if (n <= LINE_LIMIT) {
      const parts: string[] = [];
      for (let i = 0; i < n; i++) for (let d = 0; d < dims; d++) parts.push(`${d ? 'L' : 'M'}${f1(m.x[d])} ${f1(m.ay[d] + m.by[d] * l.v[i * dims + d])}`);
      out.push(path(parts.join(''), attrs(l.alpha)));
    } else {
      for (const lvl of binLines(l.v, dims, m)) {
        if (!lvl.segs.length) continue;
        const parts: string[] = [];
        for (let k = 0; k < lvl.segs.length; k += 4) parts.push(`M${f1(lvl.segs[k])} ${f1(lvl.segs[k + 1])}L${f1(lvl.segs[k + 2])} ${f1(lvl.segs[k + 3])}`);
        out.push(path(parts.join(''), attrs(Math.max(0.03, l.alpha * lvl.alpha))));
      }
    }
  }
  return out.join('');
}

/** puts the dense layer right above the background of an ECharts SVG string (under grid lines and overlays) */
export function injectUnder(svg: string, layer: string): string {
  if (!layer) return svg;
  const bg = /<rect[^>]*fill="[^"]*"[^>]*>(<\/rect>)?/.exec(svg);
  if (bg && bg.index < 400) return svg.slice(0, bg.index + bg[0].length) + `<g>${layer}</g>` + svg.slice(bg.index + bg[0].length);
  const open = svg.indexOf('>') + 1;
  return svg.slice(0, open) + `<g>${layer}</g>` + svg.slice(open);
}
