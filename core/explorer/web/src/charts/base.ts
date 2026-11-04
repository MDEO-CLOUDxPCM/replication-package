import type { Palette } from '@/lib/palette';

export const FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/** shared chrome: recessive hairline grid, muted axis labels, card-like tooltip */
export function chrome(p: Palette) {
  return {
    backgroundColor: 'transparent',
    textStyle: { fontFamily: FONT, color: p.ink2, fontSize: 11 },
    animationDuration: 350,
    animationDurationUpdate: 300,
    tooltip: {
      backgroundColor: p.surface,
      borderColor: p.grid,
      borderWidth: 1,
      padding: [8, 10],
      textStyle: { color: p.ink, fontFamily: FONT, fontSize: 12 },
      extraCssText: 'box-shadow: 0 4px 16px rgba(0,0,0,0.12); border-radius: 8px;',
    },
  };
}

export function valueAxis(p: Palette, extra: Record<string, unknown> = {}) {
  return {
    type: 'value',
    axisLine: { show: true, lineStyle: { color: p.axis } },
    axisTick: { show: false },
    splitLine: { lineStyle: { color: p.grid, width: 1, type: 'solid' } },
    axisLabel: { color: p.muted, fontSize: 10, hideOverlap: true },
    nameTextStyle: { color: p.ink2, fontSize: 11 },
    nameGap: 26,
    scale: true,
    ...extra,
  };
}

export function categoryAxis(p: Palette, extra: Record<string, unknown> = {}) {
  return {
    type: 'category',
    axisLine: { lineStyle: { color: p.axis } },
    axisTick: { show: false },
    splitLine: { show: false },
    axisLabel: { color: p.muted, fontSize: 10, hideOverlap: true },
    nameTextStyle: { color: p.ink2, fontSize: 11 },
    ...extra,
  };
}

export function legend(p: Palette, extra: Record<string, unknown> = {}) {
  return { top: 0, right: 0, icon: 'roundRect', itemWidth: 14, itemHeight: 3, textStyle: { color: p.ink2, fontSize: 11 }, ...extra };
}

/** a tooltip row: a short line key of the series colour, value first (strong), label after */
export function ttRow(color: string, value: string, label: string, dash = false) {
  const key = `<span style="display:inline-block;width:12px;height:0;border-top:2px ${dash ? 'dashed' : 'solid'} ${color};margin-right:8px;vertical-align:middle"></span>`;
  return `<div style="display:flex;align-items:center;gap:2px;line-height:1.6">${key}<b style="font-weight:600">${value}</b><span style="opacity:.7;margin-left:6px">${escapeHtml(label)}</span></div>`;
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
