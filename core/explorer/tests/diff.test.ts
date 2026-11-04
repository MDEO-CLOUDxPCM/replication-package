import { describe, expect, it } from 'vitest';
import { diffDesigns } from '../contract/diff';
import { deriveDesign } from '../contract/derive';
import type { Decisions, Domain } from '../contract/types';

const domain: Domain = {
  contract: '0.1.0', id: 't', name: 't', version: '1', source: 'test',
  classes: ['Order', 'OrderItem', 'Product', 'Payment'].map((id) => ({ id, name: id })),
  references: [{ id: 'r1', from: 'OrderItem', to: 'Product', kind: 'association' }],
  aggregates: [],
  operations: [
    { id: 'createOrder', name: 'createOrder', kind: 'mutation', homeClass: 'Order', rate: 10, accesses: [{ class: 'Order', mode: 'write' }, { class: 'OrderItem', mode: 'write' }, { class: 'Product', mode: 'read' }] },
    { id: 'pay', name: 'pay', kind: 'handler', homeClass: 'Payment', rate: 5, accesses: [{ class: 'Payment', mode: 'write' }, { class: 'Order', mode: 'write' }] },
  ],
  events: [], features: [], processes: [{ id: 'Buy', name: 'Buy', trigger: 'createOrder', steps: ['createOrder', 'pay'] }], requests: [], sessions: [],
};

const base = (): Decisions => ({
  services: [
    { id: 'a', name: 'order', classes: ['Order', 'OrderItem'], replicas: { mode: 'fixed', count: 1 }, database: 'd1' },
    { id: 'b', name: 'catalog', classes: ['Product'], replicas: { mode: 'fixed', count: 1 }, database: 'd2' },
    { id: 'c', name: 'payment', classes: ['Payment'], replicas: { mode: 'fixed', count: 1 }, database: 'd3' },
  ],
  mechanisms: { 'createOrder|Product|read': 'sync', 'pay|Order|write': 'saga' },
  sagas: [{ process: 'Buy', style: 'choreography' }],
  databases: [{ id: 'd1', name: '1', placement: 'own', services: ['a'] }, { id: 'd2', name: '2', placement: 'own', services: ['b'] }, { id: 'd3', name: '3', placement: 'own', services: ['c'] }],
});

describe('derive', () => {
  it('accesses within a service have no mechanism (no `local`), cross ones take the decided mechanism', () => {
    const d = deriveDesign(domain, base());
    const m = Object.fromEntries(d.accesses.map((a) => [a.key, a.mechanism]));
    expect(m['createOrder|Order|write']).toBeNull();
    expect(Object.values(m)).not.toContain('local');
    expect(Object.keys(d.mechanismCounts)).not.toContain('local');
    expect(m['createOrder|Product|read']).toBe('sync');
    expect(m['pay|Order|write']).toBe('saga');
    expect(d.sagas.map((s) => s.process)).toEqual(['Buy']);
    expect(d.edges.some((e) => e.kind === 'access' && e.source === 'Order' && e.target === 'Product' && e.mechanism === 'sync')).toBe(true);
  });
  it('a transaction workflow is a saga only while a written class sits in another service', () => {
    const tx: Domain = { ...domain, processes: [...domain.processes, { id: 'tx_Order', name: 'createOrder (transaction)', trigger: 'createOrder', steps: [], transaction: { writes: ['OrderItem'] } }] };
    expect(deriveDesign(tx, base()).sagas.map((s) => s.process)).toEqual(['Buy']);
    const apart = base();
    apart.services[0].classes = ['Order'];
    apart.services[1].classes = ['Product', 'OrderItem'];
    apart.sagas.push({ process: 'tx_Order', style: 'orchestration', orchestrator: 'a' });
    expect(deriveDesign(tx, apart).sagas.find((s) => s.process === 'tx_Order')).toEqual({ process: 'tx_Order', style: 'orchestration', services: ['a', 'b'], orchestrator: 'a' });
  });
});

describe('effect steps', () => {
  // pay reacts to createOrder's event: an effect step at Payment; createOrder writes OrderItem: one at OrderItem
  const fx: Domain = {
    ...domain,
    operations: [...domain.operations, { id: 'onCreated', name: 'onCreated', kind: 'handler', homeClass: 'Payment', rate: 10, accesses: [{ class: 'Payment', mode: 'write' }] }],
    events: [{ id: 'created', name: 'created', publishers: ['createOrder'], subscribers: ['onCreated'] }],
    effectSites: [
      { id: 's_item', op: 'createOrder', kind: 'write', class: 'OrderItem', allowed: ['sync', 'async', 'inTx'], callerClass: 'Order', callerSchema: 'Order', providerSchema: 'OrderItem' },
      { id: 's_ev', op: 'createOrder', kind: 'event', class: 'Payment', callee: 'onCreated', event: 'created', allowed: ['async', 'sync', 'inTx'], callerClass: 'Order' },
    ],
  };
  it('derives the steps with their state; an event step that is no message is drawn as a sync call', () => {
    const d = base();
    d.effects = { s_item: { m: 'inTx', joined: true, together: true }, s_ev: { m: 'inTx', why: 'apart' } };
    const x = deriveDesign(fx, d);
    expect(x.effects.map((e) => [e.id, e.from, e.to, !!e.state.joined])).toEqual([['s_item', 'a', 'a', true], ['s_ev', 'a', 'c', false]]);
    expect(x.edges.some((e) => e.kind === 'event')).toBe(false);
    expect(x.edges.some((e) => e.id.startsWith('step:') && e.mechanism === 'sync' && e.target === 'Payment')).toBe(true);
    d.effects.s_ev = { m: 'async', why: 'chosen' };
    expect(deriveDesign(fx, d).edges.some((e) => e.kind === 'event' && e.target === 'Payment')).toBe(true);
  });
  it('diffs mechanism and joining, not the reason alone', () => {
    const A = base(), B = base(), C = base();
    A.effects = { s_item: { m: 'inTx', joined: true, together: true }, s_ev: { m: 'async', why: 'chosen' } };
    B.effects = { s_item: { m: 'inTx', why: 'servers', together: true }, s_ev: { m: 'async', why: 'chosen' } };
    C.effects = { s_item: { m: 'inTx', joined: true, together: true }, s_ev: { m: 'async', why: 'chosen', together: true } };
    expect(diffDesigns(fx, A, B).effectChanges.map((c) => [c.site, !!c.a.joined, !!c.b.joined])).toEqual([['s_item', true, false]]);
    expect(diffDesigns(fx, A, C).effectChanges).toEqual([]);
  });
});

describe('diff', () => {
  it('matches renamed services and finds moved classes, mechanism and style changes', () => {
    const A = base();
    const B = base();
    B.services = [
      { id: 'x', name: 'renamed order', classes: ['Order', 'OrderItem', 'Payment'], replicas: { mode: 'fixed', count: 3 }, database: 'd1' },
      { id: 'y', name: 'catalog', classes: ['Product'], replicas: { mode: 'fixed', count: 1 }, database: 'd2' },
    ];
    B.databases = [{ id: 'd1', name: '1', placement: 'own', services: ['x'] }, { id: 'd2', name: '2', placement: 'own', services: ['y'] }];
    B.mechanisms = { 'createOrder|Product|read': 'copy' };
    const d = diffDesigns(domain, A, B);
    expect(d.aToB.get('a')).toBe('x');
    expect(d.aToB.get('b')).toBe('y');
    expect(d.movedClasses).toEqual([{ cls: 'Payment', fromA: 'c', toB: 'x' }]);
    expect(d.mechanismChanges.map((c) => [c.key, c.a, c.b])).toEqual([
      ['createOrder|Product|read', 'sync', 'copy'],
      ['pay|Order|write', 'saga', null],
    ]);
    expect(d.sagaChanges).toEqual([{ process: 'Buy', a: 'choreography', b: null }]);
    expect(d.replicaChanges.map((r) => r.a)).toEqual(['a']);
    expect(d.matches.find((m) => m.a === 'c')?.b).toBeNull();
  });

  it('an identical design has no differences', () => {
    const d = diffDesigns(domain, base(), base());
    expect(d.movedClasses).toEqual([]);
    expect(d.mechanismChanges).toEqual([]);
  });
});
