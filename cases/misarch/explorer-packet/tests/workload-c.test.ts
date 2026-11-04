/** The MiSArch case's workload adapter (workload-c.ts): package C's session model -> request types, sessions, load profiles. */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { visitsOf as genericVisitsOf } from '../../../../core/explorer/contract/derive';
import { fromWorkload, stoexMean, visitsOf } from '../workload-c';
import { files } from '../config';

const haveWorkload = fs.existsSync(files.workload);

describe('workload adapter (package C)', () => {
  it('means of StoEx expressions', () => {
    expect(stoexMean('IntPMF[(1;0.6)(2;0.3)(3;0.1)]')).toBeCloseTo(1.5);
    expect(stoexMean('UniDouble(4.0, 10.0)')).toBe(7);
    expect(stoexMean(3)).toBe(3);
  });

  it('expected visits through loops, branches and fragments; design sessions from round 2', () => {
    const w = {
      version: 1,
      think: { t: { dist: 'UniDouble(2, 4)' } },
      fragments: { pay: { steps: [{ call: 'createOrder' }, { think: 't' }, { call: 'placeOrder' }] } },
      classes: {
        browser: { steps: [{ call: 'products' }, { loop: 'IntPMF[(1;0.5)(3;0.5)]', body: [{ think: 't' }, { call: 'product' }] }] },
        buyer: { steps: [{ call: 'product' }, { branch: [{ p: 0.5, body: [{ use: 'pay' }] }, { p: 0.5, body: [] }] }] },
        admin: { steps: [{ call: 'adminNewPrice' }] },
      },
      workloads: { realistic: { baseMix: 'shopping', mixes: { shopping: { shares: { browser: 0.75, buyer: 0.25 } }, sale: { shares: { browser: 0.5, buyer: 0.5 } } } } },
      profiles: { day: { endSeconds: 40, phases: [{ from: 0, volume: 1, mix: 'shopping', name: 'a' }, { from: 20, volume: 2, mix: 'sale', name: 'b' }] } },
      requests: { products: { operations: ['catalog.products', 'x.unknown'] }, product: { operations: [] }, createOrder: { operations: [] }, placeOrder: { operations: [] }, adminNewPrice: { operations: [] } },
    };
    const r2 = new Map([['products', 30], ['product', 70], ['adminNewPrice', 0.1], ['login', 0]]);
    const wl = fromWorkload(w, r2, new Set(['catalog.products']), new Map());
    const buyer = wl.sessions.find((s) => s.id === 'buyer')!;
    expect(buyer.steps.map((s) => [s.request, s.repeat])).toEqual([['product', 1], ['createOrder', 0.5], ['placeOrder', 0.5]]);
    const browser = wl.sessions.find((s) => s.id === 'browser')!;
    expect(browser.steps.find((s) => s.request === 'product')!.repeat).toBe(2);
    // calls per session: browser 3, buyer 2 -> 0.75*3 + 0.25*2 = 2.75; round 2 sends 100 client requests/s
    expect(wl.designSessions).toBeCloseTo(100 / 2.75);
    expect(wl.requests.find((r) => r.id === 'products')!.operations).toEqual(['catalog.products']);
    const day = wl.profiles.find((p) => p.id === 'day')!;
    expect(day.sessionsPerSecond[3]).toBeCloseTo(2 * wl.designSessions, 1);
    expect(day.mix.buyer[0]).toBe(0.25);
    expect(day.mix.buyer[3]).toBe(0.5);
  });
});

describe.skipIf(!haveWorkload)('workload adapter over the case\'s sessions.json', () => {
  it('every session class walks to request types with visits, the profiles cover their phases', () => {
    const w = JSON.parse(fs.readFileSync(files.workload, 'utf8'));
    const wl = fromWorkload(w, new Map([['products', 10]]), new Set(), new Map());
    expect(wl.sessions.length).toBeGreaterThan(1);
    for (const s of wl.sessions) expect(s.steps.length, s.id).toBeGreaterThan(0);
    expect(wl.requests.length).toBeGreaterThan(5);
    expect(wl.profiles.length).toBeGreaterThan(0);
    for (const p of wl.profiles) expect(p.t.length, p.id).toBe(p.sessionsPerSecond.length);
    // the re-exported visitsOf is the contract's
    expect(visitsOf).toBe(genericVisitsOf);
    const s = wl.sessions[0];
    expect([...visitsOf(s).keys()]).toEqual([...new Set(s.steps.map((x) => x.request))]);
  });
});
