import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { PacketBody } from '../contract/packet';
import { MetricHelp } from '../web/src/help/MetricHelp';
import { REF_RELATIONS, refLink, refShort, type MetricDoc, type Ref } from '../web/src/lib/metricDocs';
import { PacketContext } from '../web/src/lib/packet';

// the generic literature helpers of the ? popovers (a packet's references: packets/*/tests/metric-docs.test.ts)
describe('metric doc references', () => {
  const r = (authors: string, extra: Partial<Ref> = {}): Ref => ({ authors, year: 2009, title: 'A title', venue: 'A venue', relation: 'source', ...extra });
  it('short form: one, two, or the first author et al. and the year', () => {
    expect(refShort(r('Becker'))).toBe('Becker 2009');
    expect(refShort(r('Becker, Koziolek'))).toBe('Becker & Koziolek 2009');
    expect(refShort(r('Becker, Koziolek, Reussner'))).toBe('Becker et al. 2009');
  });
  it('links to the DOI, else the URL', () => {
    expect(refLink(r('A', { doi: '10.1016/j.jss.2008.03.066', url: 'https://example.org' }))).toBe('https://doi.org/10.1016/j.jss.2008.03.066');
    expect(refLink(r('A', { url: 'https://example.org/x' }))).toBe('https://example.org/x');
  });
  it('knows the relations in their order of strength', () => {
    expect(REF_RELATIONS).toEqual(['source', 'based on', 'adapted from', 'related']);
  });
});

describe('metric help (the ? next to a figure)', () => {
  const doc: MetricDoc = { key: 'x', title: 'The X', kind: 'metric', direction: 'descriptive', summary: 'What X is, in a sentence or two.', inputs: ['the input'], cite: ['somewhere'] };
  const packet = (docs: Record<string, unknown>): PacketBody => ({
    contract: '1', docs,
    manifest: { contract: '1', id: 'p', name: 'P', domains: [] },
    summary: { id: 'p', name: 'P', domains: [], capabilities: {}, allowedCommands: [] },
  });
  const render = (p: PacketBody | null, k: string) => renderToStaticMarkup(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(PacketContext.Provider, { value: p }, createElement(MetricHelp, { k }))));
  it('reads the packet\'s doc `metrics`', () => {
    expect(render(packet({ metrics: [doc] }), 'x')).toContain('How The X is computed');
  });
  it('shows nothing for a key the packet has no doc for, or without the doc', () => {
    expect(render(packet({ metrics: [doc] }), 'y')).toBe('');
    expect(render(packet({}), 'x')).toBe('');
  });
});
