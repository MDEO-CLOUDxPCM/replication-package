import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InputModel } from '../contract/types';
import { callGraph, feedsInPlacement, realise, todayPlacement, type Placement } from '../web/src/model/callGraph';

const FILE = path.resolve(__dirname, '../../../build/explorer-sim/models/misarch-kotlin-derived.json');
const have = fs.existsSync(FILE);

describe.skipIf(!have)('call graph of the input model', () => {
  const m = have ? (JSON.parse(fs.readFileSync(FILE, 'utf8')) as InputModel) : (null as unknown as InputModel);
  const g = have ? callGraph(m) : (null as never);

  it('has the request roots and provider callbacks as entry points; everything else is reached from them', () => {
    const entries = new Set(g.entries.map((e) => e.op));
    for (const r of m.requests) expect(entries.has(r.plan[0].op), r.id).toBe(true);
    for (const o of m.operations) if (o.kind === 'callback') expect(entries.has(o.id)).toBe(true);
    for (const o of m.operations) if (!entries.has(o.id)) expect(g.reachedFrom.get(o.id)?.length ?? 0, o.id).toBeGreaterThan(0);
    // queries reached only through calls are downstream, not entry points
    expect(entries.has('discount.findApplicableDiscounts')).toBe(false);
    expect(g.entryOf.get('user.currentUser')!.roots.length).toBe(4);
  });

  it('links placeOrder to its reactions through event sites with their raise, and walks the Buy saga', () => {
    const e = g.entryOf.get('order.placeOrder')!;
    const ls = g.opLinks(e.roots[0].seff);
    const ev = ls.filter((l) => l.kind === 'event');
    expect(ev.map((l) => l.op).sort()).toEqual(['inventory.on:order/order/created', 'shoppingcart.on:order/order/created']);
    for (const l of ev) expect(l.site?.event).toBe('order/order/created');
    expect(g.reachedFrom.get('payment.http:/payment/update-payment-status')).toContain('order.placeOrder');
    const p = g.paths('shipment.on:payment/payment/payment-enabled');
    expect(p[0].entry).toBe(g.entries.find((x) => (g.reachedFrom.get('shipment.on:payment/payment/payment-enabled') ?? []).includes(x.op))!.op);
    expect(p[0].links.at(-1)!.op).toBe('shipment.on:payment/payment/payment-enabled');
  });

  it('realises links by placement: co-located events lose the broker, apart they use it', () => {
    const l = g.opLinks(g.entryOf.get('order.placeOrder')!.roots[0].seff).find((x) => x.kind === 'event')!;
    const today = realise(g, l, todayPlacement(m));
    expect(today.together).toBe(false);
    expect(today.mark?.kind).toBe('broker');
    const mono: Placement = { label: 'one service', design: true, serviceOf: () => ({ id: 's', name: 's' }), mech: (s) => s.today };
    expect(realise(g, l, mono).mark?.kind).toBe('no-event');
    // a field joined at the gateway today is a direct call when co-located (no hop)
    const f = m.sites.find((s) => s.kind === 'field' && s.today === 'join')!;
    const fl = g.links(m.seffs.find((s) => s.parts.some((p) => p.site === f.id))!.id).find((x) => x.site?.id === f.id)!;
    expect(realise(g, fl, todayPlacement(m)).text).toMatch(/gateway join/);
    expect(realise(g, fl, todayPlacement(m)).together).toBe(false);
    expect(realise(g, fl, mono).text).toMatch(/calls it directly/);
    expect(realise(g, fl, mono).together).toBe(true);
  });

  it('names no realisation "local": a placement is no hop or remote, a mechanism only the site\'s', () => {
    const mono: Placement = { label: 'one service', design: true, serviceOf: () => ({ id: 's', name: 's' }), mech: (s) => s.today };
    for (const pl of [todayPlacement(m), mono]) for (const s of m.seffs) for (const l of g.links(s.id)) {
      const r = realise(g, l, pl);
      if (!r) continue; // a step form's `work` link: no realisation of its own
      expect(r.text, l.key).not.toMatch(/\blocal\b(?! copy)/);
      expect(r.mech, l.key).not.toBe('local');
      for (const x of r.allowed) expect(x, l.key).not.toBe('local');
    }
  });

  it('finds the copy feeds a write causes when the reader keeps a copy apart', () => {
    const s = m.sites.find((x) => x.copyFeed?.writers.length)!;
    const w = s.copyFeed!.writers[0];
    const reader = m.operations.find((o) => o.id === s.op)!;
    const apart: Placement = { label: 'x', design: true, serviceOf: (c) => (c === reader.homeClass ? { id: 'r', name: 'r' } : { id: 'o', name: 'o' }), mech: (x) => (x.id === s.id ? 'copy' : 'sync') };
    expect(feedsInPlacement(g, w.op, s.class!, apart).map((x) => x.site.id)).toContain(s.id);
    const together: Placement = { ...apart, serviceOf: () => ({ id: 'one', name: 'one' }) };
    expect(feedsInPlacement(g, w.op, s.class!, together)).toEqual([]);
  });
});
