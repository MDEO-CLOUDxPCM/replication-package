/**
 * Coverage parts: per service, misarch-kotlin's inventories (domain/misarch-inventory.json: tables, database
 * triggers, GraphQL root fields, entity types and field candidates, subscriptions, publish sites, persistence methods,
 * HTTP routes and schedules) with the part that covers each entry. An entry nothing covers is flagged; what needs no
 * part of its own (a nested object, a helper that publishes for its callers, a health route) says why.
 */
import { chip, code, parseEvidence, type Ctx, type Row, type Table, type Tok } from './claims';
import type { AOperation } from './extraction';
import { files } from '../config';

const fileLine = (ev: string | null | undefined) => {
  const m = ev ? /^(.*):(\d+)$/.exec(ev) : null;
  return m ? { path: m[1], line: +m[2] } : null;
};

export function coverageParts(ctx: Ctx) {
  const { a, inventory, classSvc, listToks, opLink, docs, add } = ctx;
  if (!inventory) return;
  for (const [svc, s] of Object.entries(inventory.services)) {
    const so = a.operations.filter((o) => o.service === svc);
    let flagged = 0;
    const warn = (t: string): Tok[] => { flagged++; return [chip(t, 'warn')]; };
    const opsTok = (xs: AOperation[]) => listToks(xs.map((o) => opLink(o.id)));

    // tables: a class's, a join table (references), a copy (of another service's class)
    const tables: Row[] = s.tables.map((t) => {
      const k = t.table.toLowerCase();
      const cls = a.classes.filter((c) => c.service === svc && c.table?.toLowerCase() === k);
      const jt = a.joinTables.find((j) => j.service === svc && j.table.toLowerCase() === k);
      const refs = jt ? a.references.filter((r) => r.storage === `join table ${svc}.${jt.table}`) : [];
      const copy = a.copies.find((c) => c.service === svc && c.table.toLowerCase() === k);
      const by: Tok[] = cls.length ? listToks(cls.map((c) => ctx.clsLink(c.name)))
        : refs.length ? ['join table of ', ...listToks(refs.map((r) => ({ part: `ref:${r.id}`, label: r.id })))]
          : copy ? ['copy of ', ...listToks(Object.keys(copy.copyOf).map((c) => ctx.clsLink(c))), ' (fed by ', ...listToks(copy.fedBy.map(ctx.topicLink)), ')']
            : warn('not in the model');
      return { cells: [[code(t.table)], by, [`${t.columns.length} columns`]], ev: parseEvidence(t.evidence), note: t.foreignKeys.length ? `foreign keys: ${t.foreignKeys.join(', ')}` : undefined };
    });

    // database triggers: a join (a statement over several tables) or a check on its own table
    const triggers: Row[] = s.triggers.map((t) => {
      const j = a.joins.find((x) => x.service === svc && x.method.includes(t.name));
      const others = [...t.reads, ...t.writes].filter((x) => x !== t.table);
      const by: Tok[] = j ? [{ part: `join:${j.id}`, label: j.method }] : others.length ? warn('reads other tables, no join') : [chip('a check on its own table', 'muted')];
      return { cells: [[code(t.name)], [code(t.table), ` ${t.events}`], by], ev: parseEvidence(t.evidence), note: `function ${t.function}; reads ${t.reads.join(', ') || '–'}; writes ${t.writes.join(', ') || '–'}` };
    });

    // GraphQL: root fields and entity types must be operations (or excluded); field candidates may be
    const excludedOf = (k: 'graphql' | 'topic' | 'http', v: string) => s.excluded.find((x) => x.trigger?.[k] === v);
    const roots: Row[] = s.graphql.filter((g) => g.kind !== 'field').map((g) => {
      const xs = so.filter((o) => o.trigger.graphql === g.graphql);
      const ex = excludedOf('graphql', g.graphql);
      return { cells: [[code(g.graphql)], [g.kind], xs.length ? opsTok(xs) : ex ? [chip('excluded', 'muted')] : warn('no operation')], ev: parseEvidence(g.evidence), note: ex?.reason };
    });
    const fields: Row[] = s.graphql.filter((g) => g.kind === 'field').map((g) => {
      const xs = so.filter((o) => o.trigger.graphql === g.graphql);
      const base = (g.returns ?? '').replace(/[[\]!]/g, '');
      const entity = classSvc.has(base) || a.gatewayJoins.some((x) => x.entity === base);
      return { cells: [[code(g.graphql)], [code(g.returns ?? '')], xs.length ? opsTok(xs) : [chip(entity ? 'entity reference: the owner\'s _entities resolves it' : 'nested object: resolved with its parent', 'muted')]], ev: parseEvidence(g.evidence) };
    });

    // events in and out
    const subs: Row[] = s.subscriptions.map((x) => {
      const xs = so.filter((o) => o.trigger.topic === x.topic);
      return { cells: [[ctx.topicLink(x.topic)], [x.route ? code(x.route) : x.how], xs.length ? opsTok(xs) : warn('no operation')], ev: [...parseEvidence(x.handler, 'handler'), ...parseEvidence(x.declared, 'declared')] };
    });
    const pubs: Row[] = s.publishSites.map((p) => {
      const exact = so.filter((o) => o.publishes.some((q) => q.evidence === p.evidence));
      const byTopic = so.filter((o) => o.publishes.some((q) => p.topics.includes(q.topic)));
      const by: Tok[] = exact.length ? opsTok(exact)
        : byTopic.length ? [...opsTok(byTopic), ' ', chip('by topic', 'muted')]
          : !p.topics.length ? [chip('a helper: publishes for its callers', 'muted')] : warn('no operation publishes it');
      return { cells: [p.topics.length ? listToks(p.topics.map(ctx.topicLink)) : ['–'], [p.function ? code(p.function) : '–'], by], ev: parseEvidence(p.evidence),
        note: !exact.length && byTopic.length ? 'A names another line for this publish (a constant, the call of a helper, another branch)' : undefined };
    });

    // persistence methods: declared SQL must be used by some access; inherited CRUD only when used
    const usedBy = (m: string) => so.filter((o) => o.accesses.some((x) => x.via === m));
    const declared = s.persistenceMethods.filter((m) => m.how !== 'CRUD (inherited)' || usedBy(m.method).length);
    const unusedCrud = s.persistenceMethods.length - declared.length;
    const pms: Row[] = declared.map((m) => {
      const xs = usedBy(m.method);
      return { cells: [[code(m.method)], [m.how], [[...m.reads.map((t) => `r ${t}`), ...m.writes.map((t) => `w ${t}`)].join(', ') || '–'], xs.length ? opsTok(xs) : warn('used by no access')], ev: parseEvidence(m.evidence) };
    });

    // HTTP routes and schedules
    const routes: Row[] = s.routes.map((r) => {
      const at = fileLine(r.evidence);
      const sub = s.subscriptions.find((x) => {
        const h = fileLine(x.handler);
        return (h && at && h.path === at.path && h.line - at.line >= 0 && h.line - at.line <= 8) || (x.route && r.route.replace(/^\//, '') === x.route.replace(/^\//, '')) || r.route.endsWith(`/${x.topic}`);
      });
      let by: Tok[];
      if (r.method === 'SCHEDULE') {
        const xs = so.filter((o) => o.trigger.schedule && fileLine(o.entry)?.path === at?.path);
        by = xs.length ? opsTok(xs) : warn('no operation');
      } else if (sub) {
        const xs = so.filter((o) => o.trigger.topic === sub.topic);
        by = ['subscription ', ctx.topicLink(sub.topic), ': ', ...(xs.length ? opsTok(xs) : ['–'])];
      } else {
        const xs = so.filter((o) => o.trigger.http === r.route);
        const ex = excludedOf('http', r.route);
        by = xs.length ? opsTok(xs) : ex ? [chip('excluded', 'muted'), ` ${ex.reason}`] : /^\/(health|dapr\/subscribe)$/.test(r.route) ? [chip('infrastructure', 'muted')] : warn('no operation');
      }
      return { cells: [[r.method === 'SCHEDULE' ? 'schedule' : r.method], [code(r.route)], by], ev: parseEvidence(r.evidence) };
    });

    const tablesOut: Table[] = [
      { title: 'Tables (Flyway migrations)', columns: ['table', 'in the model', 'columns'], rows: tables },
      { title: 'Database triggers', columns: ['trigger', 'on', 'in the model'], rows: triggers },
      { title: 'GraphQL root fields and entity types', hint: 'reference/sdl: every one is an operation or excluded with a reason (build.py fails otherwise)', columns: ['field', 'kind', 'operation'], rows: roots },
      { title: 'GraphQL field candidates', hint: 'fields with arguments or of an object type: a resolver of their own where they run code; the others are resolved with their parent or by the gateway', columns: ['field', 'returns', 'operation'], rows: fields },
      { title: 'Subscriptions', columns: ['topic', 'route', 'operation'], rows: subs },
      { title: 'Publish sites', hint: 'calls of a publish (events.py); A\'s publishes name the line of the event', columns: ['topics', 'function', 'operation'], rows: pubs },
      { title: 'Persistence methods', hint: `the methods that run SQL (persistence.py): every declared one should be used by an access; ${unusedCrud} inherited CRUD methods no access uses are left out`, columns: ['method', 'how', 'tables', 'used by'], rows: pms },
      { title: 'HTTP routes and schedules', columns: ['method', 'route', 'operation'], rows: routes },
    ].filter((t) => t.rows.length);
    const n = tablesOut.reduce((x, t) => x + t.rows.length, 0);
    add({
      key: `coverage:${svc}`, kind: 'coverage', group: svc, title: `${svc}: coverage`, subtitle: flagged ? `${flagged} to check` : 'every entry covered', flagged,
      facts: [
        { label: 'what', value: [`misarch-kotlin's inventories of ${svc} (independent of the curation) and the part covering each entry: ${n} entries, `, flagged ? chip(`${flagged} not covered`, 'warn') : chip('all covered', 'ok')] },
        { label: 'operations', value: [`${so.length} in the extraction`] },
      ],
      tables: tablesOut,
      docs: [...docs.sdl(svc), ...docs.schema(svc), ...docs.curated(svc), ...docs.spec(svc), docs.project('report', files.docs.report, [`\\b${svc}\\b`])],
    });
  }
}
