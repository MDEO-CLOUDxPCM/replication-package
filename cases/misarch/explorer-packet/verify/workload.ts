/**
 * The parts of the model that do not come from misarch-kotlin's code, checked against their own sources:
 * - timings: A's mapping to the msa model (each msa operation's round-2 CPU and database time, the operations it
 *   seeds and how it is split; its dependencies matched to A's calls, events and copies; domain/REPORT.md §7);
 * - the workload (package C, workload/sessions.json): session classes, load profiles, mixes, think times, fragments,
 *   cardinalities, data volumes;
 * - the decision layer's parameters (core/generator/derive.py: cost model, reliability, mechanisms, change units, ...).
 */
import { chip, code, esc, num, parseEvidence, part, TREE, type Ctx, type Loc, type Row, type Tok } from './claims';
import { files } from '../config';

/** the msa mapping's short evidence (`user service/UserService.kt:48`) as misarch-kotlin paths */
function msaEvidence(text: string | undefined, services: Set<string>, has: (p: string) => boolean): Loc[] {
  if (!text) return [];
  const out: Loc[] = [];
  let svc: string | undefined;
  for (const m of text.matchAll(/(?:\b([a-z]+) )?([\w/-]+\.kt):(\d+)/g)) {
    if (m[1] && services.has(m[1])) svc = m[1];
    if (!svc) continue;
    const path = `services/${svc}/src/main/kotlin/org/misarch/${svc}/${m[2]}`;
    if (has(path)) out.push({ repo: TREE, path, line: +m[3] });
  }
  return out;
}

/** a value of sessions.json as text (objects as compact JSON) */
const show = (v: unknown): string => (typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v));
/** an entry of sessions.json with its `src` split off */
const srcSplit = (v: unknown): { value: string; src?: string } => {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'src' in v) {
    const { src, ...rest } = v as Record<string, unknown>;
    return { value: Object.keys(rest).length === 1 && 'value' in rest ? show(rest.value) : show(rest), src: String(src) };
  }
  return { value: show(v) };
};

export function timingParts(ctx: Ctx) {
  const { a, ops, mops, has, opLink, topicLink, listToks, docs, add } = ctx;
  const mm = a.msaMapping;
  const services = new Set(a.operations.map((o) => o.service));
  const valTok = (v: unknown): Tok => (typeof v === 'string' && ops.has(v) ? opLink(v) : typeof v === 'string' && ctx.eventTopics.has(v) ? topicLink(v) : code(show(v)));
  const matchToks = (ms: Record<string, unknown>[]): Tok[] => ms.flatMap((m, i) => [...(i ? ['; '] : []), ...Object.entries(m).flatMap(([k, v], j) => [...(j ? [', '] : []), `${k} `, valTok(v)])]);
  for (const t of mm.operations) {
    const mapped = t.ops.map((id) => ops.get(id)).filter((o) => !!o);
    const needs = mm.needs.filter((n) => n.need.startsWith(`${t.msa}->`));
    const seedRows: Row[] = t.ops.map((id) => {
      const s = mm.seedDemands.operations[id];
      const mo = mops.get(id);
      return { cells: [[opLink(id)], [s ? `${num(s.cpuMs)} ms` : '–'], [s ? `${num(s.dbMs)} ms` : '–'], s && s.from.length > 1 ? listToks(s.from.map((m) => part(`timing:${m}`, m))) : [t.msa], [mo ? `${num(mo.cpuMs)} ms` : chip('not simulated', 'muted')]], ev: parseEvidence(ops.get(id)?.entry, 'entry') };
    });
    add({
      key: `timing:${t.msa}`, kind: 'timing', group: mapped[0]?.service ?? 'cross-service', title: t.msa, subtitle: `msa ${t.kind.toLowerCase()} → ${t.ops.length} operations`,
      facts: [
        { label: 'msa operation', value: [`${t.msa} (${t.kind})`, t.request ? ` in request ${t.request}` : ''] },
        { label: 'measured', value: [`CPU ${num(t.cpuMs)} ms, database ${num(t.dbMs)} ms per execution at ${num(t.rate)}/s (round 2)`] },
        { label: 'source', value: [mm.demands] },
        { label: 'split (A9)', value: [mm.seedDemands.method] },
        { label: 'status', value: [t.status === 'mapped' ? chip('mapped', 'ok') : chip(t.status, 'warn')] },
      ],
      tables: [
        { title: 'Operations it seeds', hint: 'per execution; several msa operations of one operation (a shared root) add up', columns: ['operation', 'seed CPU', 'seed database', 'from', 'model CPU'], rows: seedRows },
        { title: 'Its dependencies in the msa model', hint: 'each matched to what today\'s code does (a call, an event and its reaction, a copy read)', columns: ['need', 'kind', 'calls/op', 'strong', 'msa today', 'matched to', 'status'], rows: needs.map((n) => ({
          cells: [[n.need.slice(t.msa.length + 2)], [n.kind], [num(n.callsPerOp)], [n.strong ? 'strong' : ''], [n.msaMechanismToday ?? ''],
            matchToks(n.matches ?? []),
            [n.status === 'mapped' ? chip('mapped', 'ok') : chip(n.status, 'warn')]],
          ev: msaEvidence(n.msaEvidence, services, has), note: n.msaEvidence })) },
      ].filter((x) => x.rows.length),
      docs: [docs.project('report', files.docs.report, ['^## 7\\.', `\\b${esc(t.msa)}\\b`])],
    });
  }
}

export function workloadParts(ctx: Ctx) {
  const { model, workload: w, docs, add, reqLink } = ctx;
  if (!model) return;
  const sources = (src: string | undefined) => (src ?? '').split(/,\s*/).map((k) => (w?.sources?.[k] ? `${k}: ${w.sources[k]}` : k)).filter(Boolean);
  const anchor = (key: string, within?: string) => [...(within ? [`^\\s*"${esc(within)}": \\{`] : []), `^\\s*"${esc(key)}": \\{`];
  const sj = (find: string[]) => docs.project('workload', files.docs.sessions, find);
  const md = (term: string) => docs.project('workload', files.docs.workloadDoc, [`\\b${esc(term)}\\b`]);
  const mixes = (w?.workloads?.realistic?.mixes ?? {}) as Record<string, { src?: string; shares: Record<string, number> }>;

  // session classes
  for (const s of model.sessions) {
    const c = w?.classes?.[s.id] as { about?: string; src?: string; steps?: unknown } | undefined;
    add({
      key: `session:${s.id}`, kind: 'session', group: 'workload', title: s.name, subtitle: s.id,
      facts: [
        { label: 'about', value: [c?.about ?? s.description ?? ''] },
        ...(c?.src ? [{ label: 'sources', value: [sources(c.src).join(' · ')] }] : []),
        { label: 'share', value: [`${num(s.share * 100)} % of the sessions in the base mix; in the mixes: ${Object.entries(mixes).map(([m, x]) => `${m} ${num((x.shares[s.id] ?? 0) * 100)} %`).join(', ')}`] },
        { label: 'think time', value: [`${num(s.thinkTimeS)} s per session (expected)`] },
        { label: 'rate', value: [`${num(s.sessionsPerS)} sessions/s at the design load`], volatile: true },
      ],
      tables: [{ title: 'Visits per session', hint: 'expected requests of each type per session (C\'s steps: branches, loops, fragments)', columns: ['request type', 'visits'], rows: s.visits.map((v) => ({ cells: [[reqLink(v.request)], [num(v.visits)]], ev: [] })) }],
      code: c?.steps ? { label: "C's steps", text: JSON.stringify(c.steps, null, 1) } : undefined,
      docs: [sj(anchor(s.id, 'classes')), md(s.id), docs.project('workload', files.docs.sessionModel)],
      modelTarget: `session:${s.id}`,
    });
  }

  // load profiles
  for (const p of model.profiles ?? []) {
    const steps = p.steps.slice(0, 400);
    add({
      key: `profile:${p.id}`, kind: 'profile', group: 'workload', title: `profile ${p.id}`, subtitle: `${p.endS} s, warm-up ${p.warmUpS} s`,
      facts: [
        ...(p.about ? [{ label: 'about', value: [p.about] }] : []),
        { label: 'window', value: [`0–${p.endS} s, the first ${p.warmUpS} s warm up (not measured); seed ${p.seed ?? '–'}${p.usageStreams ? ', usage streams' : ''}${p.maxPods ? `, at most ${p.maxPods} pods` : ''}`] },
        { label: 'C1 policy', value: [`${p.latency.statistic}${p.latency.factor ? ` × ${p.latency.factor}` : ''}${p.latency.minCompletions ? `, at least ${p.latency.minCompletions} completions` : ''}`] },
        { label: 'model', value: [code(p.model)] },
      ],
      tables: [
        { title: 'Phases', columns: ['phase', 'from', 'volume', 'mix'], rows: p.phases.map((x) => ({ cells: [[x.name], [`${x.fromS} s`], [x.volume !== undefined ? `${num(x.volume)} ×` : '–'], [x.mix ?? '–']], ev: [] })) },
        { title: 'Arrival rates (base)', columns: ['session class', 'sessions/s'], rows: Object.entries(p.baseRates).map(([k, v]) => ({ cells: [[part(`session:${k}`, k)], [num(v)]], ev: [] })) },
        { title: 'Load steps', hint: `from each time on, the session class arrives at factor × its base rate${p.steps.length > steps.length ? ` (first ${steps.length} of ${p.steps.length})` : ''}`, columns: ['session class', 'from', 'factor'], rows: steps.map((x) => ({ cells: [[x.session ? part(`session:${x.session}`, x.session) : 'every class'], [`${x.timeS} s`], [num(x.factor)]], ev: [] })) },
      ],
      docs: [sj(anchor(p.id, 'profiles')), md(p.id), docs.project('derivation', files.docs.derivation, ['PROFILES'])],
      modelTarget: 'workload',
    });
  }
  if (!w) return;

  // the rest of C's model, one part per section
  const section = (id: string, title: string, rows: Row[], columns: string[], about?: string, codeText?: string) => add({
    key: `workload:${id}`, kind: 'workload', group: 'workload', title, subtitle: `sessions.json ${id}`,
    facts: about ? [{ label: 'about', value: [about] }] : [],
    tables: rows.length ? [{ title, columns, rows }] : [],
    code: codeText ? { label: title, text: codeText } : undefined,
    docs: [sj([`^  "${esc(id)}": \\{`]), md(id)],
  });
  const realistic = w.workloads?.realistic ?? {};
  section('workloads', 'Mixes and design load', Object.entries(mixes).map(([m, x]) => ({ cells: [[m], [Object.entries(x.shares).map(([k, v]) => `${k} ${num(v * 100)} %`).join(', ')]], ev: [], note: x.src })), ['mix', 'shares'],
    `${realistic.about ?? ''} Base mix ${realistic.baseMix ?? '?'}; design load ${num(model.designSessionsPerS)} sessions/s.`);
  section('think', 'Think times', Object.entries(w.think ?? {}).map(([k, v]) => { const x = srcSplit(v); return { cells: [[k], [code(x.value)]], ev: [], note: x.src ? sources(x.src).join(' · ') : undefined }; }), ['pause', 'distribution']);
  section('fragments', 'Fragments', [], [], 'step sequences the session classes share', JSON.stringify(w.fragments ?? {}, null, 1));
  section('cardinalities', 'Cardinalities', Object.entries(w.cardinalities ?? {}).filter(([k]) => k !== 'about').map(([k, v]) => { const x = srcSplit(v); return { cells: [[k], [code(x.value)]], ev: [], note: x.src }; }), ['what', 'value'], w.cardinalities?.about);
  section('data', 'Data volumes', Object.entries(w.data ?? {}).filter(([k]) => k !== 'about').map(([k, v]) => { const x = srcSplit(v); return { cells: [[k], [code(x.value)]], ev: [], note: x.src }; }), ['what', 'value'], w.data?.about);
}

export function paramParts(ctx: Ctx) {
  const { model, docs, add } = ctx;
  if (!model) return;
  const byClass = new Map<string, typeof model.parameters>();
  for (const p of model.parameters) byClass.set(p.class, [...(byClass.get(p.class) ?? []), p]);
  const mmFile = (cls: string) => model.metamodels.find((m) => m.classes.some((c) => c.name === cls))?.files[0];
  for (const [cls, ps] of byClass) {
    const props = [...new Set(ps.flatMap((p) => Object.keys(p.properties)))];
    const links = [...new Set(ps.flatMap((p) => Object.keys(p.links ?? {})))];
    const doc = model.metamodels.flatMap((m) => m.classes).find((c) => c.name === cls)?.doc;
    const file = mmFile(cls);
    add({
      key: `param:${cls}`, kind: 'param', group: 'parameters', title: cls, subtitle: ps.length > 1 ? `${ps.length} instances` : ps[0].name,
      facts: [
        ...(doc ? [{ label: 'metamodel', value: [doc] }] : []),
        ...(ps.length === 1 ? [
          ...Object.entries(ps[0].properties).map(([k, v]) => ({ label: k, value: [code(show(v))] })),
          ...Object.entries(ps[0].links ?? {}).map(([k, v]) => ({ label: k, value: [v.join(', ')] })),
        ] : []),
      ],
      tables: ps.length > 1 ? [{ title: 'Instances', columns: ['name', ...props, ...links], rows: ps.map((p) => ({ cells: [[p.name], ...props.map((k) => [show(p.properties[k] ?? '–')]), ...links.map((k) => [(p.links?.[k] ?? []).join(', ')])], ev: [] })) }] : [],
      docs: [docs.project('derivation', files.docs.derivation, [`"${esc(cls)}"`]), ...(file ? [docs.project('metamodel', file, [`^(?:abstract\\s+)?class\\s+${esc(cls)}\\b`])] : [])],
      modelTarget: `param:${cls}`,
    });
  }
}
