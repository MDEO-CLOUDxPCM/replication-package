/**
 * The MiSArch packet's Interactions tab (web/src/model/InteractionsTab.tsx): per kind of interaction where it comes
 * from in MiSArch, its design references and the case's facts in what it is, what the choice changes and each
 * mechanism's card. Doc `interactions`; the tab computes the numbers from the model's parameters and sites.
 *
 * Variables of every kind's templates (the tab computes them):
 *   parameters  cacheHit, compose, jcHit, readDb, readCpu ('' without), writeCpu, writeDb, step, wSync, wAsync, pub,
 *               del, latencyMs, commitMs, ttl, lag, copyCoupling, envRange; siteHits, asBuilt (flags)
 *   counts      readCache, readStrict, callSites, writesOther, bound, events, callbacks, inTxSites, joinedToday, fieldSites,
 *               fetchSites, homes, homeOptions, txs, sagaIds
 *   markup      homeList, sagaList, txList (links to operations and classes)
 *   intro       callerCpuMs, latencyMs, calleeCpuMs, publishCpuMs, deliverCpuMs, networkMs ('' without)
 *   consistency reads, calls (of the model's reads of other classes and calls), effects, locks
 * A kind's `vars` names further variables: { calls: <operation> } its number of calls, { compensations: <process> }
 * its number of compensations. Fields rendered with markup (model/text.tsx MText): intro, examples; the others are
 * plain text.
 */

interface KindDoc {
  where?: string;
  ref?: string;
  what?: string;
  examples?: string;
  effect?: string;
  /** card id -> its text */
  cards?: Record<string, string>;
  vars?: Record<string, { calls?: string; compensations?: string }>;
}

export interface InteractionsDoc {
  intro?: string[];
  /** the placement badges explained once (markup; the intro's variables and recv, recvRange) */
  placement?: { title?: string; intro?: string; noHop?: string; remote?: string; own?: string };
  /** the consistency levels explained once (markup; the variables reads, calls, effects, locks) */
  consistency?: { title?: string; intro?: string; lock?: string; effect?: string };
  kinds: Record<string, KindDoc>;
  /** a lifeline's example (the choreography's trigger) */
  lanes?: { trigger?: string };
}

const interactions: InteractionsDoc = {
  intro: [
    'Every way one operation reaches another class or operation, with the mechanisms a design may choose for it. Each lifeline sits in the box of where it runs: a **service** (an application container with the components of its classes), the **gateway**, a **DB server** (with the schemas placed on it) or the **broker**. Coloured arrows cross containers through the sidecars: a synchronous hop costs {{callerCpuMs}} ms CPU on the caller\'s sidecar, {{latencyMs}} ms latency and {{calleeCpuMs}} ms on the callee\'s{{#recv}}, and a read, an operation or a field reached by it pays the callee application\'s receiving envelope ({{recvRange}} ms CPU in the callee\'s container; none within a container){{/recv}}; an asynchronous message {{publishCpuMs}} ms to publish, the broker, and {{deliverCpuMs}} ms to deliver{{#networkMs}}; between pods on different nodes each message adds {{networkMs}} ms of network delay (two per hop; an ASSUMED literature value, not measured){{/networkMs}}. Database servers are reached directly. Dashed arrows are answers, open heads asynchronous messages; **alt** frames are branches, **async** frames run in the background. Values are this model\'s parameters ([Overview](how)).',
    'The kinds are grouped by what an interaction is **for**: a **fetch** gets data of another class and the caller needs the answer (sync, cache, a copy fed by replication, join); an **effect** runs a step of the work in another class: one **effect step**, in the caller\'s transaction, a synchronous step or an asynchronous message (a chain of steps not in one transaction is a saga). "Another class" is relative to the operation\'s home class, where it starts.',
  ],
  placement: {
    title: 'Placement: no hop, remote or own data (not a mechanism)',
    intro: 'Beside a call\'s **mechanism** (the call site\'s decision: sync, async, in transaction, cache, copy, join, join + cache) the Operations tree, an operation\'s details, the Architecture panel and the compare show its **placement** in the design (or today): whether caller and callee run in one container. The placement follows from the cut, it is no decision of the call, and the same mechanism costs differently on either side.',
    noHop: '**no hop**: caller and callee in one container. The call is a direct call into the callee\'s component: no middleware, no network, no receiving envelope; an asynchronous message is an in-process fork (no broker), a copy read by a writer in the same container needs no feed, a join has nothing to compose (the root resolver calls the field itself), and an effect step in transaction may join the caller\'s transaction.',
    remote: '**remote → B\'s service**: different containers. The call crosses the hop: {{callerCpuMs}} ms CPU on the caller\'s sidecar, {{latencyMs}} ms latency, {{calleeCpuMs}} ms on the callee\'s{{#networkMs}}, 2 × {{networkMs}} ms network (ASSUMED){{/networkMs}}{{#recv}}, and a synchronous call pays the callee\'s receiving envelope ({{recvRange}} ms CPU in its container){{/recv}}; an asynchronous message costs {{publishCpuMs}} ms to publish and {{deliverCpuMs}} ms to deliver through the broker.',
    own: '**own data**: an operation\'s access to its own home class. Only the class\'s component calls its schema, directly on the database server (RemoteCalls.direct): no call site, so its mechanism is fixed and shown beside the badge, a read **sync**, a write **in transaction** (the operation\'s own transaction); no hop (the placement of the schema on a server is the database decision).',
  },
  consistency: {
    title: 'Consistency levels: what a read or call may use (not a decision)',
    intro: 'Every read of another class and every call of another operation has a **consistency level**, curated per statement from misarch-kotlin\'s code (`cases/misarch/extract/curated/consistency.yaml`): it decides which mechanisms its call site allows and what O4 counts, the design cannot change it. A chip names the level and its rule ids; its tooltip holds the rules\' texts and the curated reason. A read group (one call site per class and mode) takes its strictest statement\'s level. An access to the home class (own data) needs no justification and shows none.',
    lock: '**lock**: a statement that only locks (`SELECT … FOR UPDATE`, an advisory lock): a strict read of the locked class (S5), always on the current row at the class\'s own store, never a copy or a cache; {{locks}} in the model.',
    effect: '**effect · E1**: a registration with an external provider (payment, shipment): it changes something outside the system and reads nothing, so it is sync only, never cached or copied; the provider calls back later (a callback site, async only). {{effects}} in the model.',
  },
  lanes: { trigger: 'e.g. placeOrder' },
  kinds: {
    fixed: {
      where: 'an operation and its home class; strict reads of other classes; strict calls; effect calls',
      ref: 'docs/model.md, Call sites',
      what: 'Every operation starts at its home class: its entry point, the class it writes first (or else reads) in today\'s code. Its SEFF is entered on that class\'s component, and its own work and its accesses to the home class run there; everything else it does reaches another class, relative to that home. The home belongs to the operation, not to a business process: a saga has no home, only a start (Saga coordination). Accesses to the home class, **strict** reads of other classes and strict calls into another operation\'s logic (their consistency level: they must see current data) and effect calls (registrations with an external provider, E1) have no call site: the design cannot change how they are made, only where the two sides run. An operation\'s own data in its copy table of another class (an own column such as return\'s `returnedWithId`, its own record of a saga message such as payment\'s open order) is its home class\'s data, not another class\'s.',
      examples: 'e.g. [`order.createOrder`](op:order.createOrder) writes its home class [Order](class:Order) directly and calls {{createOrderCalls}} operations of other classes: the cart lookup [`shoppingcart._entities.User`](op:shoppingcart._entities.User) is strict (S6: the buyer\'s own write moments earlier decides the order) and has no call site; [`discount.findApplicableDiscounts`](op:discount.findApplicableDiscounts) and [`shipment.calculateShipmentFees`](op:shipment.calculateShipmentFees) are stale-ok, call sites sync or a cache (Read of another class). [`shoppingcart.createShoppingcartItem`](op:shoppingcart.createShoppingcartItem) locks its [ShoppingCart](class:ShoppingCart) (strict, S5).',
      vars: { createOrderCalls: { calls: 'order.createOrder' } },
      effect: 'Only the placement matters: separated, a strict read or call pays the sidecar hops on the caller\'s path{{#recv}} and the callee\'s receiving envelope{{/recv}}, counts in O2 (the callee\'s service is on the path) and O3 (the call couples the services).',
      cards: {
        own: 'Only the class\'s own component calls its schema, directly on the database server, without middleware (RemoteCalls.direct). Placing the schema decides only which server does the work (and C3: classes whose schemas share a server must be connected).',
        strict: 'Through the other class\'s component: its access operation (mapping CPU) and then its schema, or the called operation\'s SEFF (an effect call: the provider, outside the model). The caller waits.',
      },
    },
    home: {
      where: '{{homes}} operations with transaction-bound writes (request roots, reactions): the entry point among the classes they write in their transaction',
      ref: 'docs/model.md, Homes',
      what: 'An operation that writes several classes in one transaction may enter at any of them (not at classes it only reads, nor at its reactions\' classes; {{homeOptions}} options), whoever calls it: a request\'s root resolver (the gateway\'s call), a reaction (the effect steps of its event), another operation\'s call. Each option is the operation on that class, built from the same per-class parts (its work, a reaction\'s step form with the envelope and the commit on that class\'s schema, a request\'s root SEFF): the chosen home writes its own class directly (and commits there); the old home\'s write becomes an effect step (in transaction, sync step or async message). The realisation re-targets every call of the operation to the chosen option before it realises the call\'s mechanism, so the home and the mechanism are two independent decisions: a reaction at another home is still an async message, a sync step or, co-located on one database server with its caller, in the caller\'s transaction (then with the chosen class\'s work); the GraphQL API stays. At an alternative home reads of another class have no copy option and request fields no gateway join (both would act although the option is not chosen). The SEFFs, sites and transaction workflows of the options not chosen are not reached: their decisions are inert, the operators skip them.',
      examples: '{{homeList}}.',
      effect: 'Which of the operation\'s writes are its own and which are effect steps, and so where it runs: its hops, joins and envelopes through the simulation (O1, O2, O4, O5, C1), O3 and the modularity (a Home\'s calls count at the chosen home). C3 and the change units keep today\'s homes.',
      cards: {
        home: 'Today: the gateway calls the root resolver at today\'s home A, which writes B as an effect step. Home B chosen: the call is re-targeted to the operation\'s SEFF at B (a reaction\'s effect step likewise, its mechanism unchanged), which writes B directly and A as an effect step; in one container with both schemas on one database server the step joins B\'s transaction.',
      },
    },
    read: {
      where: 'an operation reads class B, B not its home class, or calls another operation for an answer (not strict)',
      ref: 'docs/model.md, Call sites; §6',
      what: 'An operation reads data of another class than its home class and needs the answer to go on; its consistency level (the legend above) decides the mechanisms. {{readCache}} such reads are stale-ok or immutable: they may use a cache or a local copy (immutable ones without staleness cost in O4). Strict reads have no site (Without a decision); the strict reads today\'s code served from the reader\'s own copy were its own data. {{callSites}} calls of another operation are stale-ok: sync or a cache (a call has no copy).',
      examples: 'e.g. [`order.createOrder`](op:order.createOrder) reads [TaxRate](class:TaxRate) and [TaxRateVersion](class:TaxRateVersion) (stale-ok: R1, R3) and [User](class:User) (immutable: I1) from order\'s local copies today; [`return.createReturn`](op:return.createReturn) reads [OrderItem](class:OrderItem) from return\'s copy (immutable: I1; its own column `returnedWithId` is return\'s data); [`discount.findApplicableDiscounts`](op:discount.findApplicableDiscounts) reads [Product](class:Product) (stale-ok, not curated: it decides no write).',
      effect: 'sync puts B\'s service on the reader\'s path (latency, O2) and couples the two (O3); a cache or a copy takes it off the path but reads may be stale (O4); a copy also costs a message to the reader for every write of B.',
      cards: {
        sync: 'The reader calls B\'s component and waits: B\'s access operation maps, B\'s schema runs the statements. In one container (no hop) it is a direct call without middleware or envelope.{{#recv}} Across services B\'s application also receives the request: its receiving envelope ({{recvRange}} ms CPU in B\'s container), after the hop; a cache\'s miss pays it too, a copy read never.{{/recv}}',
        cache: 'A read-through cache inside the reader (CachedCall): a hit costs {{cacheHit}} ms of the reader\'s CPU and skips the call; a miss is the sync read. The branch exists wherever B runs, also in the reader\'s own service. Hits may be stale (O4: TTL {{ttl}} s{{#siteHits}}, the site\'s stale share{{/siteHits}}). Not built in MiSArch.',
        copy: 'Replication: the read goes to a copy of B kept in the reader\'s service (the copy sync: a copy store next to A\'s component, the call re-pointed to it): readDbMs {{readDb}} ms{{#readCpu}}, readCpuMs {{readCpu}} ms{{/readCpu}}, no call to B. Every action that writes B sends the copy one message ({{pub}} on the writer\'s sidecar, the broker, {{latencyMs}} ms, {{del}}), and the reader stores it (writeCpuMs {{writeCpu}} ms, writeDbMs {{writeDb}} ms). If the writer runs in the reader\'s service, the copy is its own data and nothing is sent. Copies that come with a saga message (no writers) cost only their reads. In MiSArch these messages are the replication topics (Sites below: the topics that feed each reader\'s copy today); their handlers only maintain the copy, so they are this option\'s cost, not operations. Across services a copy may be stale (O4, lag {{lag}} s) and couples the two (O3, weight {{copyCoupling}}).',
      },
    },
    effect: {
      where: 'operation A causes a change at class B: a step of the work runs in another class (a write of another class, an event reaction, a provider callback)',
      ref: 'docs/model.md, Call sites',
      what: 'One interaction for every effect: "operation A causes a change at class B". Its parts: the trigger A, B\'s part of the work (the reaction\'s work, or the access part of a write), its outcomes with their probabilities, and the compensation step if B can fail. Whether today\'s code writes B in A\'s code ({{writesOther}} writes of another class, {{bound}} of them in one transaction with A\'s home class) or reacts to an event ({{events}} raise–reaction pairs) or is called back by an external provider ({{callbacks}} callbacks) only describes how today\'s cut implements it: with another cut many reactions would be plain writes in A\'s transaction. Each step is built as B\'s work plus the envelope of the chosen mechanism (proposal 2): the call goes to B\'s step form (envelope, the work, B\'s commit), which a step in A\'s transaction skips.',
      examples: 'e.g. [`order.createOrder`](op:order.createOrder) writes [Order](class:Order) and [OrderItem](class:OrderItem) in one transaction (in transaction today); [`order.placeOrder`](op:order.placeOrder) raises order/order/created, to which [`inventory.on:order/order/created`](op:inventory.on:order/order/created) (reserve the items) and [`shoppingcart.on:order/order/created`](op:shoppingcart.on:order/order/created) (empty the cart) react (asynchronous messages today); the payment provider calls back [`payment.http:/payment/update-payment-status`](op:payment.http:/payment/update-payment-status) (external).',
      effect: 'In transaction: no envelope, commit or message, the chain is one failure unit (O2), co-located so 0 in O4; but A\'s request gets longer (O5, C1) and holds its row locks longer (named, not modelled: the simulation has no lock contention). A synchronous step waits for B\'s own transaction across the hop (O4 weight {{wSync}} apart); an asynchronous message takes it off A\'s path (an asynchronous unit in O2, O4 weight {{wAsync}} apart). No new weights: a command and an event couple alike.',
      cards: {
        inTx: 'B\'s work runs as a direct call inside A\'s transaction: no handler envelope, no commit of its own, no message; its statements join A\'s commit. Applies only while A\'s and B\'s components share a container AND their schemas the same database server, and not to a step of an orchestrated workflow (a saga step there) nor to an externally triggered one (callbacks: async only). Otherwise the realisation makes it a synchronous step, deterministically from the placement (shape joined vs plain, plan-placement.mt rule pj): a move that breaks the condition repairs the step. A failing outcome would be a rollback of the whole transaction: no failure event, no compensation step (not modelled: the two compensations the workload reaches stay as calls). {{joinedToday}} of {{inTxSites}} steps join in today\'s cut.',
        sync: 'A calls B\'s step form and waits: B\'s receiving envelope ({{envRange}} ms CPU per step form), B\'s work, B\'s commit ({{commitMs}} ms wait). Its failing outcome raises a failure event and runs the compensation step (only steps in their own transaction have them). Across containers the hop\'s middleware is on A\'s path (O4 weight {{wSync}}); co-located there is no hop, but B still commits on its own (allowed so the decision space stays uniform; dominated by in-transaction in cost).',
        async: 'A publishes ({{pub}}) and goes on; the broker delivers ({{del}}) and B runs its step form in the background: envelope, work, commit, as the synchronous step. Today\'s events and asynchronous writes. Its failing outcome raises a failure event, and the compensation runs as another step. In one container the message stays in-process (an asynchronous fork, no broker). O4 weight {{wAsync}} across containers; in O2 the step is part of an asynchronous unit (a saga fails per step). The subscriber\'s Dapr pool (10 workers per sidecar) is not modelled as a queue (negligible wait at today\'s load).',
        callback: 'MiSArch\'s payment and shipment providers are external: a service registers a payment or a shipment, the provider later calls an HTTP endpoint of the same service. The provider is not in the model; the callback is an asynchronous call of the registering operation, which always runs in the same service (same home class). An external trigger stays an asynchronous boundary: no in-transaction option.',
      },
    },
    field: {
      where: 'a further field of a request, after its root resolver',
      ref: 'docs/model.md, Call sites',
      what: 'A fetch for the client: a request type is one GraphQL document. The gateway plans it: first the root resolver, the resolver of the document\'s top-level field, in the service of the class that owns that field; then every further field of the answer that belongs to another class. Each such field is a call site.',
      examples: 'e.g. the request [product](req:product): root resolver [`catalog.product`](op:catalog.product), further fields [`catalog.Product.categories`](op:catalog.Product.categories) and [`review.ProductVariant.averageRating`](op:review.ProductVariant.averageRating); the requests on [`user.currentUser`](op:user.currentUser) fetch a user\'s addresses, payment informations or notifications. {{fieldSites}} field sites.',
      effect: 'Whether the root resolver or the gateway waits for the field, and whether a cache takes work off the path (and adds stale reads to O4).',
      cards: {
        sync: 'The root resolver calls the field\'s service itself and waits; the gateway sees one answer.{{#recv}} Across services: the hop, the field service\'s receiving envelope and the field\'s own work, without the federation glue (the `_entities` lookup is the gateway join\'s).{{/recv}} In one container (no hop): the direct call below (join).',
        join: 'The gateway joins (federation), as MiSArch does it: the root resolver answers with a reference only (__typename and id), the gateway composes ({{compose}} ms) and fetches the field from its service; the root resolver does not wait for it. For a field a subgraph contributes to another service\'s entity, the fetch first costs the subgraph its `_entities` resolver finding that entity (the site\'s fetch operation; {{fetchSites}} sites).{{#recv}} The fetch is a request into the field\'s service: its receiving envelope after the hop.{{/recv}} In one container (no hop) there is nothing to compose: the root resolver calls the field directly.',
        cache: 'A cache inside the root resolver\'s service, in front of a synchronous call (CachedCall): a hit costs {{cacheHit}} ms there and skips the whole remote path. The branch exists wherever the field runs. Not built in MiSArch.',
        joinCache: '{{#asBuilt}}A gateway join whose field service answers from its own entity cache, behind its sidecar (as MiSArch\'s entity cache works). The gateway composes and fetches as in a join, both hops stay; a hit costs the field service {{jcHit}} ms and no database{{#recv}} (of which its receiving envelope is paid after the fetch on a hit and a miss alike){{/recv}}, a miss runs the field resolver. A hit saves only the field service\'s work. In one container (no hop): the direct call (join).{{/asBuilt}}{{^asBuilt}}A gateway join with a cache in the gateway: a hit costs the gateway {{jcHit}} ms and skips the fetch, both hops and the field service; a miss is the join. In one container (no hop): the direct call (join).{{/asBuilt}}',
      },
    },
    saga: {
      where: 'a business process of several steps: {{sagaIds}}{{#txs}}; the transaction of {{txs}} operations{{/txs}}',
      ref: 'docs/model.md, Workflows',
      what: 'A saga is a business process whose steps run in several operations, a chain of effects chained by process events. It has no home, only a start: each step is an operation with its own home. The coordination decides who makes the steps: each service the next one (choreography, as MiSArch is built), or the trigger\'s service all of them (orchestration, not built in MiSArch). Each step keeps its own mechanism (Process event, Write of another class). Only orchestration gives the process a place: the orchestrator runs on the trigger\'s component.{{#txs}} A transaction workflow (`tx_<SEFF>`) is the same decision for one operation\'s transaction: its steps are the operation\'s transaction-bound writes of other classes, its orchestrator the operation\'s own component. Each step keeps its mechanism (Effect step): in transaction it joins while it shares the trigger\'s container and database server (choreographed only: an orchestrated step is a saga step); otherwise it runs in a transaction of its own.{{/txs}}',
      examples: '{{sagaList}}. Buy runs from reserving the items over the discount validation and the payment to the shipments{{#buyCompensations}}, with {{buyCompensations}} compensations{{/buyCompensations}}.{{#txList}} Transactions: {{txList}}.{{/txList}}',
      vars: { buyCompensations: { compensations: 'Buy' } },
      effect: 'Orchestration adds coordination CPU per step and, for asynchronous steps, a reply message; the calls of the steps then start in the orchestrator\'s service instead of in the previous step\'s.{{#txs}} A transaction workflow\'s step costs the coordination only while its class sits in another container than the trigger; co-located, orchestrated steps run in parallel at the end of the trigger\'s SEFF without coordination or commit of their own.{{/txs}}',
      cards: {
        choreography: 'The model as written: the trigger raises the first event, each reaction raises the next one.',
        orchestration: 'The steps move to the end of the trigger\'s SEFF: per step {{step}} ms of coordination CPU on the orchestrator (an assumption, not measured: MiSArch has no orchestrator; a transaction workflow\'s step only across containers), then the step\'s call. An asynchronous step is a request and a reply through the broker, and the orchestrator waits for the reply; the steps of one level run in a fork. The whole orchestration runs in the background when the first step is an asynchronous call to another service.',
      },
    },
  },
};

export const docs = { interactions };

/** the Interactions tab's other texts */
export const texts: Record<string, string> = {
  /** the label of a kind's examples */
  'model.mech.examples': 'In MiSArch',
  // the effect family's attributes (EffectAttributes)
  'model.mech.attr.joinedHelp': "in today's cut: joined A's transaction, else why not",
  'model.mech.attr.envelopeHelp': "B's receiving envelope per step form, own transaction only",
  'model.mech.attr.external': 'yes (payment, shipment provider)',
  'model.mech.attr.callbackCompensation': 'raises a failure event (payment-failed): its compensation is an event step',
  /** vars: n */
  'model.mech.attr.reactionCompensation': '{{n}} compensation steps: they exist only for steps in their own transaction (a failure event); in transaction a failing outcome is a rollback of the whole transaction (the model keeps the compensations as calls)',
  /** vars: apart, servers, orchestrated (the join blockers' labels) */
  'model.mech.attr.noteInTx': "in transaction joins A's transaction only while A and B share a container and their schemas a database server (and not as an orchestrated step); else it is a synchronous step: {{apart}}; {{servers}}; {{orchestrated}};",
  'model.mech.attr.noteTx': "the bound writes of one operation are the steps of its transaction workflow (Saga coordination): choreographed they run where the code makes them, orchestrated they are saga steps (step forms) at the end of the operation's SEFF;",
};
