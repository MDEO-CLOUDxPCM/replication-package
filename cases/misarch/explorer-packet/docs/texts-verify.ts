/**
 * The MiSArch packet's texts of the Verify tab (web/src/model/verify/): the intro, the switch to the other parts, the
 * issues' export, the evidence outside misarch-kotlin. A docs module (docs.ts): merged into the doc `texts`.
 * Variables: verify.intro.parts {{n}} parts, {{counts}} per kind, {{source}} the evidence tree's label, {{commit}};
 * verify.issues.* {{tree}}, {{commit}}, {{n}} marks; verify.ev.external {{path}}, {{tree}}. Markup (help/Rich.tsx):
 * **bold**; the intro also *italic*.
 */
export const texts: Record<string, string> = {
  'verify.title': 'Verify the model against misarch-kotlin',
  'verify.intro.ops': 'The list shows the operations as the Operations tab does: the entry points and what each reaches. Pick one: **what it causes** lists every interaction of the model (fetch, effect step, call, own data; the consistency level of a read or call with its rules and curated reason) with the code it stands for; check each row against the source and follow its target downstream. The other parts of the model (classes, references, coverage, timings, the workload) are under *other parts*.',
  'verify.intro.parts': 'The model of MiSArch is split into {{n}} parts: {{counts}}. Each part lists its claims with the code they were extracted from ({{source}}@{{commit}}) and the documents to read them against: the federation schema, the port spec, the fix notes, the curated facts.',
  'verify.intro.checks': "**Correct**: the domain parts (classes to request types) against the code. **Complete**: each service's coverage part maps misarch-kotlin's own inventories (tables, triggers, GraphQL fields, subscriptions, publish sites, persistence methods, routes) to the parts; a number beside it counts the entries nothing covers. **The rest of the model**: features, timings (the msa mapping), session classes, load profiles, the workload's sections and the parameters, against their own sources.",
  'verify.intro.scopes': 'Operations: **simulated** ones are in the model with their SEFF; **C3** ones only for change coupling; **out** ones are left out (copy maintenance, trivial). Marks are kept in this browser; export them to keep them elsewhere.',
  'verify.others.label': 'other parts (classes, references, coverage, timings, workload …)',
  'verify.others.title': 'every part of the model in one list: classes, references, operations, events, joins, bindings, sagas, request types, coverage, features, timings and the workload',
  'verify.more': "More: the extraction's tables, the model's, the SEFF",
  'verify.issues.title': '# Verification of the MiSArch model: issues and notes',
  'verify.issues.head': 'misarch-kotlin {{commit}}; {{n}} marks.',
  'verify.ev.external': '{{path}} (not in misarch-kotlin)',
  'verify.chain.unreached': 'has steps, but callgraph.py does not reach it from the entry',
  'verify.cause.p': 'raise probability',
  'verify.family.own.hint': 'the class whose service runs it; where it is a decision, its options; its own reads and writes are rows of Fetch (sync, own data) and Effect step (in transaction, own data)',
};
