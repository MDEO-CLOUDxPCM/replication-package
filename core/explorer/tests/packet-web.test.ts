// @vitest-environment jsdom
/**
 * The web's generic pieces with the tiny fixture packet (tests/fixtures/packet-tiny) given through PacketContext:
 * templates, the packet hooks, the inline markup and a metric doc's popover body. Needs nothing of build/ or the case.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createElement, type ReactElement } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { PacketBody, PacketManifest } from '../contract/packet';
import { CONTRACT_VERSION } from '../contract/types';
import { PacketContext, packetKey, renderTemplate, useCapabilities, useDoc, useTexts, useVocab } from '../web/src/lib/packet';
import { Rich } from '../web/src/help/Rich';
import MetricHelpContent from '../web/src/help/MetricHelpContent';
import type { MetricDoc } from '../web/src/lib/metricDocs';
import { OwnDataBadge, PlacementBadge } from '../web/src/components/PlacementBadge';
import { EffectCallChip, LevelChip, LockMark } from '../web/src/components/LevelChip';
import { callConsistency, levelOf, mergeConsistency, readConsistency } from '../contract/consistency';
import type { ModelOperation } from '../contract/types';
import { Realisation } from '../web/src/model/CallTree';
import type { Placement, Realised } from '../web/src/model/callGraph';

const FIXTURE = path.resolve(__dirname, 'fixtures/packet-tiny');
const read = <T>(f: string): T => JSON.parse(fs.readFileSync(path.join(FIXTURE, f), 'utf8')) as T;
const manifest = read<PacketManifest>('packet.json');
const body: PacketBody = {
  contract: CONTRACT_VERSION, manifest,
  docs: Object.fromEntries(Object.entries(manifest.docs ?? {}).map(([k, f]) => [k, read(f)])),
  summary: { id: manifest.id, name: manifest.name, domains: manifest.domains, capabilities: manifest.capabilities ?? {}, allowedCommands: [] },
};
const metrics = body.docs.metrics as MetricDoc[];

beforeAll(() => {
  // nothing may reach a backend: the packet is given
  globalThis.fetch = (async (u: string) => new Response(JSON.stringify({ error: `no backend in this test (${u})` }), { status: 404 })) as typeof fetch;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
});
afterEach(() => cleanup());

const wrap = (el: ReactElement, packet: PacketBody | null = body) =>
  createElement(QueryClientProvider, { client: new QueryClient({ defaultOptions: { queries: { retry: false } } }) }, createElement(PacketContext.Provider, { value: packet }, el));

describe('templates', () => {
  it('variables, sections and inverted sections', () => {
    const t = (body.docs.texts as Record<string, string>)['fixture.summary'];
    expect(renderTemplate(t, { classes: 6, services: 3, note: 'a monolith would do' })).toBe('6 classes in 3 services (a monolith would do).');
    expect(renderTemplate(t, { classes: 6, services: 3 })).toBe('6 classes in 3 services, nothing to note.');
    expect(renderTemplate('{{#xs}}[{{xs}}]{{/xs}}{{^xs}}none{{/xs}}', { xs: ['a', 'b'] })).toBe('[a, b]');
    expect(renderTemplate('{{#xs}}[{{xs}}]{{/xs}}{{^xs}}none{{/xs}}', { xs: [] })).toBe('none');
    expect(renderTemplate('{{#n}}n={{n}}{{/n}}{{^n}}zero{{/n}}', { n: 0 })).toBe('zero');
    expect(renderTemplate('{{#a}}A{{#b}}B{{/b}}{{^b}}-{{/b}}{{/a}}', { a: true, b: false })).toBe('A-');
    expect(renderTemplate('{{x}}|{{y}}|{{z}}', { x: null, y: false })).toBe('||');
  });

  it('packetKey: per packet', () => {
    expect(packetKey('marks', 'bookshop')).toBe('marks:bookshop');
    expect(packetKey('marks', undefined)).toBe('marks');
  });
});

function Probe() {
  const tx = useTexts();
  const caps = useCapabilities();
  const vocab = useVocab();
  const docs = useDoc<MetricDoc[]>('metrics');
  const summary = tx('fixture.summary', { classes: 6, services: 2 });
  return createElement('div', null,
    createElement('h1', null, createElement(Rich, { text: tx('fixture.title') })),
    summary && createElement('p', { 'data-testid': 'summary' }, summary),
    tx('fixture.empty') && createElement('p', { 'data-testid': 'empty' }, tx('fixture.empty')),
    tx('no.such.key') && createElement('p', { 'data-testid': 'missing' }, 'x'),
    createElement('ul', { 'data-testid': 'caps' }, ...Object.entries(caps).filter(([, v]) => v === true).map(([k]) => createElement('li', { key: k }, k))),
    createElement('span', { 'data-testid': 'family' }, caps.family ?? 'no family'),
    createElement('span', { 'data-testid': 'mech' }, `${vocab.label('mechanisms', 'sync')} / ${vocab.entry('mechanisms', 'sync')?.short} / ${vocab.label('mechanisms', 'join')}`),
    createElement('span', { 'data-testid': 'kind' }, vocab.label('operationKinds', 'handler')),
    createElement('span', { 'data-testid': 'docs' }, (docs ?? []).map((d) => d.code).join(',')),
  );
}

describe('the packet hooks', () => {
  it('texts, capabilities, vocabulary and docs of the given packet', () => {
    render(wrap(createElement(Probe)));
    const h = screen.getByRole('heading');
    expect(h.textContent).toBe('The bookshop');
    expect(h.querySelector('b')?.textContent).toBe('bookshop');
    expect(screen.getByTestId('summary').textContent).toBe('6 classes in 2 services, nothing to note.');
    // an empty or missing text renders nothing
    expect(screen.queryByTestId('empty')).toBeNull();
    expect(screen.queryByTestId('missing')).toBeNull();
    expect([...screen.getByTestId('caps').querySelectorAll('li')].map((l) => l.textContent).sort()).toEqual(['loaded', 'performance']);
    expect(screen.getByTestId('family').textContent).toBe('no family');
    // a word the packet does not define falls back to its id
    expect(screen.getByTestId('mech').textContent).toBe('Remote call / call / join');
    expect(screen.getByTestId('kind').textContent).toBe('Reaction');
    expect(screen.getByTestId('docs').textContent).toBe('O1,O2,O3,C1');
  });

  it('without a packet: no texts, no capabilities, ids for words', () => {
    render(wrap(createElement(Probe), null));
    expect(screen.getByRole('heading').textContent).toBe('');
    expect(screen.queryByTestId('summary')).toBeNull();
    expect(screen.getByTestId('caps').children).toHaveLength(0);
    expect(screen.getByTestId('mech').textContent).toBe('sync / undefined / join');
  });
});

describe('inline markup', () => {
  it('code, bold and model links', () => {
    const { container } = render(wrap(createElement(Rich, { text: 'Cores for `replicas`, **all** of [the shop](domain:Book).' })));
    expect(container.textContent).toBe('Cores for replicas, all of the shop.');
    expect(container.querySelector('code')?.textContent).toBe('replicas');
    expect(container.querySelector('b')?.textContent).toBe('all');
    expect(container.querySelector('button')?.textContent).toBe('the shop');
  });
});

describe('a metric doc of the packet', () => {
  it('renders its popover body', () => {
    const doc = metrics.find((d) => d.key === 'cost')!;
    const { container } = render(wrap(createElement(MetricHelpContent, { doc, onNavigate: () => {} })));
    const text = container.textContent ?? '';
    expect(text).toContain('Shop cost');
    expect(text).toContain('O1');
    expect(text).toContain('minimised · cores');
    expect(container.querySelector('code')?.textContent).toBe('gateway');
    expect(text).toContain('Computed from');
    expect(text).toContain("the design's services and mechanisms");
    expect(text).toContain('Formula: made up for the test fixture.');
    expect(text).toContain('dummy/model.ts evaluate');
  });

  it('every objective and constraint of the run has a doc', () => {
    const run = read<{ objectives: { key: string }[]; constraints: { key: string }[] }>('runs/bookshop-static/run.json');
    const keys = new Set(metrics.map((d) => d.key));
    for (const k of [...run.objectives, ...run.constraints].map((x) => x.key)) expect(keys.has(k), k).toBe(true);
    for (const d of metrics) for (const f of ['key', 'title', 'kind', 'direction', 'summary', 'inputs', 'cite'] as const) expect(d[f], `${d.key}.${f}`).toBeDefined();
  });
});

describe('the placement badge: no hop or remote, never a mechanism', () => {
  const pl = { label: 'A (x)', design: true, serviceOf: () => undefined, mech: () => undefined } as unknown as Placement;
  const call = (together: boolean): Realised => ({ mech: 'sync', allowed: ['sync', 'cache'], decided: true, together, calleeSvc: { id: 's', name: 'CatalogService' }, text: together ? 'direct call' : 'synchronous call' });

  it('a co-located call shows "no hop", a remote one "remote → <service>", with the packet\'s explanation', () => {
    const near = render(wrap(createElement(Realisation, { r: call(true), pl })));
    const b = near.container.querySelector('[data-placement]')!;
    expect(b.getAttribute('data-placement')).toBe('noHop');
    expect(b.textContent).toBe('no hop');
    // the fixture packet's own words for no hop, the default for remote
    expect(b.getAttribute('title')).toBe('caller and callee in one container in A (x): both in one shop process: no network');
    expect(near.container.textContent).not.toMatch(/\blocal\b/);
    cleanup();
    const far = render(wrap(createElement(Realisation, { r: call(false), pl })));
    const f = far.container.querySelector('[data-placement]')!;
    expect(f.getAttribute('data-placement')).toBe('remote');
    expect(f.textContent).toBe('remote → CatalogService');
    expect(f.getAttribute('title')).toMatch(/^caller and callee in different containers \(callee in CatalogService\) in A \(x\): the hop/);
    expect(far.container.textContent).not.toMatch(/\blocal\b/);
  });

  it('the same badge outside the call tree; own data is no placement and no mechanism', () => {
    const { container } = render(wrap(createElement('div', null, createElement(PlacementBadge, { together: false }), createElement(OwnDataBadge))));
    const [r, o] = [...container.querySelectorAll('[data-placement]')];
    expect(r.textContent).toBe('remote');
    expect(o.getAttribute('data-placement')).toBe('own');
    expect(o.textContent).toBe('own data');
  });

  it('the fixture packet names no `local` mechanism', () => {
    expect((manifest.vocabulary?.mechanisms ?? []).map((m) => m.id)).not.toContain('local');
  });
});

describe('consistency levels (contract 1.13.0)', () => {
  const texts = { levels: { strict: 'current data only' }, rules: { S2: 'invariant guard', I1: 'monotone data', E1: 'an effect call' } };
  const op = {
    accesses: [
      { class: 'Book', mode: 'read', level: 'immutable', rules: ['I1'], reason: 'the isbn never changes' },
      { class: 'Book', mode: 'read', via: 'Book.stock', level: 'strict', rules: ['S2'], reason: 'the stock check guards the sale' },
      { class: 'Basket', mode: 'read', level: 'strict', rules: ['S5'], reason: 'locked', lock: true },
      { class: 'Author', mode: 'read' },
      { class: 'Old', mode: 'read', strong: true },
    ],
    calls: [{ callee: 'x.price', count: 1, level: 'stale-ok', rules: ['R1'] }, { callee: 'x.old', count: 1, strong: true }],
  } as unknown as ModelOperation;

  it('a read group takes its strictest access, with that level\'s rules and reasons; older packets\' strong is strict', () => {
    expect(readConsistency(op, 'Book')).toEqual({ level: 'strict', rules: ['S2'], reason: 'the stock check guards the sale' });
    expect(readConsistency(op, 'Basket')).toMatchObject({ level: 'strict', lock: true });
    expect(readConsistency(op, 'Author')).toEqual({ level: 'stale-ok' });
    expect(readConsistency(op, 'Old')?.level).toBe('strict');
    expect(levelOf({})).toBe('stale-ok');
    expect(callConsistency(op, 'x.price')).toEqual({ level: 'stale-ok', rules: ['R1'] });
    expect(callConsistency(op, 'x.old')?.level).toBe('strict');
    expect(mergeConsistency([{ level: 'immutable', reason: 'a' }, { level: 'immutable', reason: 'b' }])?.reason).toBe('a\nb');
  });

  it('a chip names the level and its rules, its tooltip the texts and the reason; own data shows none', () => {
    const { container } = render(wrap(createElement('div', null,
      createElement(LevelChip, { c: readConsistency(op, 'Book'), texts }),
      createElement(LevelChip, { c: { level: 'immutable', rules: ['I1'] }, texts }),
      createElement(LevelChip, { c: readConsistency(op, 'Basket'), texts, own: true }),
      createElement(LockMark),
      createElement(EffectCallChip, { to: 'provider.register', texts }))));
    const [strict, imm] = [...container.querySelectorAll('[data-level]')];
    expect(container.querySelectorAll('[data-level]')).toHaveLength(2);
    expect(strict.textContent).toBe('strict · S2');
    expect(strict.getAttribute('title')).toBe('strict: current data only\nS2: invariant guard\n\nwhy this read is strict:\nthe stock check guards the sale');
    expect(imm.textContent).toBe('immutable · I1');
    expect(imm.getAttribute('title')).toMatch(/no staleness cost/);
    expect(container.querySelector('[data-lock]')?.textContent).toBe('lock');
    expect(container.querySelector('[data-effect]')?.textContent).toBe('effect · E1');
    expect(container.querySelector('[data-effect]')?.getAttribute('title')).toMatch(/provider\.register[\s\S]*E1: an effect call/);
    expect(container.textContent).not.toMatch(/\bstrong\b/);
  });
});
