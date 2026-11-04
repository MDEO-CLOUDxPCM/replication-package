/**
 * The Verify tab's parts: the model of MiSArch split into units that can be checked one at a time against
 * misarch-kotlin. Each part lists its claims (facts and tables of rows), each claim with the evidence (`path:line` at
 * the extraction's commit) it was extracted from, and the documents to read it against (the federation schema, the
 * port spec, the fix notes, the curated facts). The domain parts come from package A's extraction (every class,
 * reference, operation, event, join, saga) and the input model where it adds the derivation (home class, call sites,
 * bindings, accesses as modelled, request plans, SEFFs); coverage.ts maps misarch-kotlin's inventories to them,
 * features.ts and workload.ts add the features, the workload, the timings and the parameters.
 *
 * A part's fingerprint covers its claims (not rates or reach): a mark made on another fingerprint shows as changed.
 */
import type { InputModel, ModelOperation } from '../../../../core/explorer/contract/types';
import { chip, code, esc, FP_AS, gqlField, gqlType, join, LATE_GROUPS, makeCtx, num, OP_SCOPE, opKey, PART_KINDS, parseEvidence, part, short, TREE, val, type Inputs, type Part, type Table, type Tok } from './claims';

/** package A's reach `local` (its own service's database) in the explorer's words */
const reach = (x: string) => (x === 'local' ? 'own service' : x);
/** a table fingerprinted as `before`, its older spelling (the claims are the same): the marks on its part stay */
const asBefore = (t: Table, before: Table): Table => { FP_AS.set(t, before); return t; };
/**
 * a read's or call's consistency level as a chip: the level and its rule ids (strict warn, immutable
 * ok); a lock read and an effect call marked. Tables with a level column are fingerprinted in the older spelling
 * (column `strong` and its cell) except on the rows that carry a level: their claims (a level, rules and a reason to
 * check) are not the older spelling's, so they have fingerprints of their own.
 */
const levelChip = (c: { level: string; rules?: string[] }): Tok => chip(`${c.level}${c.rules?.length ? ` · ${c.rules.join(', ')}` : ''}`, c.level === 'strict' ? 'warn' : c.level === 'immutable' ? 'ok' : 'muted');
const curatedNote = (c?: { level: string; rules?: string[]; reason?: string }) => (c?.reason ? `${c.level} (${(c.rules ?? []).join(', ')}): ${c.reason}` : undefined);
/** a request plan entry's `via` (contract PlanVia) as the explorer names it */
const PLAN_VIA_WORDS: Record<string, string> = { root: 'root resolver', service: "parent's service", gateway: 'gateway fetch' };
import { coverageParts } from './coverage';
import type { AAccess } from './extraction';
import { featureParts } from './features';
import { paramParts, timingParts, workloadParts } from './workload';
import { files } from '../config';

export * from './claims';

export function buildParts(inputs: Inputs): Part[] {
  const ctx = makeCtx(inputs);
  const { a, model, has, ops, mops, scopeOf, classSvc, features, pms, eventTopics, opLink, clsLink, topicLink, listToks, docs, out, add } = ctx;
  void eventTopics;

  // ------------------------------------------------------------------ classes
  for (const c of a.classes) {
    const refs = a.references.filter((r) => r.from === c.name || r.to === c.name);
    const copies = a.copies.filter((x) => c.name in x.copyOf);
    const gw = a.gatewayJoins.filter((g) => g.entity === c.name);
    const mc = model?.classes.find((x) => x.id === c.name);
    const homeOps = (model?.operations ?? []).filter((o) => o.homeClass === c.name);
    const accessedBy = a.operations.filter((o) => o.accesses.some((x) => x.class === c.name));
    add({
      key: `class:${c.name}`, kind: 'class', group: c.service, title: c.name, subtitle: c.table ?? c.storage,
      facts: [
        { label: "today's service", value: [c.service] },
        { label: 'storage', value: [c.table ? code(c.table) : c.storage, c.table ? ` (${c.storage})` : ''], ev: parseEvidence(c.evidence, 'table') },
        { label: 'attributes', value: listToks(c.attributes.map(code)) },
        ...(c.columns !== undefined ? [{ label: 'columns, row', value: [`${c.columns} columns, ${c.rowBytes ?? '?'} bytes per row`] }] : []),
        ...(c.discriminator ? [{ label: 'discriminator', value: [String(c.discriminator)] }] : []),
        ...(c.sharedTable ? [{ label: 'shared table', value: [String(c.sharedTable)] }] : []),
        ...(c.note ? [{ label: 'note', value: [c.note] }] : []),
        ...(mc?.placement?.today ? [{ label: 'model (today)', value: [`component in ${mc.placement.today.container}, schema on ${mc.placement.today.server}`] }] : []),
        ...a.msaMapping.entities.filter((e) => e.classes.includes(c.name)).map((e) => ({ label: 'msa entity', value: [`${e.msa} (${e.sizeKb} kB per instance in the msa model)`, e.classes.length > 1 ? `, with ${e.classes.filter((x) => x !== c.name).join(', ')}` : ''] })),
        { label: 'accessed by', value: [`${accessedBy.length} operations (${accessedBy.filter((o) => o.accesses.some((x) => x.class === c.name && x.mode === 'write')).length} write it)`] },
      ],
      tables: [
        { title: 'References', columns: ['reference', 'from → to', 'kind', 'mult.', 'storage'], rows: refs.map((r) => ({
          cells: [[part(`ref:${r.id}`, r.id)], [clsLink(r.from), ' → ', clsLink(r.to)], [r.kind], [r.mult], [r.storage, r.crossServiceToday ? chip('cross-service', 'warn') : '']],
          ev: parseEvidence(r.evidence), note: r.note })) },
        { title: 'Local copies in other services', hint: 'copy tables (mechanism instances of today\'s cut) and what feeds them', columns: ['copy table', 'attributes', 'fed by', 'written by', 'read by'], rows: copies.map((x) => ({
          cells: [[code(`${x.service}.${x.table}`)], listToks((x.copyOf[c.name] ?? []).map(code)), listToks(x.fedBy.map(topicLink)), listToks(x.writers.map(opLink)), listToks(x.readers.map(opLink))],
          ev: parseEvidence(x.evidence), note: x.note })) },
        { title: 'Federation', hint: 'other subgraphs that contribute fields to the entity (resolved there) or only reference it (stub, resolved by the owner\'s entity resolver)', columns: ['subgraph', 'kind', 'fields', 'resolvers'], rows: gw.map((g) => ({
          cells: [[g.subgraph], [g.kind], listToks((g.fields ?? []).map(code)), listToks((g.resolverOps ?? (g.entityResolver ? [g.entityResolver] : [])).map(opLink))], ev: parseEvidence(g.evidence) })) },
        { title: 'Operations with this home class (F2)', hint: 'they run in the service the cut puts this class in', columns: ['operation', 'kind'], rows: homeOps.map((o) => ({ cells: [[opLink(o.id)], [o.kind]], ev: parseEvidence(o.entry) })) },
      ].filter((t) => t.rows.length),
      docs: [...docs.schema(c.service, [gqlType(c.name)]), ...docs.spec(c.service, c.table ? [`\\b${esc(c.table)}\\b`] : [`\\b${esc(c.name)}\\b`]), ...docs.curated(c.service, [`class: ${esc(c.name)}\\b`])],
      modelTarget: mc ? `class:${c.name}` : undefined,
    });
  }

  // ------------------------------------------------------------------ references
  for (const r of a.references) {
    const svc = classSvc.get(r.from) ?? '?';
    const mr = model?.references.find((x) => x.id === r.id);
    const jt = r.storage.includes('join') ? a.joinTables.find((j) => j.joins.includes(r.from) && j.joins.includes(r.to)) : undefined;
    const table = a.classes.find((c) => c.name === r.from)?.table;
    add({
      key: `ref:${r.id}`, kind: 'ref', group: svc, title: r.id, subtitle: `${r.from} → ${r.to}`,
      facts: [
        { label: 'from → to', value: [clsLink(r.from), ' → ', clsLink(r.to)] },
        ...(r.attr ? [{ label: 'attribute', value: [code(r.attr)] }] : []),
        { label: 'kind', value: [r.kind, r.kind === 'composition' ? ' (the target owns it: deleted with it, one aggregate)' : ''] },
        { label: 'multiplicity', value: [r.mult, mr ? ` (model: upper ${mr.upper === -1 ? '*' : mr.upper})` : ''] },
        { label: 'storage', value: [r.storage], ev: parseEvidence(r.evidence) },
        { label: 'cross-service today', value: [r.crossServiceToday ? chip('yes', 'warn') : 'no', ` (${classSvc.get(r.from)} → ${classSvc.get(r.to)})`] },
        ...(r.snapshot || mr?.snapshot ? [{ label: 'snapshot', value: ['the referencing side keeps the values of the time (model: snapshot)'] }] : []),
        ...(jt ? [{ label: 'join table', value: [code(`${jt.service}.${jt.table}`), ' ', ...listToks(jt.attributes.map(code))], ev: parseEvidence(jt.evidence) }] : []),
        ...(r.inverse ? [{ label: 'other end', value: [code(r.inverse)] }] : []),
        ...(r.inCopy ? [{ label: 'held by', value: ['the column ', code(r.attr ?? ''), ' of the copy ', code(r.inCopy), ' (an association the copy\'s service owns)'] }] : []),
        ...(r.note ? [{ label: 'note', value: [r.note] }] : []),
      ],
      tables: [
        // today's reach `local` as own service; fingerprinted in the older spelling
        ...[((t: (before: boolean) => Table) => asBefore(t(false), t(true)))((before) => ({ title: 'Accessed by', hint: mr?.table ? `reads and writes of ${r.id}: the links only (the source's data, not its rows; AB42)` : `reads and writes of ${r.from} through ${r.id} (AB42)`, columns: ['operation', 'mode', 'statement', 'today'],
          rows: a.operations.flatMap((o) => o.accesses.filter((x) => x.reference === r.id).map((x) => ({ cells: [[opLink(o.id)], [x.mode === 'write' ? chip('write', 'warn') : 'read'], [`${x.op ?? ''} ${x.shape}`], [before ? x.today : reach(x.today)]], ev: parseEvidence(x.evidence) }))) }))],
      ].filter((t) => t.rows.length),
      docs: [...docs.schema(svc, [gqlType(r.from), ...(r.attr ? [`^\\s+${esc(gqlField(r.attr))}`] : [])]),
        ...docs.curated(svc, [...(table ? [`^  ${esc(table)}:`] : []), ...(r.attr ? [`attr: ${esc(r.attr)}\\b`] : [])])],
      modelTarget: `class:${r.from}`,
    });
  }

  // ------------------------------------------------------------------ operations
  const sitesOf = new Map<string, NonNullable<InputModel['sites']>>();
  for (const s of model?.sites ?? []) if (s.op) sitesOf.set(s.op, [...(sitesOf.get(s.op) ?? []), s]);
  const seffIds = new Map((model?.seffs ?? []).map((x) => [x.id, x]));
  const seffsOf = (mo: ModelOperation) => mo.seffs.filter((id) => seffIds.has(id)).map((id) => {
    const x = seffIds.get(id)!;
    const at = x.home ? ` at the home ${x.home.class}${x.home.written ? ' (today)' : ''}` : '';
    return x.kind === 'request' ? { id, label: `its SEFF as the root resolver of ${x.request}${at}`, request: x.request }
      : x.request ? { id, label: `its SEFF as a field of ${x.request}, with the fields resolved on its objects${at}`, request: x.request }
        : { id, label: `its SEFF${at}` };
  });
  for (const o of a.operations) {
    const mo: ModelOperation | undefined = mops.get(o.id);
    const scope = scopeOf(o);
    const t = o.trigger;
    const trig = t.graphql ?? t.topic ?? t.http ?? t.schedule ?? '';
    const field = t.graphql ? (/^_entities\((\w+)\)$/.exec(t.graphql)?.[1] ?? t.graphql.split('.')[1]) : undefined;
    const typeName = t.graphql ? (/^_entities\((\w+)\)$/.exec(t.graphql)?.[1] ?? t.graphql.split('.')[0]) : undefined;
    const maintains = a.copies.filter((x) => x.writers.includes(o.id));
    const accRow = (x: AAccess, before = false) => {
      const pm = x.via ? pms.get(`${o.service}|${x.via}`) : undefined;
      const ev = [...parseEvidence(x.evidence, 'access'), ...(pm ? parseEvidence(pm.evidence, x.via) : [])];
      return {
        cells: [[clsLink(x.class)], [x.mode === 'write' ? chip('write', 'warn') : 'read'], [x.op ?? ''], [x.shape], [String(x.statements)],
          x.consistency ? [levelChip(x.consistency), ...(x.op === 'lock' ? [' ', chip('lock', 'muted')] : [])] : [before && x.strong ? 'strong' : ''], [before ? x.today : reach(x.today)], [x.via ? code(x.via) : x.topic ? topicLink(x.topic) : '']],
        ev,
        note: join(x.note, x.when && `when ${x.when}`, x.per && `per ${x.per}`, val(x.prob) && `probability ${x.prob}`, val(x.times) && `times ${x.times}`, x.dbTrigger && `database trigger ${x.dbTrigger}`, x.reference && `reference ${x.reference}`, val(x.rows) && `rows: ${x.rows}`, curatedNote(x.consistency)),
      };
    };
    const sites = sitesOf.get(o.id) ?? [];
    const seed = a.msaMapping.seedDemands.operations[o.id];
    add({
      key: opKey(o.id), kind: 'op', group: o.service, title: short(o.id), subtitle: trig, scope,
      facts: [
        { label: 'in the model', value: [chip(OP_SCOPE[scope].label, scope === 'simulated' ? 'ok' : 'muted'), ` ${OP_SCOPE[scope].about}`] },
        { label: "today's service", value: [o.service] },
        { label: 'kind', value: [o.kind, mo ? ` (model: ${mo.kind}, ${mo.modelKind})` : ''] },
        { label: t.graphql ? 'GraphQL' : t.topic ? 'topic' : t.http ? 'HTTP route' : 'schedule', value: [t.topic ? topicLink(t.topic) : code(trig)] },
        { label: 'entry point', value: [code(o.entry.replace(/^services\/[^/]+\/src\/main\/kotlin\/org\/misarch\/[^/]+\//, ''))], ev: parseEvidence(o.entry, 'entry') },
        { label: 'feature', value: [`${o.feature} ${features.get(o.feature) ?? ''}`] },
        ...(o.sagaStep ? [{ label: 'saga', value: [part(`saga:${o.sagaStep.saga}`, o.sagaStep.saga), ` (${o.sagaStep.role})`] }] : []),
        ...(mo ? [{ label: 'home class (F2)', value: [clsLink(mo.homeClass), ' — runs in the service the cut puts this class in'] }] : []),
        ...(mo?.process ? [{ label: 'process', value: [part(`saga:${mo.process.id}`, mo.process.id), ` (${mo.process.role})`] }] : []),
        ...(mo ? [{ label: 'rate', value: [`${mo.rate.toPrecision(3)}/s at the design load`], volatile: true }] : []),
        ...(seed ? [{ label: 'timing (A9 seed)', value: [`CPU ${num(seed.cpuMs)} ms, database ${num(seed.dbMs)} ms per execution, split from msa `, ...listToks(seed.from.map((m) => part(`timing:${m}`, m)))] }]
          : mo ? [{ label: 'timing', value: [chip('fallback', 'warn'), ' no msa counterpart: the median of the seeds of its service and kind (F7)'] }] : []),
        ...(mo ? [{ label: 'own work (model)', value: [`${num(mo.cpuMs)} ms CPU per execution; database time per access below`] }] : []),
        ...(o.notReached?.length ? [{ label: 'check', value: [chip('not reached', 'warn'), ' callgraph.py does not reach ', ...listToks(o.notReached.map(code)), ' from the entry'] }] : []),
        ...(o.note ? [{ label: 'note', value: [o.note] }] : []),
      ],
      tables: [
        (() => {
          const t = (before: boolean): Table => ({ title: 'Accesses', hint: before ? 'per statement site in the code: class, read/write, statement, shape, statements per execution, strong (must succeed), how today\'s code reaches the data, persistence method'
            : 'per statement site in the code: class, read/write, statement, shape, statements per execution, the curated consistency level of a read that decides a write or check (strict, stale-ok, immutable; its rules, the reason in the note; AB60), how today\'s code reaches the data (own service: its own service\'s database; copy, call, payload), persistence method', columns: ['class', 'mode', 'statement', 'shape', 'stmts', before ? 'strong' : 'level', 'today', 'via'], rows: o.accesses.map((x) => accRow(x, before)) });
          return asBefore(t(false), t(true));
        })(),
        ((t: (before: boolean) => Table) => asBefore(t(false), t(true)))((before) => ({ title: 'Calls', hint: before ? 'synchronous calls to other operations today' : 'synchronous calls to other operations (and effect calls to the external providers) today; the curated level of a call (AB60), an effect call sync only (E1)', columns: ['to', 'how', 'shape', before ? 'strong' : 'level'], rows: o.calls.map((c) => ({
          cells: [listToks([c.to].flat().map(opLink)), [c.how], [c.shape], c.consistency ? [levelChip(c.consistency)] : c.effect ? [chip('effect · E1', 'warn')] : [before && c.strong ? 'strong' : '']], ev: parseEvidence(c.evidence), note: join(c.purpose, c.note, c.when && `when ${c.when}`, val(c.prob) && `probability ${c.prob}`, curatedNote(c.consistency)) })) })),
        { title: 'Publishes', columns: ['topic', 'payload', 'when'], rows: o.publishes.map((p) => ({
          cells: [[topicLink(p.topic)], listToks(p.payload.map(clsLink)), [join(p.when, val(p.prob) && `p ${p.prob}`) ?? 'always']], ev: parseEvidence(p.evidence), note: p.note })) },
        { title: 'Transactions', columns: ['classes', 'publishes inside'], rows: o.transactions.map((x) => ({
          cells: [listToks(x.classes.map(clsLink)), [x.publishInside ? 'yes' : 'no']], ev: parseEvidence(x.evidence), note: x.note })) },
        { title: 'Copies it maintains', columns: ['copy table', 'of', 'fed by'], rows: maintains.map((x) => ({
          cells: [[code(`${x.service}.${x.table}`)], listToks(Object.keys(x.copyOf).map(clsLink)), listToks(x.fedBy.map(topicLink))], ev: parseEvidence(x.evidence), note: x.note })) },
        ...(mo ? [
          ...(() => {
            const own = (b: boolean) => (b ? 'local' : 'own data');
            const t = (before: boolean): Table => ({ title: 'Accesses as modelled', hint: `per class and mode (F3): statements per execution (count), rows per statement, ${before ? '' : 'a read\'s level (the model\'s Access.level, the strictest of its statements; shown where curated or not stale-ok, AB60), '}${own(before)} = the home class's own schema${before ? '' : ', the cell its fixed mechanism (a read sync, a write in transaction: the operation\'s own; AB62), empty'}, else through that class's component`, columns: ['class', 'mode', 'shape', 'count', 'rows', before ? 'strong' : 'level', own(before), 'today', 'navigates', 'db ms'], rows: mo.accesses.map((x) => ({
              cells: [[clsLink(x.class)], [x.mode === 'write' ? chip('write', 'warn') : 'read'], [x.shape], [String(x.count)], [String(x.rows)], x.level && (x.rules || x.level !== 'stale-ok') ? [levelChip({ level: x.level, rules: x.rules }), ...(x.lock ? [' ', chip('lock', 'muted')] : [])] : [''], [x.local ? (before ? own(before) : x.mode === 'write' ? 'in transaction' : 'sync') : ''], [(x.today ?? []).map(before ? (y: string) => y : reach).join(', ')], [x.via ? part(`ref:${x.via}`, x.via) : ''], [num(x.dbMs)]], ev: [] })) });
            return [asBefore(t(false), t(true))];
          })(),
          ((t: (before: boolean) => Table) => asBefore(t(false), t(true)))((before) => ({ title: 'Calls and events as modelled', columns: ['target', 'kind', 'count / p', before ? 'strong' : 'level'], rows: [
            ...mo.calls.map((c) => ({ cells: [[opLink(c.callee)], ['call'], [String(c.count)], c.level ? [levelChip({ level: c.level, rules: c.rules })] : ['']], ev: [], ...(c.nestedIn ? { note: `a field of ${c.nestedIn}'s invocation (AB55): its level is that call's` } : {}) })),
            ...(mo.effectCalls ?? []).map((e) => ({ cells: [[code(e.to)], ['effect call'], ['1'], [chip(`effect · ${e.rules.join(', ')}`, 'warn')]], ev: [] })),
            ...mo.raises.map((r) => ({ cells: [[topicLink(r.event)], ['raises'], [String(r.probability)], ['']], ev: [] })),
          ] })),
          { title: 'Call sites (decisions)', hint: 'each site\'s mechanism is decided per design among the allowed ones; the seeds\' choices', columns: ['site', 'kind', 'target', 'allowed', 'today', 'neutral'], rows: sites.map((s) => ({
            cells: [[code(s.id)], [s.kind, s.mode ? ` ${s.mode}` : ''], [s.class ? clsLink(s.class) : s.callee ? opLink(s.callee) : ''], [s.allowed.join(', ')], [s.today ?? ''], [s.neutral ?? '']], ev: [] })) },
          { title: 'Reached by', hint: 'request types and executions per request', columns: ['request type', 'visits'], volatile: true, rows: mo.reach.map((r) => ({ cells: [[part(`req:${r.request}`, r.request)], [r.visits.toPrecision(3)]], ev: [] })) },
        ] : []),
      ].filter((x) => x.rows.length),
      docs: [
        ...(t.graphql ? docs.schema(o.service, field && typeName !== field ? [`^(?:type|interface)\\s+${esc(typeName!)}\\b`, `^\\s+${esc(field)}\\b`] : [gqlType(typeName ?? '')]) : []),
        ...(t.topic && has(`reference/events/${t.topic.replace(/\//g, '_')}.json`) ? [{ label: 'event sample', kind: 'event' as const, loc: { repo: TREE, path: `reference/events/${t.topic.replace(/\//g, '_')}.json` } }] : []),
        ...(t.topic && has(`reference/dapr-subscribe/${o.service}.json`) ? [{ label: `original's dapr-subscribe ${o.service}`, kind: 'subscribe' as const, loc: { repo: TREE, path: `reference/dapr-subscribe/${o.service}.json` }, find: [esc(t.topic)] }] : []),
        ...docs.spec(o.service, [esc(field ?? t.topic ?? t.http ?? 'Scheduled')]),
        ...docs.fixes(o.service),
        ...docs.curated(o.service, [`id: ${esc(o.id)}$`]),
      ],
      seffs: mo ? seffsOf(mo) : undefined,
      modelTarget: mo ? `op:${o.id}` : undefined,
    });
  }

  // ------------------------------------------------------------------ events
  for (const e of a.events) {
    const svc = e.topic.split('/')[0];
    const me = model?.events.find((x) => x.id === e.topic);
    const file = `reference/events/${e.topic.replace(/\//g, '_')}.json`;
    add({
      key: `event:${e.topic}`, kind: 'event', group: classSvc.has(svc) || a.operations.some((o) => o.service === svc) ? svc : 'cross-service', title: e.topic, subtitle: e.role,
      facts: [
        { label: 'role', value: [e.role] },
        ...(e.neverPublished ? [{ label: 'never published', value: [String(e.neverPublished)] }] : []),
        ...(e.externalPublisher ? [{ label: 'external publisher', value: [String(e.externalPublisher)] }] : []),
        { label: 'in the model', value: me ? [chip('domain event', 'ok'), ' payload ', ...listToks(me.payload.map(clsLink))] : [chip('no domain event', 'muted'), ' (copy feeds are part of the copy mechanism; or no reached publisher)'] },
      ],
      tables: [
        { title: 'Publishers', columns: ['operation', 'payload', 'when'], rows: e.publishers.map((p) => ({ cells: [[opLink(p.op)], listToks(p.payload.map(clsLink)), [join(p.when, val(p.prob) && `p ${p.prob}`) ?? 'always']], ev: parseEvidence(p.evidence) })) },
        { title: 'Subscribers', columns: ['operation', 'service', 'maintains a copy'], rows: e.subscribers.map((s) => ({ cells: [[opLink(s.op)], [s.service], [s.copy ? 'yes' : 'no']], ev: parseEvidence(s.evidence) })) },
      ].filter((x) => x.rows.length),
      docs: [
        ...(has(file) ? [{ label: 'event sample', kind: 'event' as const, loc: { repo: TREE, path: file } }] : []),
        ...[...new Set(e.subscribers.map((s) => s.service))].filter((s) => has(`reference/dapr-subscribe/${s}.json`)).map((s) => ({ label: `original's dapr-subscribe ${s}`, kind: 'subscribe' as const, loc: { repo: TREE, path: `reference/dapr-subscribe/${s}.json` }, find: [esc(e.topic)] })),
        ...docs.spec(svc, [esc(e.topic)]),
      ],
    });
  }

  // ------------------------------------------------------------------ joins (statements over several tables)
  for (const j of a.joins) {
    const name = /^trigger (\S+)/.exec(j.method)?.[1] ?? j.method.split('.').pop()!;
    add({
      key: `join:${j.id}`, kind: 'join', group: j.service, title: j.method, subtitle: j.classes.join(', '),
      facts: [
        { label: 'method', value: [code(j.method)], ev: parseEvidence(j.evidence) },
        { label: 'classes', value: listToks(j.classes.map(clsLink)) },
        { label: 'tables', value: listToks(j.tables.map(code)) },
        { label: 'kinds', value: [j.kinds.join(', ')] },
        ...(j.writes.length ? [{ label: 'writes', value: listToks(j.writes.map(code)) }] : []),
        ...(j.trigger ? [{ label: 'database trigger', value: [code(name), ' runs the statement on every write of its table'] }] : []),
      ],
      tables: [{ title: 'Used by', columns: ['operation'], rows: j.usedBy.map((u) => ({ cells: [[opLink(u)]], ev: parseEvidence(ops.get(u)?.entry, 'entry') })) }].filter((x) => x.rows.length),
      code: j.sql ? { label: 'SQL', text: j.sql } : undefined,
      docs: [...docs.spec(j.service, [esc(name)]), ...docs.curated(j.service, [esc(name)])],
    });
  }

  // ------------------------------------------------------------------ bindings (the model's JOIN, TRANSACTION, COMPOSITION groups)
  for (const b of model?.bindings ?? []) {
    const cs = new Set(b.classes);
    const covers = (xs: string[]) => b.classes.every((c) => xs.includes(c));
    const rows = b.kind === 'JOIN'
      ? a.joins.filter((j) => covers(j.classes)).map((j) => ({ cells: [[part(`join:${j.id}`, j.method)], listToks(j.classes.map(clsLink))], ev: parseEvidence(j.evidence) }))
      : b.kind === 'TRANSACTION'
        ? a.operations.flatMap((o) => o.transactions.filter((x) => covers(x.classes)).map((x) => ({ cells: [[opLink(o.id)], listToks(x.classes.map(clsLink))], ev: parseEvidence(x.evidence), note: x.note })))
        : a.references.filter((r) => r.kind === 'composition' && cs.has(r.from) && cs.has(r.to)).map((r) => ({ cells: [[part(`ref:${r.id}`, r.id)], [clsLink(r.from), ' → ', clsLink(r.to)]], ev: parseEvidence(r.evidence) }));
    add({
      key: `binding:${b.id}`, kind: 'binding', group: classSvc.get(b.classes[0]) ?? 'cross-service', title: b.id, subtitle: b.kind.toLowerCase(),
      facts: [
        { label: 'kind', value: [b.kind, b.kind === 'JOIN' ? ' (a statement over these classes\' tables)' : b.kind === 'TRANSACTION' ? ' (written in one transaction)' : ' (one aggregate)'] },
        { label: 'classes', value: listToks(b.classes.map(clsLink)) },
        ...(b.operations.length ? [{ label: 'operations', value: listToks(b.operations.map(opLink)) }] : []),
      ],
      tables: [{ title: 'In the extraction', hint: 'the statements, transactions or compositions that bind these classes', columns: [b.kind === 'COMPOSITION' ? 'reference' : b.kind === 'JOIN' ? 'join' : 'operation', 'classes'], rows }],
      docs: [],
    });
  }

  // ------------------------------------------------------------------ sagas
  for (const s of a.sagas) {
    const mp = model?.processes.find((x) => x.id === s.name);
    const trig = ops.get(s.trigger);
    add({
      key: `saga:${s.name}`, kind: 'saga', group: trig?.service ?? 'cross-service', title: s.name, subtitle: `from ${s.trigger}`,
      facts: [
        { label: 'trigger', value: [opLink(s.trigger)], ev: parseEvidence(trig?.entry, 'entry') },
        { label: 'msa', value: [s.msa] },
        ...(mp ? [{ label: 'coordination', value: [`allowed ${mp.styles.join(', ')}; today ${mp.today ?? '?'}, neutral ${mp.neutral ?? '?'}`] }] : []),
      ],
      tables: [{ title: 'Steps and compensations', columns: ['operation', 'role', 'trigger'], rows: s.operations.map((x) => ({
        cells: [[opLink(x.op)], [x.role === 'compensation' ? chip('compensation', 'warn') : x.role], [x.trigger?.topic ? topicLink(x.trigger.topic) : code(x.trigger?.http ?? '')]], ev: parseEvidence(ops.get(x.op)?.entry, 'entry') })) }],
      docs: trig ? docs.spec(trig.service, [esc(s.name)]) : [],
      modelTarget: trig && mops.has(trig.id) ? `op:${trig.id}` : undefined,
    });
  }

  // ------------------------------------------------------------------ request types (the gateway plans, package C's definition)
  for (const r of model?.requests ?? []) {
    const ar = a.requests.find((x) => x.type === r.id || x.type === r.msa);
    const cr = ctx.workload?.requests?.[r.id] as { msa?: string; operations?: string[]; roundTwoRequest?: string } | undefined;
    const root = ops.get(r.plan[0]?.op);
    const planOps = r.plan.map((p) => p.op);
    const same = cr?.operations && cr.operations.length === planOps.length && cr.operations.every((x, i) => x === planOps[i]);
    const visits = (model?.sessions ?? []).flatMap((s) => s.visits.filter((v) => v.request === r.id).map((v) => ({ s, v: v.visits })));
    add({
      key: `req:${r.id}`, kind: 'req', group: root?.service ?? 'cross-service', title: r.id, subtitle: r.msa && r.msa !== r.id ? `msa ${r.msa}` : undefined,
      facts: [
        ...(r.msa ? [{ label: 'msa request', value: [r.msa] }] : []),
        ...(ar ? [{ label: 'document from', value: [code(ar.evidence)] }] : []),
        ...(cr?.operations ? [{ label: "C's operations", value: [...listToks(cr.operations.map(opLink)), ' ', same ? chip('= the plan', 'ok') : chip('differs from the plan', 'warn')] }] : [{ label: "C's operations", value: [chip('not in sessions.json', 'warn')] }]),
        ...(cr?.roundTwoRequest ? [{ label: 'round-2 request', value: [cr.roundTwoRequest] }] : []),
        { label: 'work per request', value: [`gateway ${num(r.work.gateway)} ms, application ${num(r.work.app)} ms, database ${num(r.work.db)} ms (demands, no middleware or queueing)`], volatile: true },
        { label: 'rate', value: [`${r.rate.toPrecision(3)}/s at the design load`], volatile: true },
      ],
      tables: [
        ...(() => {
          // the plan's `via` in words; fingerprinted in the older spelling (`local`), the claims are the same
          const t = (before: boolean): Table => ({ title: 'Gateway plan', hint: 'root resolver first, then the fields: resolved by the root\'s service (' + (before ? 'local' : 'parent\'s service') + ') or fetched by the gateway (federation), each on the objects of the entry it is a field of (AB44); of a connection field, what the document selects ("first": the document gives first). In the relational ports each of page, COUNT and probe is a statement of its own, run only when its field is selected (AB57); the probe of hasNextPage needs a first, given or a default (25 in User.orders, User.wishlists and the review connections). The Kotlin originals\' connections are counted as curated (A, REPORT §9: nodes always, no probe)', columns: ['operation', 'via', 'field of', 'entry', 'selects'], rows: r.plan.map((p) => ({
          cells: [[opLink(p.op)], [before ? (p.via === 'service' ? 'local' : p.via) : PLAN_VIA_WORDS[p.via] ?? p.via], [p.parent !== undefined && r.plan[p.parent] ? opLink(r.plan[p.parent].op) : ''], [ops.get(p.op)?.trigger.graphql ? code(ops.get(p.op)!.trigger.graphql!) : ''],
            [((q) => (q?.selects ? `${q.selects.join(', ')}${q.first ? ' (first)' : ''}` : ''))(ar?.plan.find((x) => x.op === p.op && x.selects))]], ev: parseEvidence(ops.get(p.op)?.entry, 'entry') })) });
          return [asBefore(t(false), t(true))];
        })(),
        { title: 'Visits per session', hint: 'expected requests of this type per session of the class (C\'s steps: branches and loops)', columns: ['session class', 'visits'], rows: visits.map(({ s, v }) => ({ cells: [[part(`session:${s.id}`, s.name)], [num(v)]], ev: [] })) },
        { title: 'C1 budgets', hint: 'today\'s simulated statistic under each profile (the reference) and the budget: factor × it (gen_domain_budgets.sh)', volatile: true, columns: ['profile', 'statistic', 'reference', 'completions', 'budget'], rows: (r.budgets ?? []).map((b) => ({
          cells: [[part(`profile:${b.profile}`, b.profile)], [b.statistic], [b.referenceMs !== undefined ? `${num(b.referenceMs)} ms` : '–'], [String(b.referenceCount ?? '–')], [b.budgetMs !== undefined ? `${num(b.budgetMs)} ms` : 'none']], ev: [] })) },
      ].filter((t) => t.rows.length),
      code: r.document ? { label: 'GraphQL document', text: r.document } : undefined,
      seffs: model?.seffs.some((x) => x.id === r.seff) ? [{ id: r.seff, label: 'the gateway\'s SEFF for this request type' }] : undefined,
      docs: [...(root ? docs.schema(root.service) : []), docs.project('workload', files.docs.sessions, ['^  "requests": \\{', `^\\s*"${esc(r.id)}": \\{`]), docs.project('workload', files.docs.workloadDoc)],
      modelTarget: `req:${r.id}`,
    });
  }

  coverageParts(ctx);
  featureParts(ctx);
  timingParts(ctx);
  workloadParts(ctx);
  paramParts(ctx);

  const kindOrder = new Map<string, number>(PART_KINDS.map((k, i) => [k.id, i]));
  const groupOrder = (g: string) => LATE_GROUPS.indexOf(g);
  return out.sort((x, y) => groupOrder(x.group) - groupOrder(y.group) || x.group.localeCompare(y.group) || kindOrder.get(x.kind)! - kindOrder.get(y.kind)! || x.title.localeCompare(y.title));
}
