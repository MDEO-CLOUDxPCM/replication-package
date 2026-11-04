// @vitest-environment jsdom
/**
 * The Verify tab as a generic viewer of a packet's Verify files (contract/verify.ts), on a tiny packet
 * (tests/fixtures/verify-mini: five parts, causes, chains, a git and a dir source tree), served by the backend's
 * routes in-process (server/app.ts over a packet in a temp dir). No build/, no case files.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { InputModel } from '../contract/types';
import type { PacketBody } from '../contract/packet';
import type { VerifyChains, VerifyParts } from '../contract/verify';
import { createApp } from '../server/app';
import { LocalConfig } from '../server/local-config';
import { Packet } from '../server/packets';
import type { Registry } from '../server/registry';
import { PacketContext } from '../web/src/lib/packet';
import { verifyInfo, VerifyInfoContext } from '../web/src/model/verify/data';
import { parseDocument, planNodes } from '../web/src/model/verify/GraphqlDoc';
import { issuesMarkdown, MARKS_KEY, mergeMarks, useMarks, type Marks } from '../web/src/model/verify/marks';
import { OpTree, type OpState } from '../web/src/model/verify/OpTree';
import { relatedCode, segments } from '../web/src/model/verify/related';
import { PartView, VerifyTab } from '../web/src/model/verify/VerifyTab';
import { CausesView } from '../web/src/model/verify/Causes';

const FIXTURE = path.join(__dirname, 'fixtures/verify-mini');
const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, '-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' }).trim();

let dir: string;
let packet: Packet;
let body: PacketBody;
let vp: VerifyParts;
let chains: VerifyChains;
let model: InputModel;
const haveGit = (() => { try { execFileSync('git', ['--version']); return true; } catch { return false; } })();

beforeAll(() => {
  // the fixture as a packet in a temp dir; its `code` tree a git repository at a commit
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verify-mini-'));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'packet.json'), 'utf8'));
  if (haveGit) {
    const code = path.join(dir, 'code');
    git(code, 'init', '-q');
    git(code, 'add', '.');
    git(code, 'commit', '-q', '-m', 'fixture');
    manifest.sources.code.ref = git(code, 'rev-parse', 'HEAD');
  }
  fs.writeFileSync(path.join(dir, 'packet.json'), JSON.stringify(manifest));
  packet = new Packet(dir, Packet.readManifest(dir), { id: 'mini', domains: ['mini'] }, new LocalConfig(dir, {}));
  body = packet.body();
  vp = JSON.parse(fs.readFileSync(path.join(dir, 'verify/parts.json'), 'utf8'));
  chains = JSON.parse(fs.readFileSync(path.join(dir, 'verify/chains.json'), 'utf8'));
  model = JSON.parse(fs.readFileSync(path.join(dir, 'models/mini.json'), 'utf8'));
  // the backend's packet routes, in-process
  const registry = { index: () => ({ runs: [], packets: [packet.summary()] }), packets: () => [packet], packet: (id: string) => (id === packet.id ? packet : null) } as unknown as Registry;
  const app = createApp(registry);
  globalThis.fetch = (async (u: string) => app.request(new URL(u, 'http://x').pathname + new URL(u, 'http://x').search)) as typeof fetch;
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  Element.prototype.scrollIntoView ??= function () {};
});
afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });
afterEach(() => { cleanup(); localStorage.clear(); useMarks.getState().open(undefined); });

const wrap = (el: ReactElement, b: PacketBody = body) => createElement(PacketContext.Provider, { value: b }, createElement(QueryClientProvider, { client: new QueryClient() }, el));
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');

describe('the packet routes', () => {
  it('serve the Verify files and the source trees', async () => {
    const r = await fetch('/api/packets/mini/verify/parts');
    expect((await r.json()).parts.map((p: { key: string }) => p.key)).toEqual(vp.parts.map((p) => p.key));
    expect((await (await fetch('/api/packets/mini/verify/nope')).status)).toBe(404);
    expect((await (await fetch('/api/packets/mini/sources/notes')).json()).files).toEqual(['spec.md']);
    expect((await (await fetch('/api/packets/mini/sources/notes/file?path=spec.md')).json()).text).toContain('## Order');
    expect((await fetch('/api/packets/mini/sources/notes/file?path=../packet.json')).status).toBe(404);
    if (haveGit) {
      expect((await (await fetch('/api/packets/mini/sources/code')).json()).files.sort()).toEqual(['src/Order.kt', 'src/Stock.kt']);
      const f = await (await fetch('/api/packets/mini/sources/code/file?path=src/Order.kt')).json();
      expect(f.commit).toBe(body.manifest.sources!.code.kind === 'git' ? (body.manifest.sources!.code as { ref: string }).ref : '');
      expect(f.text).toContain('class OrderService');
    }
  });
});

describe('Verify tab', () => {
  it('renders every part', () => {
    const info = verifyInfo(vp, body.manifest.sources);
    const causes = JSON.parse(fs.readFileSync(path.join(dir, 'verify/causes.json'), 'utf8'));
    for (const p of vp.parts) {
      const html = renderToString(wrap(createElement(VerifyInfoContext.Provider, { value: info }, createElement(PartView, { part: p, mark: undefined, sel: null, onSelect: () => {}, trees: undefined, nav: {}, model, causes: causes[p.key] }))));
      expect(html, p.key).toContain(esc(p.title));
      expect(html, p.key).toContain(info.kind(p.kind).label);
    }
  });

  it.skipIf(!haveGit)('shows a part with its source, marks it verified and keeps the mark in localStorage per packet', async () => {
    const key = 'op:shop.order';
    render(wrap(createElement(VerifyTab, { model, partKey: key, narrow: false })));
    await screen.findByRole('heading', { name: 'order' });
    // what it causes: the rows with their code; the lead facts above, the others under More
    expect(screen.getAllByText('What it causes').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Effect step').length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain('More: the tables');
    // the source pane opens the entry point's file at its line, the git tree's label before the path
    await waitFor(() => expect(document.body.textContent).toContain('class OrderService'));
    expect(document.body.textContent).toContain('mini-code src/Order.kt');
    // the call to the next function is a link (the chain)
    expect(screen.getAllByRole('link').some((l) => l.textContent === 'reserve')).toBe(true);
    // evidence outside the tree is shown, not opened: the generic fallback names the tree's label
    expect(document.querySelector('[title="vendor/Legacy.kt (not in mini-code)"]')).not.toBeNull();
    // a row's evidence shows its line; another evidence file opens from its tab
    fireEvent.click(screen.getAllByRole('button', { name: 'Order.kt:6' })[0]);
    fireEvent.click(screen.getByRole('button', { name: /^Stock\.kt/ }));
    await waitFor(() => expect(document.body.textContent).toContain('repo.decrement'));
    // a document of the dir tree, at its anchor
    fireEvent.click(screen.getByRole('button', { name: /spec spec\.md/ }));
    await waitFor(() => expect(document.body.textContent).toContain('placing it reserves the stock'));
    // verified, kept under the packet's key
    await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: 'Verified' })); });
    const marks = () => JSON.parse(localStorage.getItem(`${MARKS_KEY}:mini`) ?? '{}') as Marks;
    expect(marks()[key]).toMatchObject({ ok: true, fp: 'f-op-order' });
    expect(document.body.textContent).toMatch(/1 of 2 operations verified/);
    // the issue replaces the verified mark
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: /Issue/ })[0]); });
    expect(marks()[key]).toMatchObject({ ok: false, issue: true });
    // a row is checked on its own
    await act(async () => { fireEvent.click(screen.getAllByRole('checkbox', { name: 'Checked' })[0]); });
    expect(Object.keys(marks()).some((k) => k.startsWith(`${key}#`))).toBe(true);
  });

  it('lists the operations as a tree, the other parts by group behind the switch, with the packet\'s texts', async () => {
    render(wrap(createElement(VerifyTab, { model, narrow: false })));
    await screen.findByText('Verify the mini model against the shop');
    expect(document.body.textContent).toContain('The mini model has 5 parts: 1 classes, 3 operations, 1 notes (mini-code@0123456789ab).');
    // the italics of a text
    expect(document.querySelector('i')?.textContent).toBe('out');
    expect(screen.getAllByText('order').length).toBeGreaterThan(0);
    expect(document.body.textContent).toContain('0 of 2 operations verified');
    await act(async () => { fireEvent.click(screen.getByRole('checkbox', { name: 'Other parts' })); });
    const groups = screen.getAllByRole('button').map((b) => b.textContent ?? '');
    // the groups, the late one last; the scope's badge beside a left-out operation
    expect(groups.filter((t) => /^(shop|stock|notes)\d/.test(t)).map((t) => t.replace(/\d.*/, ''))).toEqual(['shop', 'stock', 'notes']);
    expect(screen.getByText('out', { selector: 'span' }).getAttribute('title')).toBe('not in the model');
    // the scope filter's options come from the parts file
    const scope = screen.getByRole('combobox', { name: /where they stand/ }) as HTMLSelectElement;
    expect([...scope.options].map((o) => o.textContent)).toEqual(['all operations', 'ops in the model', 'ops modelled', 'ops left out']);
    await act(async () => { fireEvent.change(scope, { target: { value: 'left' } }); });
    expect(screen.queryByText('reserve')).toBeNull();
    expect(screen.getAllByText('cleanup').length).toBeGreaterThan(0);
  });

  it('without texts: the generic fallbacks, the tree\'s label', async () => {
    const bare: PacketBody = { ...body, docs: {} };
    render(wrap(createElement(VerifyTab, { model, narrow: false }), bare));
    await screen.findByText('Verify the model against mini-code');
    expect(document.body.textContent).toContain('5 parts: 1 classes, 3 operations, 1 notes.');
    expect(document.querySelectorAll('p').length).toBeGreaterThan(0);
  });

  it('sums up a request\'s operations on its row: finished of all, the worst state first', () => {
    const tree = (state: (op: string) => OpState | undefined) => renderToString(createElement(OpTree, { model, q: '', state, progress: () => undefined }));
    const row = (html: string) => html.match(/<li[^>]*>(?:(?!<\/li>).)*?>order<\/span>.*?<\/li>/)![0];
    expect(row(tree(() => 'finished'))).toContain('>2/2<');
    expect(row(tree(() => 'open'))).toContain('>0/2<');
    expect(row(tree((op) => (op === 'shop.order' ? 'finished' : 'open')))).toContain('>1/2<');
    expect(row(tree(() => 'issue'))).toContain('aria-label="issue"');
  });

  it('finds every gateway plan entry in its request\'s GraphQL document', () => {
    for (const r of model.requests.filter((x) => x.document)) {
      const d = parseDocument(r.document!);
      expect(d, r.id).not.toBeNull();
      const { at, entity } = planNodes(r, d!.roots);
      expect(at.size + entity.size, r.id).toBe(r.plan.length);
    }
  });
  it('shows own data with its fixed mechanism: a read sync, a write in transaction, the own option beside the others', () => {
    const row = (key: string, kind: 'read' | 'write', allowed: string[], today: string) => ({ key, kind, cls: 'Order', allowed, today, model: [], code: [], ev: [], fp: key });
    const causes = { rows: [row('r', 'read', ['own'], 'own'), row('w', 'write', ['own'], 'own'), row('o', 'read', ['own', 'sync'], 'sync'), row('l', 'write', ['local'], 'local')] };
    const html = renderToString(wrap(createElement(CausesView, { causes, partKey: 'op:x', sel: null, onSelect: () => {}, trees: undefined, hasPart: () => false })));
    const own = [...html.matchAll(/data-own="(read|write)"[^]*?own data<\/span><\/span>/g)].map((m) => [m[1], m[0]]);
    // grouped by family: the reads (Fetch), then the writes (Effect step); the chip's label from the packet's vocabulary
    expect(own.map(([k]) => k)).toEqual(['read', 'read', 'write', 'write']);
    expect(own[0][1]).toMatch(/>sync</);
    expect(own[2][1]).toMatch(/>(in transaction|inTx)</);
    expect(own[3][1]).toMatch(/>(in transaction|inTx)</);
    // the own option of a decision is not today's: muted, the call site's sync beside it
    expect(own[1][1]).toContain('opacity-60');
    expect(own[0][1]).not.toContain('opacity-60');
  });
});

describe('Verify related code', () => {
  it('walks the chain from the entry and links the calls between its functions', () => {
    const r = relatedCode(vp.parts.find((p) => p.key === 'op:shop.order')!, chains);
    expect(r.fns.map((f) => f.label)).toEqual(['OrderService.place', 'StockService.reserve']);
    expect(r.fns[0].entry && r.fns[1].from === 'OrderService.place').toBe(true);
    const line = fs.readFileSync(path.join(FIXTURE, 'code', r.calls[0].path), 'utf8').split('\n')[r.calls[0].line - 1];
    expect(line.slice(r.calls[0].col, r.calls[0].col + r.calls[0].len)).toBe('reserve');
    expect(relatedCode(vp.parts.find((p) => p.key === 'op:stock.reserve')!, chains)).toMatchObject({ fns: [], error: 'no entry' });
    expect(relatedCode(vp.parts.find((p) => p.kind === 'class')!, chains).fns).toEqual([]);
  });

  it('cuts a line\'s tokens at its call sites', () => {
    const to = { key: 'R.save', label: 'R.save', path: 'p', line: 1, end: 1, pm: true, step: true, reached: true, entry: false, depth: 1 };
    const segs = segments('repo.save(x)', [{ content: 'repo.', style: { a: '1' } }, { content: 'save(x)', style: { a: '2' } }], [{ path: 'p', line: 1, col: 5, len: 4, to }]);
    expect(segs.map((s) => [s.content, s.style?.a, !!s.link])).toEqual([['repo.', '1', false], ['save', '2', true], ['(x)', '2', false]]);
    expect(segments('a.bc()', undefined, [{ path: 'p', line: 1, col: 2, len: 2, to }]).map((s) => s.content)).toEqual(['a.', 'bc', '()']);
  });
});

describe('Verify marks', () => {
  const m = (at: string, x: Partial<Marks[string]> = {}) => ({ ok: true, fp: 'f', at, ...x });

  it('merge: the later mark of a key wins', () => {
    const { marks, n } = mergeMarks({ a: m('2026-01-02'), b: m('2026-01-01') }, { a: m('2026-01-01', { note: 'old' }), b: m('2026-01-03', { note: 'new' }), c: m('2026-01-01'), bad: { at: 1 } as never });
    expect(n).toBe(2);
    expect(marks.a.note).toBeUndefined();
    expect(marks.b.note).toBe('new');
    expect(Object.keys(marks).sort()).toEqual(['a', 'b', 'c']);
  });

  it('the tab switches the store with the packet', async () => {
    localStorage.setItem(`${MARKS_KEY}:mini`, JSON.stringify({ 'op:shop.order': m('2026-01-05', { fp: 'f-op-order' }) }));
    render(wrap(createElement(VerifyTab, { model, narrow: false })));
    await screen.findByText(/1 of 2 operations verified/);
    expect(useMarks.getState().key).toBe(`${MARKS_KEY}:mini`);
    cleanup();
    // another packet: its own, empty marks
    const other: PacketBody = { ...body, manifest: { ...body.manifest, id: 'other' } };
    const registry = { index: () => ({ runs: [], packets: [] }), packets: () => [packet], packet: () => packet } as unknown as Registry;
    const app = createApp(registry);
    const prev = globalThis.fetch;
    globalThis.fetch = (async (u: string) => app.request(u.replace('/api/packets/other/', '/api/packets/mini/'))) as typeof fetch;
    try {
      render(wrap(createElement(VerifyTab, { model, narrow: false }), other));
      await screen.findByText(/0 of 2 operations verified/);
      expect(useMarks.getState().key).toBe(`${MARKS_KEY}:other`);
    } finally { globalThis.fetch = prev; }
  });

  it('the issues as Markdown: the packet\'s heading, else a generic one', () => {
    const marks = { 'op:shop.order': m('2026-01-01', { ok: false, issue: true, note: 'check\nthis' }), 'class:Order#x': m('2026-01-01', { note: 'fine' }), 'gone:x': m('2026-01-01', { issue: true }) };
    const tx = (k: string, v?: Record<string, unknown>) => (k === 'verify.issues.title' ? '# Mini issues' : k === 'verify.issues.head' ? `${v!.tree} ${v!.commit}: ${v!.n} marks` : '');
    expect(issuesMarkdown(vp.parts, marks, { tx, tree: 'mini-code', commit: vp.commit })).toBe('# Mini issues\n\nmini-code 0123456789ab: 2 marks\n\n- **issue** `op:shop.order` (shop): check this\n- **note** `class:Order#x` (shop): fine');
    expect(issuesMarkdown(vp.parts, marks, { tree: 'mini-code' }).split('\n').slice(0, 3)).toEqual(['# Verification: issues and notes', '', 'mini-code ?; 2 marks.']);
  });
});
