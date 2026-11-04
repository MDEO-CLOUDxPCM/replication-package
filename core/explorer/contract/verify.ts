/**
 * The Verify tab's files of a data packet (contract 1.10.0; packet.json `verify`, contract/packet.ts
 * VerifySetup): the model split into parts, each a set of claims (facts, tables of rows) with the evidence they were
 * read from (locations in the packet's source trees) and the documents to read them against; per operation part what
 * it causes downstream (rows the viewer checks one at a time); per operation the code that contributes its steps.
 * A packet's builder writes them (verify/parts.json, causes.json, chains.json); the explorer only shows them.
 *
 * The case defines its kinds of parts, its groups and the scopes of its operations (VerifyParts): the viewer has no
 * list of its own. A part's (and a row's) `fp` is the fingerprint of its claims: a mark made on another fingerprint
 * shows as changed, so a builder must keep it stable for unchanged claims.
 */

import type { Consistency } from './types';

// ---------------------------------------------------------------- claims

/** a place in a source tree of the packet (`repo`: a key of packet.json `sources`); no line: the whole file */
export interface Loc { repo: string; path: string; line?: number; label?: string }
/** a token of a claim: text, a link to another part (its key), code, a chip */
export type Tok = string | { part: string; label: string } | { code: string } | { chip: string; tone?: 'muted' | 'warn' | 'ok' };
/** volatile: not part of the fingerprint (rates, reach: they change without the claim changing) */
export interface Fact { label: string; value: Tok[]; ev?: Loc[]; volatile?: boolean }
export interface Row { cells: Tok[][]; ev: Loc[]; note?: string }
export interface Table { title: string; hint?: string; columns: string[]; rows: Row[]; volatile?: boolean }
/** a document to read the part against; `find`: regexes applied in order, each from the previous match on; kind: a key of VerifyParts.docKinds */
export interface DocRef { label: string; kind: string; loc: Loc; find?: string[] }

export interface Part {
  /** `<kind>:<id>`; an operation's part is `op:<operation id>` (its causes and chain are under that key and id) */
  key: string;
  /** an id of VerifyParts.kinds */
  kind: string;
  /** what the list groups it under (a service, or one of VerifyParts.lateGroups) */
  group: string;
  title: string;
  subtitle?: string;
  /** an operation's: an id of VerifyParts.scopes */
  scope?: string;
  /** a coverage part: entries that no part covers (to check) */
  flagged?: number;
  facts: Fact[];
  tables: Table[];
  /** a block of text shown as code (SQL, a GraphQL document, a session's steps) */
  code?: { label: string; text: string };
  /** SEFFs of the input model to show (the generated behaviour); `request`: the SEFF is that request's */
  seffs?: { id: string; label: string; request?: string }[];
  docs: DocRef[];
  /** the place in the other Model tabs (a model target) */
  modelTarget?: string;
  /** lower-case text the list's filter searches */
  text: string;
  /** the fingerprint of the claims (facts and tables that are not volatile, code) */
  fp: string;
}

export interface PartKindDef { id: string; label: string; plural: string; short: string }
/** where an operation stands in the model; `inModel`: the filter "in the model" keeps it; `badge`: shown beside it in the list */
export interface ScopeDef { label: string; about: string; inModel?: boolean; badge?: string }

/** verify/parts.json */
export interface VerifyParts {
  /** the contract version the file was written for */
  contract: string;
  /** the source tree the code evidence and the chains point into (a key of packet.json `sources`) */
  tree?: string;
  /** the commit of that tree the evidence is read at */
  commit?: string;
  /** the kinds of parts, in the order of the list */
  kinds: PartKindDef[];
  /** groups shown after the others (by group), in this order */
  lateGroups: string[];
  /** the scopes of the operations' parts, in the order of the filter */
  scopes: Record<string, ScopeDef>;
  /** per DocRef kind the short label of its chip (default: the kind) */
  docKinds?: Record<string, string>;
  /** per part kind the labels of the facts shown above what it causes (the rest under "More") */
  leadFacts?: Record<string, string[]>;
  parts: Part[];
}

// ---------------------------------------------------------------- what an operation causes

export type CauseKind = 'root' | 'fetched' | 'reaction' | 'calledBack' | 'calledBy' | 'scheduled' | 'home' | 'read' | 'field' | 'write' | 'event' | 'callback' | 'copy' | 'call' | 'code';

export interface Cause {
  /** unique within the operation; the row's mark is `<part key>#<key>` */
  key: string;
  kind: CauseKind;
  /** the class read or written, the reaction, callback or callee */
  cls?: string;
  /** a read or write of a reference: its id */
  via?: string;
  op?: string;
  /** a copy feed's readers: the operations whose sites read the copy */
  readers?: string[];
  /** an event's topic; a field's (or root resolver's) request type: the row belongs to that request only */
  topic?: string;
  request?: string;
  /** expected executions per execution of the caller (an event's raise probability) */
  p?: number;
  /**
   * the model's side: the call sites (their allowed mechanisms and today's) and what the model makes of it; `own` (not
   * a mechanism; accepts the older spelling `local`) stands for an access to the home class's own data
   */
  allowed: string[];
  today?: string;
  model: string[];
  /**
   * (contract 1.13.0) a read's or call's curated consistency level with its rules and reason (only
   * where the case curated one, or the level is not stale-ok); `effect` an effect call's rules (E1), in a callback row
   */
  consistency?: Consistency;
  effect?: { to: string; rules: string[]; reason?: string }[];
  /** the code's side: where it happens and how today's code does it */
  ev: Loc[];
  code: string[];
  fp: string;
}

export interface Causes { rows: Cause[] }

/** verify/causes.json: part key (`op:<id>`) -> what the operation causes */
export type VerifyCauses = Record<string, Causes>;

// ---------------------------------------------------------------- the code contributing an operation's steps

/**
 * per operation the code that contributes its steps: the functions on a path from the entry (`root`; a pseudo key
 * `<lambda@path:line>` for a route or subscription block) to a step site, with their declarations, and the call
 * sites between them; paths in VerifyParts.tree. reached: false, a step's function the walk misses.
 */
export interface Chain {
  root: string;
  nodes: { key: string; decl: { path: string; line: number; end: number }[]; pm: boolean; step: boolean; reached: boolean }[];
  calls: { from: string; to: string; path: string; line: number; col: number; len: number }[];
  unreached: { evidence: string; function: string }[];
}

/** verify/chains.json: operation id -> its chain (or why there is none) */
export type VerifyChains = Record<string, Chain | { error: string }>;
