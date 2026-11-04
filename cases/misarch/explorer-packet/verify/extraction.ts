/**
 * Package A's extraction (domain/misarch-domain.json, written by cases/misarch/extract/build.py) as far as the Verify tab
 * reads it. Evidence is `path:line` on `meta.commit` of misarch-kotlin; `at` is the curated anchor (`file#text`)
 * it was resolved from.
 */
export interface AMeta { source: string; ref: string; commit: string; generatedBy: string; evidence: string }

export interface AClass {
  name: string; service: string; table?: string; columns?: number; attributes: string[]; rowBytes?: number;
  evidence: string; storage: string; note?: string; sharedTable?: string; discriminator?: string;
}

export interface AReference {
  id: string; from: string; to: string; attr?: string; kind: string; mult: string; storage: string;
  crossServiceToday: boolean; evidence: string; note?: string; snapshot?: boolean;
  /** the other end's field; the copy whose rows hold it (an association the copy's service owns) */
  inverse?: string; inCopy?: string;
}

export interface AJoinTable { service: string; table: string; attributes: string[]; evidence: string; joins: string[]; note?: string }

export interface ACopy {
  id: string; service: string; table: string; attributes: string[]; evidence: string; copyOf: Record<string, string[]>;
  fedBy: string[]; note?: string; writers: string[]; readers: string[]; feeders: string[]; own?: unknown; process?: unknown;
}

export interface AAccess {
  class: string; mode: 'read' | 'write'; op?: string; shape: string; rows?: number | string; via?: string; table?: string;
  today: string; at: string; note?: string; evidence: string; statements: number | string; ownerToday: string;
  foreignToday: boolean; strong?: boolean;
  /** a strong read's curated consistency level, its rules and the reason (curated/consistency.yaml) */
  consistency?: { level: 'strict' | 'stale-ok' | 'immutable'; rules: string[]; reason: string };
  when?: string; per?: string; assoc?: string; dbTrigger?: string; topic?: string;
  prob?: number | string; times?: number | string; alt?: unknown;
  /** the reference of an access of an association (`assoc`), e.g. Product.categories */
  reference?: string;
  /** the copy whose table holds the operation's own data the access touches: its home's own data */
  own?: string;
}

export interface ACall {
  /** operations, or the external provider's route (simulation.payment.register) */
  to: string[] | string; how: string; at: string; shape: string; rows?: number | string; strong?: boolean; purpose: string;
  /** a strong call's curated level; `effect` an effect call (a registration with an external provider, no `strong`) */
  consistency?: { level: 'strict' | 'stale-ok' | 'immutable'; rules: string[]; reason: string };
  effect?: boolean;
  evidence: string; note?: string; prob?: number | string; when?: string; per?: string; retries?: unknown;
  /** for a `to` of several fields of one invocation's query: per entry the earlier entry whose objects it is resolved on (null: the first, the field the caller calls) */
  parents?: (number | null)[];
}

export interface APublish { topic: string; at: string; payload: string[]; evidence: string; note?: string; when?: string; prob?: number | string; per?: string }

export interface ATransaction { at: string; classes: string[]; publishInside: boolean; evidence: string; note?: string }

export interface AOperation {
  id: string; service: string; kind: 'query' | 'command' | 'reaction';
  trigger: { graphql?: string; topic?: string; http?: string; schedule?: string };
  entry: string; feature: string; domain: boolean; trivial?: boolean; mechanism?: string;
  /** persistence methods of its accesses that callgraph.py does not reach from the entry */
  notReached?: string[];
  note?: string; sagaStep?: { saga: string; role: string };
  transactions: ATransaction[]; accesses: AAccess[]; calls: ACall[]; publishes: APublish[];
}

export interface AEvent {
  topic: string; role: string; neverPublished?: unknown; externalPublisher?: unknown;
  publishers: { op: string; payload: string[]; evidence: string; when?: string; prob?: number | string }[];
  subscribers: { op: string; service: string; copy: boolean; evidence: string }[];
}

/** kind contributes: the subgraph adds fields to the owner's entity (resolved there); stub: it only references it */
export interface AGatewayJoin { entity: string; owner: string; subgraph: string; kind: string; fields?: string[]; entityResolver?: string; resolverOps?: string[]; evidence: string }

export interface AJoin {
  id: string; service: string; method: string; tables: string[]; classes: string[]; ownClasses: string[]; kinds: string[];
  writes: string[]; sql?: string; evidence: string; usedBy: string[];
  /** a database trigger's statement (method: `trigger <name> (<event>)`) */
  trigger?: boolean;
}

export interface ASaga { name: string; trigger: string; msa: string; operations: { op: string; role: string; trigger?: { topic?: string; http?: string } }[] }

export interface ARequest {
  type: string; document: string;
  /** a connection field's step: what the document selects of it and whether it gives `first` */
  plan: { op: string; via: string; type?: string; field?: string; parent?: number | null; selects?: string[]; first?: boolean }[];
  evidence: string;
}

export interface AFeature { code: string; name: string; msa: boolean; operations: string[] }

export interface APersistenceMethod { method: string; service: string; how: string; reads: string[]; writes: string[]; evidence: string; statements: { sql: string; evidence: string }[] }

/** the mapping to the msa model of the unified project: its round-2 timings seed the operations' demands */
export interface AMsaMapping {
  source: string;
  demands: string;
  operations: { msa: string; kind: string; rate: number; cpuMs: number; dbMs: number; ops: string[]; request?: string; status: string }[];
  entities: { msa: string; sizeKb: number; classes: string[]; status: string }[];
  needs: { need: string; kind: string; callsPerOp: number; strong: boolean; msaMechanismToday?: string; matches?: Record<string, unknown>[]; status: string; msaEvidence?: string }[];
  seedDemands: { method: string; operations: Record<string, { cpuMs: number; dbMs: number; from: string[] }> };
}

export interface Extraction {
  meta: AMeta;
  classes: AClass[];
  joinTables: AJoinTable[];
  copies: ACopy[];
  references: AReference[];
  operations: AOperation[];
  events: AEvent[];
  gatewayJoins: AGatewayJoin[];
  joins: AJoin[];
  sagas: ASaga[];
  requests: ARequest[];
  features: AFeature[];
  persistenceMethods: APersistenceMethod[];
  msaMapping: AMsaMapping;
}

/** what misarch-kotlin has per service, independent of the curation (domain/misarch-inventory.json, inventory.py) */
export interface InventoryService {
  tables: { table: string; columns: string[]; foreignKeys: string[]; rowBytes: number; evidence: string }[];
  triggers: { name: string; table: string; events: string; function: string; reads: string[]; writes: string[]; evidence: string }[];
  /** kind: query, command (root fields), entity (resolvable entity type), field (a candidate resolver) */
  graphql: { graphql: string; kind: 'query' | 'command' | 'entity' | 'field'; returns?: string; args: boolean; evidence: string }[];
  subscriptions: { topic: string; route: string | null; how: string; handler: string | null; declared: string }[];
  publishSites: { topics: string[]; function: string | null; evidence: string }[];
  persistenceMethods: { method: string; how: string; reads: string[]; writes: string[]; evidence: string }[];
  /** HTTP routes and schedules (method SCHEDULE: route is the annotation's argument) */
  routes: { method: string; route: string; evidence: string; function: string | null }[];
  excluded: { trigger: { graphql?: string; topic?: string; http?: string }; reason: string }[];
}
export interface Inventory { meta: AMeta; services: Record<string, InventoryService> }

/** per operation the code that contributes its steps (chains.py on cases/misarch/extract/callgraph.py; contract/verify.ts) */
export type { Chain as AChain, VerifyChains as Chains } from '../../../../core/explorer/contract/verify';
