/**
 * The MiSArch packet's texts of the Model panel (web/src/model/*, views/ModelView.tsx; not the Verify tab): the documentation
 * references, the case's names, files and facts the generic panel leaves out. Keys `model.*`; templates with the
 * variables the panel computes (named at each key). Inline markup where the panel renders it (model/text.tsx MText):
 * `code`, **bold**, [label](model target), [`label`](target) for an operation. The How tab's are in how.ts, the
 * Interactions tab's in interactions.ts.
 */

export const texts: Record<string, string> = {
  // ------------------------------------------------------------------ mechanisms, homes, links (shared, CallTree, callGraph)
  /** a mechanism chip's tooltip (model.mechTitle.<mechanism id>) */
  /** the placement badges' tooltips (components/PlacementBadge.tsx): where the two sides run, never a mechanism */
  'placement.noHop': 'a direct call: no middleware, no network, no receiving envelope; an asynchronous message stays in-process, no broker',
  'placement.remote': "the hop: both sidecars' middleware and 2 × the network delay; a synchronous call also pays the callee's receiving envelope, an asynchronous message goes through the broker",
  'placement.own': "the operation's own home class: its own schema, called directly on the database server (RemoteCalls.direct); no call site: a read sync, a write in the operation's own transaction; no hop",
  /** an operation's accesses, column today (package A's reach; `local` shown as own service) */
  'model.op.todayTitle': "how today's code reaches it (package A): own service (its own service's database), copy (a local copy), call, payload (in an event's payload)",
  'model.mechTitle.inTx': "in the caller's transaction: a direct call without envelope, commit or message while caller and provider share a container and their schemas a database server; otherwise a synchronous step",
  'model.homeClass': 'home class',
  'model.home.chosenTitle': 'the chosen home of the operation (a decision)',
  /** vars: op, written (flag) */
  'model.home.optionTitle': "home of {{op}}: a decision among the classes it writes in its transaction{{#written}}; today's{{/written}}{{^written}}; an alternative: the operation's calls are re-targeted here{{/written}}",
  /** vars: plan (today's plan in words, or empty) */
  'model.link.field': "a further field of the request's gateway plan{{#plan}}; today's plan: {{plan}}{{/plan}}",
  /** vars: event */
  'model.link.event': 'raise → reaction: one call site per (raise, reaction){{#event}}; event {{event}}{{/event}}',
  'model.link.callback': 'the external provider calls back (asynchronous only)',
  'model.link.call': "a call of another operation (by its consistency level: a strict call sync only, a stale-ok one sync or a cache; its nested fields as the call); one invocation into fields of fields calls the first, the callee's SEFF for that call the others, on its objects (a direct call within a container: no hop)",
  /** vars: mode */
  'model.link.access': '{{mode}} of another class through its component',
  'model.link.eventP': 'raise probability × executions',
  'model.link.raiseP': 'raise probability',
  /** vars: step, est (flag), commit (flag) */
  'model.stepForm.title': "B's step form {{step}}: the receiving envelope, the step's work (below){{#commit}}, B's commit{{/commit}}; skipped when the step joins the caller's transaction",
  'model.totals.wait': '; wait: latency-only DELAY waits, no CPU',
  'model.realise.strictCall': ' (strict: sync only)',
  'model.realise.noSite': ' (strict: no call site, sync only)',
  'model.work.wait': 'latency-only wait: statements × round trip + commits × commit delay (no CPU)',
  /** vars: est (flag) */
  'model.work.envelopeShort': 'the receiving envelope of a step form',

  // ------------------------------------------------------------------ Operations tab
  'model.ops.why.entries': "Users trigger **queries and mutations** (the root resolvers of the request types' gateway plans), the external provider triggers its **callbacks**. **Field resolvers** and **event reactions** run only as consequences of these, yet they are operations of their own: each has its own home class, so it runs where the cut puts its data, its own accesses and SEFF, it is shared by several triggers, and a reaction runs with its event's raise probability.",
  'model.ops.why.sites': 'They are reached only through **call sites** of the entry points, and how each call is made is decided per design: a field is a direct call when co-located (no hop) and a gateway join (federation) or a cache when apart — the join switches with the cut; an event is one site per (raise, reaction), sync or async, and in-process without a broker when co-located; a write of another class is a sync or async saga step; a read of another class is sync, a cache or a local copy fed by events (so a copy adds events) unless its consistency level is **strict** (sync only); a call of another operation is sync or a cache, sync only when strict; an effect call (a registration with the external provider, E1) is sync only.',
  'model.ops.about': "An operation is one entry point that does work: a GraphQL query or mutation, a field resolver that loads related classes, an entity resolver, a reaction to a domain event, a callback of the external payment or shipment provider. The model holds the ones the workload reaches: each runs in the component of its home class, as a SEFF of timed parts — its own work, one call per accessed class and mode, its calls of other operations, the request's further fields and its events.",
  'model.ops.reach': 'Users trigger the queries and mutations, the provider its callbacks; field resolvers and event reactions follow through call sites whose mechanism each design decides. Open an entry point for what it reaches; pick an operation for what it touches, who reaches it and how.',

  // ------------------------------------------------------------------ SEFF parts (SeffTree)
  'model.work.cacheHit': "a hit of the provider's cache",
  /** vars: est (flag) */
  'model.work.envelope': 'the receiving envelope of the step in its own transaction (dispatch, decode, transaction, idempotency)',
  'model.seff.stmtTitle': 'statements per execution, shape',
  'model.seff.waitTitle': 'latency-only wait (DELAY, no CPU): statements × stmtRoundTripMs + commits × commitDelayMs',
  'model.work.receiving': 'the receiving envelope of a synchronous call across containers (receiving the request, dispatch, decoding, the answer)',
  'model.seff.envelopeTitle': "the callee application's receiving envelope: paid in its container after the hop, only when the call crosses containers; within a container the caller calls the work directly",
  'model.seff.stepFormTitle': "B's step form: the receiving envelope, the write's work, B's commit; skipped when the step joins the caller's transaction",

  // ------------------------------------------------------------------ an operation, a class (details)
  'model.op.effects.ref': 'docs/model.md, Call sites',
  'model.op.homeDecision': '— where the request enters, among the classes it writes in its transaction',
  'model.op.mapOwn': "CPU per execution for its home class's accesses (app-side persistence); the model's work action is own work + this",
  'model.op.transaction': 'transaction',
  'model.op.stmtTitle': 'statements per execution',
  /** vars: via, cls */
  'model.op.viaTitle': 'the reference {{via}}: the links of {{cls}}, not its rows',
  'model.op.syncOnly.ref': 'docs/model.md, Call sites',
  'model.op.accessNote': "A read of another class may become a call, a cache or a local copy when the cut separates the classes; a write of another class is an effect step: in the operation's transaction (joined while co-located on one database server), a synchronous step or an asynchronous message. The allowed mechanisms per call site are in the tree below.",
  'model.op.inertTitle': 'a home option not chosen: not reached, its sites are inert',
  'model.op.downstreamOp': 'A downstream operation',
  'model.class.placed': '(its schema), placed independently',

  // ------------------------------------------------------------------ Domain tab
  /** vars: classes, references */
  'model.domain.about': 'The persisted classes of MiSArch as package A extracted them from misarch-kotlin: {{classes}} classes (a table of their owner each; Media lives in S3), {{references}} references (id columns, id arrays, join tables; compositions bind a part to its whole). Join tables are references, local copies of foreign data are mechanisms, so neither is a class.',
  'model.domain.cut': "The cut decides which service every class lives in: a class's component (its operations) and its schema are placed by the optimisation. Operations are anchored at their home class; the badge counts them.",
  /** vars: n */
  'model.domain.txWorkflows': ' (+ {{n}} transaction workflows)',

  // ------------------------------------------------------------------ Workload tab
  'model.workload.sessionsTitle': 'Users are sessions (C1–C4)',
  /** vars: designLoad (sessions/s) */
  'model.workload.sessions': "Each session class is one usage scenario with open arrivals (Poisson) and a closed loop inside: requests, think times, branches and loops (package C, from Gatling's MiSArch scenarios). The design load is {{designLoad}} sessions/s in the shopping mix — as many client requests as round 2's measurements. Mixes change through per-class load steps.",
  /** the demands' documentation reference (model.workload.timingRef.<source> per timing source, else this) */
  'model.workload.timingRef': 'cases/misarch/timing/README.md',
  /** the demands of a model without its own timing note */
  'model.workload.profilesRef': 'LoadProfile, LoadStep',
  'model.workload.noProfile': 'No load profile in the exported model (pnpm export:model --build <a build of core/tools/run-domain.sh>).',
  'model.workload.source': "Source: `cases/misarch/workload/sessions.json` (C's phases), `core/generator/derive.py --profile` (the steps in the model), `core/tools/gen_domain_budgets.sh` (C1's references).",
  'model.workload.wait': 'database round trips and commits (DELAY, no CPU), not in the work above; the broker publish waits come with the realisation',
  'model.workload.constantRate': 'constant rate (admin does not follow the customers)',
  /** a session's request without a SEFF of the system (the identity provider's token) */
  'model.workload.external.title': "Keycloak's token endpoint: no SEFF of the system",
  'model.workload.external.label': 'Keycloak',

  // ------------------------------------------------------------------ the panel (ModelView)
  /** vars: model, inputs */
  'model.view.ungenerated': '**{{model}} is older than what it is generated from** ({{inputs}}): run `core/generator/derive.py`, then `core/tools/realise-seeds.sh`.',
  /** vars: seeds */
  'model.view.unrealised': '**Realised seeds older than their models** ({{seeds}}): run `core/tools/realise-seeds.sh`.',
  /** an input changed and the backend may not rebuild the packet; vars: changed */
  'model.view.stale': '**The input model is older than its inputs** ({{changed}}): rebuild the packet with `pnpm packet:misarch`.',
  /** after "Pick a run first." or the error: how the input model comes about */
  'model.view.noModel': 'Build the packet with `pnpm packet:misarch` (writes models/<domain>.json into the packet).',
};
