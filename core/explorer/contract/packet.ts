/**
 * The data packet (contract 1.10.0; docs/packet-format.md): everything the explorer knows of one architecture comes in a
 * packet — a bundle (domains/, runs/, models/; CONTRACT.md) plus a manifest `packet.json` (this file's
 * `PacketManifest`) and the files it names (docs/, verify/). The explorer's code is generic: runs, designs, the
 * Pareto views and the objectives work for any packet; what belongs to a problem family (Palladio PCM with
 * architecture.mm: SEFFs, call sites, mechanisms, the SimOxide detail, C1/C2) is gated by `family` and
 * `capabilities`; what belongs to the case (texts, metric docs, the Verify parts, source trees, commands) is data
 * of the packet. A bundle without packet.json is a packet with the defaults (`defaultManifest`).
 *
 * docs/packet-format.md explains every field; contract/schema/packet.schema.json is generated from this file
 * (`pnpm contract:schema`).
 */
import type { Id } from './types';

/** the problem family of the Palladio architecture optimisation (layer 1 PCM, layer 2 architecture.mm, layer 3 domain.mm) */
export const FAMILY_PALLADIO = 'palladio-architecture';

export interface PacketManifest {
  /** the contract version the packet was built for (CONTRACT_VERSION); the reader checks the major */
  contract: string;
  /** unique among the loaded packets; the namespace of the browser's marks (`explorer-verify-v1:<id>`) */
  id: Id;
  /** shown in the header and the run list */
  name: string;
  description?: string;
  /**
   * the problem family whose generic views apply (`palladio-architecture`: the Model panel over the InputModel, the
   * Interactions tab, the plugin's detail); absent: a plain multi-objective packet (runs, designs, architecture graph)
   */
  family?: string;
  /** the domains of the packet (domains/<id>.json); a run belongs to the packet of its domain */
  domains: Id[];
  builtAt?: string;
  /** the builder (command or script) that wrote the packet */
  builtBy?: string;
  /** hash over the inputs' hashes (and the builder's code): two builds from the same inputs have the same one */
  fingerprint?: string;
  /** what the packet was built from, with content hashes: the backend reports the packet stale when one changed */
  inputs?: PacketInput[];
  /** named directories, relative to the packet directory (or absolute): what `cwd`, source trees and inputs are relative to */
  roots?: Record<string, string>;
  /** the objectives, constraints and metrics the packet's runs report: labels, units, directions, their doc's key */
  objectives?: MeasureDef[];
  constraints?: MeasureDef[];
  metrics?: MeasureDef[];
  /** the words of the problem: mechanisms and styles a design chooses, with labels and explanations */
  vocabulary?: Vocabulary;
  /** name -> file under the packet (docs/*.json or *.md); served inlined with the manifest (GET /api/packets/:id) */
  docs?: Record<string, string>;
  /** what the explorer shows for this packet */
  capabilities?: Capabilities;
  /** named source trees the evidence of the Verify parts (and the Model panel's paths) point into */
  sources?: Record<string, SourceTree>;
  /** the Verify tab's precomputed files (capability `verify`) */
  verify?: VerifySetup;
  /**
   * commands the backend may run for this packet (`simulate`: a design's detail, `rebuild`: the packet again). A
   * command runs only when the backend's LOCAL configuration allows it for this packet (server.local.json
   * `allowCommands`, or EXPLORER_ALLOW_COMMANDS); a packet never enables its own commands
   */
  commands?: Record<string, PacketCommand>;
}

export interface PacketInput {
  /** what it is ("the extraction") */
  label?: string;
  /** a root of `roots` the path is relative to (default: the packet directory) */
  root?: string;
  path: string;
  /** sha256 hex (a prefix is enough) */
  hash: string;
}

export interface MeasureDef {
  key: string;
  label: string;
  /** O1 … O5, C1 …: the short code the docs use */
  code?: string;
  unit?: string;
  direction?: 'minimize' | 'maximize' | 'violation' | 'descriptive';
  digits?: number;
  /** the key of its entry in docs `metrics` (default: `key`) */
  doc?: string;
}

export interface VocabEntry {
  id: string;
  label: string;
  /** a sentence: what it means */
  about?: string;
  /** a shorter label (chips) */
  short?: string;
}

export interface Vocabulary {
  /** the mechanisms of an access or call site (sync, async, cache, copy, join, …) */
  mechanisms?: VocabEntry[];
  /** the styles of a workflow (choreography, orchestration) */
  styles?: VocabEntry[];
  /** the kinds of operations (query, mutation, reaction, …) */
  operationKinds?: VocabEntry[];
  /**
   * the edge layers of the architecture graph (its legend, the mechanism badges, the edges' tooltips): the mechanisms
   * of the accesses (sync, copy, cache, join, saga, local) and `feed`, `event`, `reference`; `about` is the legend's
   * tooltip
   */
  edges?: VocabEntry[];
}

/** a model tab of the Model panel (capability `model`) */
export type ModelTabId = 'how' | 'domain' | 'ops' | 'mech' | 'workload' | 'mm' | 'verify';

export interface Capabilities {
  /** the Model panel (needs an input model, models/<domain>.json, and the family palladio-architecture) */
  model?: boolean;
  /** the Model panel's tabs, in this order (default: all the input model supports) */
  modelTabs?: ModelTabId[];
  /** the Verify tab (needs `verify`) */
  verify?: boolean;
  /** the Performance panel (precomputed, cached or simulated details) */
  performance?: boolean;
  /** opening a design's performance may simulate it now (the command `simulate`, or the dummy simulator) */
  simulate?: boolean;
}

/**
 * A source tree: `git` reads the files of a repository at a commit (`git show <ref>:<path>`), `dir` the working tree
 * of a directory, restricted to the `allow` prefixes. Paths are relative to `root` (a key of `roots`) or the packet.
 */
export type SourceTree =
  | { kind: 'git'; label: string; root?: string; path: string; ref: string; about?: string }
  | { kind: 'dir'; label: string; root?: string; path: string; allow?: string[]; about?: string };

export interface VerifySetup {
  /** verify/parts.json: the parts with their claims and evidence (contract/verify.ts `VerifyParts`) */
  parts: string;
  /** verify/causes.json: per operation part what it causes downstream (`VerifyCauses`) */
  causes?: string;
  /** verify/chains.json: per operation the functions from its entry to its steps (`VerifyChains`) */
  chains?: string;
}

/**
 * A command: `argv` with placeholders `{name}` the backend fills (always: packet, the packet directory, and every
 * root by its name; simulate: model, diff, out, request, build; rebuild: exportArgs, the input model's recorded
 * export arguments — an argument that is only an array placeholder expands to several), run in `cwd` (a key of
 * `roots` or a path relative to the packet)
 */
export interface PacketCommand {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  about?: string;
  timeoutS?: number;
}

/** GET /api/index `packets[]` */
export interface PacketSummary {
  id: Id;
  name: string;
  description?: string;
  family?: string;
  domains: Id[];
  capabilities: Capabilities;
  fingerprint?: string;
  /** the commands the local configuration allows for this packet */
  allowedCommands: string[];
  /** inputs that changed since the build (staleness) */
  stale?: string[];
  /** the packet came without packet.json (a plain bundle) */
  implicit?: boolean;
}

/** GET /api/packets/:id: the manifest with its docs inlined (JSON parsed, Markdown as text) */
export interface PacketBody {
  contract: string;
  manifest: PacketManifest;
  docs: Record<string, unknown>;
  summary: PacketSummary;
}

/** a bundle without packet.json: generic capabilities, its domains, nothing case-specific */
export function defaultManifest(id: Id, domains: Id[], hasModels: boolean, contract: string): PacketManifest {
  return {
    contract, id, name: id, domains,
    capabilities: { model: hasModels, verify: false, performance: true, simulate: true },
  };
}
