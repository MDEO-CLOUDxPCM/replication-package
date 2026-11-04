// The consistency levels (docs/model.md, Call sites) in the built packet (pnpm packet:misarch): every read of the input model
// carries the model's level with the curated rules and reasons of its statements at that level (package A's
// `consistency`, curated/consistency.yaml), a call its level, an effect call E1; the sites agree with the levels;
// the docs and texts do not say "strong". Skipped while the packet is not built.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { InputModel, ModelOperation } from '../../../../core/explorer/contract/types';
import { callConsistency, readConsistency } from '../../../../core/explorer/contract/consistency';
import { files, packet } from '../config';
import { loadDocs } from '../docs';

const OUT = packet.out;
const have = fs.existsSync(path.join(OUT, 'packet.json'));
const json = <T>(f: string): T => JSON.parse(fs.readFileSync(path.join(OUT, f), 'utf8')) as T;

describe.skipIf(!have)('consistency levels of the built packet', () => {
  const model = have ? json<InputModel>(`models/${packet.domainId}.json`) : (null as never);
  const A = JSON.parse(fs.readFileSync(files.extraction, 'utf8'));
  const ops = new Map<string, ModelOperation>(have ? model.operations.map((o) => [o.id, o]) : []);
  const aOp = (id: string) => A.operations.find((o: { id: string }) => o.id === id);

  it('a level on every read and call, none on a write; the curated texts', () => {
    for (const o of model.operations) {
      for (const a of o.accesses) {
        if (a.mode === 'write') expect(a.level, `${o.id} ${a.class}`).toBeUndefined();
        else expect(['strict', 'stale-ok', 'immutable'], `${o.id} ${a.class}`).toContain(a.level);
        expect((a as { strong?: boolean }).strong, `${o.id} ${a.class}`).toBeUndefined();
        for (const r of a.rules ?? []) expect(model.consistency!.rules[r], `${o.id} ${a.class} ${r}`).toBeDefined();
      }
      for (const c of o.calls) expect(c.level, `${o.id} → ${c.callee}`).toBeDefined();
    }
    expect(Object.keys(model.consistency!.rules)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'E1', 'R1', 'R2', 'R3', 'I1']);
    expect(Object.keys(model.consistency!.levels)).toEqual(['strict', 'stale-ok', 'immutable']);
  });

  it('carries the curated rules and reason of the statements at the level (hand-checked against misarch-domain.json)', () => {
    // createOrder's User read: one statement, immutable (I1), today from order's copy
    const co = ops.get('order.createOrder')!;
    const user = aOp('order.createOrder').accesses.filter((x: { class: string; mode: string }) => x.class === 'User' && x.mode === 'read');
    expect(user).toHaveLength(1);
    expect(co.accesses.find((a) => a.class === 'User' && a.mode === 'read')).toMatchObject({ level: 'immutable', rules: ['I1'], reason: user[0].consistency.reason, local: false });
    // no re-read of the order it inserted (misarch-kotlin d569ad9)
    expect(co.accesses.find((a) => a.class === 'Order' && a.mode === 'read')).toBeUndefined();
    // its calls: the cart (S20) strict S6 without a site, the others stale-ok with a site sync / cache
    expect(callConsistency(co, 'shoppingcart._entities.User')).toMatchObject({ level: 'strict', rules: ['S6'] });
    expect(callConsistency(co, 'discount.findApplicableDiscounts')).toMatchObject({ level: 'stale-ok', rules: ['R1', 'R2', 'I1'] });
    const sites = model.sites.filter((s) => s.op === 'order.createOrder' && s.kind === 'call' && (!s.home || s.home.written));
    expect(sites.map((s) => s.callee).sort()).toEqual(['discount.findApplicableDiscounts', 'inventory._entities.ProductVariant', 'shipment.calculateShipmentFees']);
    for (const s of sites) expect(s.allowed).toEqual(['sync', 'cache']);
    // S20's nested fields: strict as the call, its rules and reason
    const nested = ops.get('shoppingcart._entities.User')!.calls.find((c) => c.callee === 'shoppingcart.User.shoppingcart')!;
    expect(nested).toMatchObject({ level: 'strict', rules: ['S6'], nestedIn: 'order.createOrder' });
    // createReturn's split: the fields immutable, the reference strict; the reference (its own column returnedWithId)
    // is return's own data, a read of its home Return, and the copy read of OrderItem immutable
    const cr = ops.get('return.createReturn')!;
    expect(cr.accesses.filter((a) => a.class === 'OrderItem' && a.mode === 'read').map((a) => [a.via ?? '', a.level, a.rules])).toEqual([['', 'immutable', ['I1']]]);
    expect(readConsistency(cr, 'OrderItem')).toMatchObject({ level: 'immutable', rules: ['I1'] });
    expect(cr.accesses.find((a) => a.class === 'Return' && a.mode === 'read')).toMatchObject({ level: 'strict', rules: ['S1'], local: true });
    // createShoppingcartItem's cart lock: a strict read of another class (its home is ShoppingCartItem)
    expect(ops.get('shoppingcart.createShoppingcartItem')!.accesses.find((a) => a.class === 'ShoppingCart' && a.mode === 'read')).toMatchObject({ level: 'strict', rules: ['S5'], lock: true, local: false });
    // the effect calls: the four provider registrations, E1
    const eff = model.operations.filter((o) => o.effectCalls?.length).map((o) => [o.id, o.effectCalls!.map((e) => `${e.to} ${e.rules.join(',')}`)]);
    expect(eff).toEqual([
      ['payment.http:/payment/update-payment-status', ['simulation.payment.register E1']],
      ['payment.on:discount/order/validation-succeeded', ['simulation.payment.register E1']],
      ['shipment.on:payment/payment/payment-enabled', ['simulation.shipment.register E1']],
      ['shipment.on:return/return/created', ['simulation.shipment.register E1']],
    ]);
  });

  it('the sites follow the levels: strict no site (the strict copy reads are own data), others a cache', () => {
    for (const s of model.sites) {
      const o = s.op ? ops.get(s.op) : undefined;
      if (s.kind === 'access' && s.mode === 'read') {
        const c = readConsistency(o, s.class)!;
        expect(c.level, s.id).not.toBe('strict');
        expect(s.allowed, s.id).toContain('cache');
      }
      if (s.kind === 'call') expect(callConsistency(o, s.callee)?.level, s.id).not.toBe('strict');
    }
    // a read of another class without a site is strict
    for (const o of model.operations) for (const cls of new Set(o.accesses.filter((a) => a.mode === 'read' && !a.local).map((a) => a.class))) {
      const c = readConsistency(o, cls)!;
      const has = model.sites.some((s) => s.op === o.id && s.kind === 'access' && s.mode === 'read' && s.class === cls);
      if (!has) expect(c.level, `${o.id} ${cls}`).toBe('strict');
    }
  });

  it('the docs and texts say strict, not strong', async () => {
    const { docs, texts } = await loadDocs();
    const all = JSON.stringify({ docs, texts });
    expect(all).not.toMatch(/\bstrong\b/i);
    expect(texts['model.realise.strictCall']).toMatch(/strict: sync only/);
  });
});
