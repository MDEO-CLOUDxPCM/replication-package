/** Colours for charts and the graph (the same values as the CSS tokens in index.css). */
import type { Mechanism } from '@contract/types';
import type { Theme } from './theme';

export interface Palette {
  surface: string; page: string; ink: string; ink2: string; muted: string; grid: string; axis: string; border: string;
  series: string[]; good: string; warning: string; serious: string; critical: string; a: string; b: string;
  seq: string[];
}

export const PALETTES: Record<Theme, Palette> = {
  light: {
    surface: '#fcfcfb', page: '#f9f9f7', ink: '#0b0b0b', ink2: '#52514e', muted: '#898781', grid: '#e1e0d9', axis: '#c3c2b7', border: 'rgba(11,11,11,0.10)',
    series: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'],
    good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b', a: '#2a78d6', b: '#eb6834',
    seq: ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'],
  },
  dark: {
    surface: '#1a1a19', page: '#0d0d0d', ink: '#f0efec', ink2: '#c3c2b7', muted: '#898781', grid: '#2c2c2a', axis: '#383835', border: 'rgba(255,255,255,0.10)',
    series: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
    good: '#0ca30c', warning: '#fab219', serious: '#ec835a', critical: '#d03b3b', a: '#3987e5', b: '#d95926',
    seq: ['#104281', '#184f95', '#1c5cab', '#256abf', '#2a78d6', '#5598e7', '#86b6ef'],
  },
};

/**
 * mechanisms: fixed categorical slots + a dash pattern as the second channel (never colour alone). `inTx` (an effect
 * step in the caller's transaction) is drawn neutral; an access within one service has no mechanism and no style.
 */
export const MECHANISM_STYLE: Record<Mechanism | 'inTx' | 'reference' | 'event' | 'feed', { slot: number | null; dash: string; label: string; description: string }> = {
  inTx: { slot: null, dash: '', label: 'in transaction', description: "the callee's work inside the caller's transaction" },
  sync: { slot: 0, dash: '', label: 'sync call', description: 'synchronous call to the owning service' },
  copy: { slot: 1, dash: '7 4', label: 'local copy', description: 'read a local copy fed by events' },
  cache: { slot: 2, dash: '2 3', label: 'cache', description: 'cache in front of a synchronous call' },
  join: { slot: 3, dash: '9 3 2 3', label: 'gateway join', description: 'the gateway fetches it from the owner' },
  saga: { slot: 4, dash: '12 3 3 3 3 3', label: 'async / saga step', description: 'an asynchronous call to another service (an async write or event, or an asynchronous saga step)' },
  feed: { slot: 6, dash: '1 3', label: 'copy feed', description: "the owner's events feed a copy" },
  event: { slot: 5, dash: '4 4', label: 'domain event', description: 'a published event handled in another service' },
  reference: { slot: null, dash: '', label: 'reference', description: 'class reference in the domain model' },
};

export function edgeColor(p: Palette, kind: keyof typeof MECHANISM_STYLE): string {
  const s = MECHANISM_STYLE[kind].slot;
  return s === null ? p.muted : p.series[s];
}

/** service accent: categorical slot by stable index while there are at most 8 services; neutral beyond */
export function serviceAccent(p: Palette, index: number, count: number): string | null {
  return count <= 8 && index < 8 ? p.series[index] : null;
}
