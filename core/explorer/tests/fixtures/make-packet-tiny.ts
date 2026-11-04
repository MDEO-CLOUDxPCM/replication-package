/**
 * Writes the tiny test packet tests/fixtures/packet-tiny/ (committed; run again only to change it):
 *
 *   tsx tests/fixtures/make-packet-tiny.ts
 *
 * A made-up bookshop (six classes, six operations, two session types) with one run of a few designs from the dummy
 * search (dummy/): three objectives, one constraint, two references, one precomputed detail. Its packet.json has
 * no family, no sources and no commands, its own vocabulary, texts and metric docs, and one recorded input
 * (inputs/shop.md) for the staleness tests. Nothing in it belongs to any real case: the generic explorer must work
 * with it alone (tests/packet-fixture.test.ts).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Design, Domain, Generation, Run } from '../../contract/types';
import { CONTRACT_VERSION } from '../../contract/types';
import type { PacketManifest } from '../../contract/packet';
import { ranks } from '../../contract/pareto';
import { demands, requestNoLoad } from '../../dummy/model';
import { mulberry32, nsga2, Search, type Individual } from '../../dummy/search';
import { simulate } from '../../dummy/simulate';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'packet-tiny');
const ID = 'bookshop';
const RUN = 'bookshop-static';
const AT = '2026-10-30T12:00:00Z';

const cls = (id: string, aggregate: string, attributes: string[], description: string) => ({ id, name: id, aggregate, attributes, description });
const domain: Domain = {
  contract: CONTRACT_VERSION, id: ID, name: 'Bookshop', version: '1', source: 'made up for the tests (tests/fixtures/make-packet-tiny.ts)',
  classes: [
    cls('Book', 'Book', ['title', 'isbn', 'price'], 'a title on sale'),
    cls('Author', 'Author', ['name'], 'who wrote a book'),
    cls('Customer', 'Customer', ['email', 'points'], 'a registered buyer'),
    cls('Basket', 'Basket', ['items'], 'the books a customer is about to buy'),
    cls('Purchase', 'Purchase', ['placedAt', 'total'], 'a placed purchase'),
    cls('PurchaseLine', 'Purchase', ['quantity'], 'one book of a purchase'),
  ],
  references: [
    { id: 'r1', from: 'PurchaseLine', to: 'Purchase', name: 'purchase', kind: 'composition', multiplicity: '1' },
    { id: 'r2', from: 'PurchaseLine', to: 'Book', name: 'book', kind: 'association', multiplicity: '1' },
    { id: 'r3', from: 'Book', to: 'Author', name: 'authors', kind: 'association', multiplicity: '1..*' },
    { id: 'r4', from: 'Basket', to: 'Customer', name: 'owner', kind: 'association', multiplicity: '1' },
    { id: 'r5', from: 'Basket', to: 'Book', name: 'books', kind: 'association', multiplicity: '*' },
    { id: 'r6', from: 'Purchase', to: 'Customer', name: 'buyer', kind: 'association', multiplicity: '1' },
  ],
  aggregates: [
    { id: 'Book', name: 'Book', root: 'Book', classes: ['Book'] },
    { id: 'Author', name: 'Author', root: 'Author', classes: ['Author'] },
    { id: 'Customer', name: 'Customer', root: 'Customer', classes: ['Customer'] },
    { id: 'Basket', name: 'Basket', root: 'Basket', classes: ['Basket'] },
    { id: 'Purchase', name: 'Purchase', root: 'Purchase', classes: ['Purchase', 'PurchaseLine'] },
  ],
  operations: [
    { id: 'browseBooks', name: 'browseBooks', kind: 'query', feature: 'shelf', homeClass: 'Book', rate: 40, cpuMs: 1.2, dbMs: 0.8, accesses: [{ class: 'Book', mode: 'read', perExecution: 20 }, { class: 'Author', mode: 'read', perExecution: 20 }] },
    { id: 'bookDetail', name: 'bookDetail', kind: 'query', feature: 'shelf', homeClass: 'Book', rate: 30, cpuMs: 0.8, dbMs: 0.4, accesses: [{ class: 'Book', mode: 'read' }, { class: 'Author', mode: 'read' }] },
    { id: 'addBook', name: 'addBook', kind: 'mutation', feature: 'shelf', homeClass: 'Book', rate: 0.1, cpuMs: 1, dbMs: 1, accesses: [{ class: 'Book', mode: 'write' }, { class: 'Author', mode: 'read' }] },
    { id: 'addToBasket', name: 'addToBasket', kind: 'mutation', feature: 'buy', homeClass: 'Basket', rate: 8, cpuMs: 0.9, dbMs: 0.6, accesses: [{ class: 'Basket', mode: 'write' }, { class: 'Book', mode: 'read' }] },
    { id: 'checkout', name: 'checkout', kind: 'mutation', feature: 'buy', homeClass: 'Purchase', rate: 3, cpuMs: 2, dbMs: 1.5, publishes: ['purchasePlaced'],
      accesses: [{ class: 'Purchase', mode: 'write' }, { class: 'PurchaseLine', mode: 'write', perExecution: 2, joined: true }, { class: 'Basket', mode: 'write' }, { class: 'Book', mode: 'read', perExecution: 2, level: 'strict' }, { class: 'Customer', mode: 'read' }] },
    { id: 'onPurchasePlaced', name: 'onPurchasePlaced', kind: 'handler', feature: 'buy', homeClass: 'Customer', trigger: 'purchasePlaced', rate: 3, cpuMs: 0.5, dbMs: 0.5, accesses: [{ class: 'Customer', mode: 'write' }] },
  ],
  events: [{ id: 'purchasePlaced', name: 'purchasePlaced', publishers: ['checkout'], subscribers: ['onPurchasePlaced'], class: 'Purchase' }],
  features: [
    { id: 'shelf', code: 'S', name: 'Shelf', operations: ['browseBooks', 'bookDetail', 'addBook'] },
    { id: 'buy', code: 'B', name: 'Buying', operations: ['addToBasket', 'checkout', 'onPurchasePlaced'] },
  ],
  processes: [{ id: 'Checkout', name: 'Checkout', trigger: 'checkout', steps: ['checkout', 'onPurchasePlaced'] }],
  requests: [
    { id: 'shelf', name: 'shelf', operations: ['browseBooks'], rate: 40 },
    { id: 'book', name: 'book', operations: ['bookDetail'], rate: 30 },
    { id: 'basket', name: 'basket', operations: ['addToBasket'], rate: 8 },
    { id: 'pay', name: 'pay', operations: ['checkout'], rate: 3 },
    { id: 'newBook', name: 'newBook', operations: ['addBook'], rate: 0.1 },
  ],
  sessions: [
    { id: 'browser', name: 'Browser', description: 'looks at books', share: 0.7, thinkTimeS: 4, steps: [{ request: 'shelf' }, { request: 'book', repeat: 3 }] },
    { id: 'buyer', name: 'Buyer', description: 'buys a book or two', share: 0.3, thinkTimeS: 6, steps: [{ request: 'shelf' }, { request: 'book' }, { request: 'basket', repeat: 2 }, { request: 'pay' }] },
    { id: 'clerk', name: 'Clerk', description: 'adds books', share: 0, thinkTimeS: 20, steps: [{ request: 'newBook' }] },
  ],
  cuts: [
    { id: 'three', name: 'three services', services: [{ name: 'shelf', classes: ['Book', 'Author'] }, { name: 'customers', classes: ['Customer', 'Basket'] }, { name: 'purchases', classes: ['Purchase', 'PurchaseLine'] }] },
    { id: 'monolith', name: 'monolith', services: [{ name: 'shop', classes: ['Book', 'Author', 'Customer', 'Basket', 'Purchase', 'PurchaseLine'] }] },
  ],
};

// latency budgets: 1.5 x the first cut's no-load time (as dummy/generate.ts)
{
  const s = new Search(domain, 'static', mulberry32(3));
  const dem = demands(domain, s.evaluate(s.fromCut(domain.cuts![0].services), 0).decisions);
  for (const rq of domain.requests) rq.budgetMs = Math.max(5, Math.round(1.5 * requestNoLoad(rq, dem)));
}

// the run: a small NSGA-II of the dummy model; objectives cost, failures, inconsistency; constraint latency budget
const PICK_O = [0, 1, 3];
const objectives: Run['objectives'] = [
  { key: 'cost', label: 'Cost', unit: 'cores', direction: 'minimize', digits: 1 },
  { key: 'failure', label: 'Failures', unit: 'ppm', direction: 'minimize', digits: 0 },
  { key: 'inconsistency', label: 'Inconsistency', direction: 'minimize', digits: 3 },
];
const constraints: Run['constraints'] = [{ key: 'latencyBudget', label: 'Latency budget' }];
const o = (i: Individual) => PICK_O.map((k) => +i.eval.objectives[k].toPrecision(5));
const c = (i: Individual) => [+i.eval.constraints[0].toPrecision(4)];
const search = new Search(domain, 'static', mulberry32(7));
const refs = domain.cuts!.map((cut) => ({ ind: search.evaluate(search.fromCut(cut.services), 0), label: cut.name }));
const res = nsga2(search, 8, 4, refs.map((r) => r.ind));
const last = res.generations.at(-1)!.population;
const chosen = new Map<string, { ind: Individual; label?: string }>();
for (const r of refs) chosen.set(r.ind.hash, { ind: r.ind, label: r.label });
for (const i of last) if (chosen.size < 7 && !chosen.has(i.hash)) chosen.set(i.hash, { ind: i });
// and one the search left behind (dominated)
const behind = res.evaluated.find((i) => !chosen.has(i.hash) && !last.some((x) => x.hash === i.hash) && last.some((x) => PICK_O.every((k) => x.eval.objectives[k] <= i.eval.objectives[k])));
if (behind) chosen.set(behind.hash, { ind: behind });
const list = [...chosen.values()];
const feasibleOf = (i: Individual) => c(i)[0] <= 1e-12;
const feas = list.filter((x) => feasibleOf(x.ind));
const rk = ranks(feas.map((x) => o(x.ind)));
const rankOf = new Map(feas.map((x, k) => [x.ind.hash, rk[k]]));
const designs: Design[] = list.map(({ ind, label }) => ({
  id: ind.hash, runId: RUN, hash: ind.hash, label,
  objectives: o(ind), constraints: c(ind), feasible: feasibleOf(ind), rank: rankOf.get(ind.hash) ?? null,
  born: ind.born, inFinalPopulation: last.some((x) => x.hash === ind.hash), reference: label ? true : undefined,
  metrics: { services: ind.decisions.services.length, databases: ind.decisions.databases.length },
  hasDetail: false, hasDecisions: true, decisions: ind.decisions,
}));
// one precomputed detail: the first reference
const withDetail = designs[0];
withDetail.hasDetail = true;
const detail = simulate(domain, withDetail.decisions!, 'static', { designId: withDetail.id, runId: RUN, origin: 'precomputed' });
// keep the fixture small: no per-bin series of the operations
detail.operations = detail.operations.map(({ overTime: _ot, ...r }) => r);
detail.computedAt = AT;
delete detail.computeMs;

const history: Generation[] = res.generations.map((g, index) => ({ index, evaluated: g.evaluated, population: g.population.map((i) => ({ o: o(i), c: c(i), ...(chosen.has(i.hash) ? { d: i.hash } : {}) })) }));
const run: Run = {
  contract: CONTRACT_VERSION, id: RUN, name: 'Bookshop cut search', description: 'a small synthetic run of the dummy search over the bookshop',
  source: { kind: 'bundle', location: 'tests/fixtures/packet-tiny', synthetic: true },
  problem: 'static', domainId: ID, algorithm: 'NSGA-II', status: 'completed', createdAt: AT, finishedAt: '2026-10-30T12:01:00Z', durationMs: 60000,
  populationSize: 8, generations: history.length, evaluated: res.evaluated.length, designCount: designs.length,
  objectives, constraints, metrics: [{ key: 'services', label: 'Services', better: 'none', digits: 0 }, { key: 'databases', label: 'Databases', better: 'none', digits: 0 }],
  tags: ['synthetic', 'fixture'],
  config: { populationSize: 8, generations: history.length, operators: [{ name: 'move-class' }, { name: 'change-mechanism' }], mutationSteps: 'interval(1, 3)', crossover: null, randomSeed: 7 },
  history,
  finalPopulation: last.filter((i) => chosen.has(i.hash)).map((i) => i.hash),
  references: refs.map((r) => ({ designId: r.ind.hash, label: r.label })),
};

// docs: texts of its own and a metric doc per objective and the constraint
const texts: Record<string, string> = {
  'fixture.title': 'The **bookshop**',
  'fixture.summary': '{{classes}} classes in {{services}} services{{#note}} ({{note}}){{/note}}{{^note}}, nothing to note{{/note}}.',
  'fixture.empty': '',
  // (AB59) the placement badge's explanation, the packet's own words
  'placement.noHop': 'both in one shop process: no network',
};
const metricDoc = (key: string, title: string, code: string, kind: string, direction: string, summary: string, unit?: string) => ({
  key, title, code, kind, direction, summary, ...(unit ? { unit } : {}), inputs: ['the design\'s services and mechanisms'], cite: ['dummy/model.ts evaluate'], origin: 'made up for the test fixture',
});
const metrics = [
  metricDoc('cost', 'Shop cost', 'O1', 'objective', 'minimised', 'Cores the shop needs: replicas, databases and the `gateway`.', 'cores'),
  metricDoc('failure', 'Failures', 'O2', 'objective', 'minimised', 'Failed requests per million: services and databases on the path share their fate.', 'ppm'),
  metricDoc('inconsistency', 'Inconsistency', 'O3', 'objective', 'minimised', 'Stale reads and remote writes per request.'),
  metricDoc('latencyBudget', 'Latency budget', 'C1', 'constraint', 'a violation (0 = met)', 'How far the no-load times exceed their budgets.'),
];
const docs = { texts, metrics };

const writeJson = (f: string, data: unknown, compact = false) => {
  fs.mkdirSync(path.dirname(path.join(OUT, f)), { recursive: true });
  fs.writeFileSync(path.join(OUT, f), JSON.stringify(data, null, compact ? undefined : 1) + '\n');
};
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'inputs'), { recursive: true });
const input = '# The bookshop\n\nSix classes: books and their authors, customers with baskets, purchases with their lines.\n';
fs.writeFileSync(path.join(OUT, 'inputs/shop.md'), input);
const inputHash = crypto.createHash('sha256').update(input).digest('hex');
writeJson(`domains/${ID}.json`, domain);
writeJson(`runs/${RUN}/run.json`, run);
writeJson(`runs/${RUN}/designs.json`, { contract: CONTRACT_VERSION, runId: RUN, designs });
writeJson(`runs/${RUN}/details/${withDetail.hash}.json`, detail, true);
for (const [name, data] of Object.entries(docs)) writeJson(`docs/${name}.json`, data);
const vocab = (id: string, label: string, about: string, short?: string) => ({ id, label, about, ...(short ? { short } : {}) });
const manifest: PacketManifest = {
  contract: CONTRACT_VERSION, id: ID, name: 'Bookshop', description: 'a tiny made-up shop: the generic explorer without any case',
  domains: [ID], builtAt: AT, builtBy: 'tsx tests/fixtures/make-packet-tiny.ts',
  fingerprint: inputHash.slice(0, 16),
  inputs: [{ label: 'the shop description', path: 'inputs/shop.md', hash: inputHash.slice(0, 16) }],
  objectives: objectives.map((x, i) => ({ key: x.key, label: metrics[i].title, code: metrics[i].code, ...(x.unit ? { unit: x.unit } : {}), direction: 'minimize', digits: x.digits })),
  constraints: [{ key: 'latencyBudget', label: 'Latency budget', code: 'C1', direction: 'violation' }],
  vocabulary: {
    mechanisms: [vocab('sync', 'Remote call', 'a call to the owning service', 'call'), vocab('copy', 'Local copy', 'a copy fed by events', 'copy'), vocab('saga', 'Saga step', 'a write done as a saga step')],
    styles: [vocab('choreography', 'Choreography', 'the services react to events'), vocab('orchestration', 'Orchestration', 'one service drives the steps')],
    operationKinds: [vocab('query', 'Look-up', 'reads only'), vocab('mutation', 'Change', 'writes'), vocab('handler', 'Reaction', 'runs on an event')],
  },
  docs: { texts: 'docs/texts.json', metrics: 'docs/metrics.json' },
  capabilities: { model: false, verify: false, performance: true, simulate: false },
};
writeJson('packet.json', manifest);
const size = (d: string): number => fs.readdirSync(d, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? size(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
console.log(`${OUT}: ${designs.length} designs (${designs.filter((d) => d.rank === 0).length} on the front), detail ${withDetail.hash}; ${(size(OUT) / 1024).toFixed(1)} kB`);
