/**
 * The layouter interface. A layouter places a compound graph: group nodes (services) contain leaf
 * nodes (classes); edges connect leaves (or groups). Implementation: TALA via orthoflow (tala.ts, run in the layout
 * worker). Coordinates in the result are absolute.
 */
export interface LayoutNode {
  id: string;
  /** group (container) id, absent for top-level nodes */
  parent?: string;
  width: number;
  height: number;
  /** groups: true. Their size is computed by the layouter from their children. */
  group?: boolean;
  label?: string;
  /** padding inside a group (room for its header) */
  padding?: { top: number; left: number; bottom: number; right: number };
}

export interface LayoutEdge {
  id: string;
  source: string;
  target: string;
  /** e.g. reference, access, feed, event: a layouter may treat kinds differently (priorities) */
  kind?: string;
  /** larger: keep shorter / straighter */
  weight?: number;
}

export interface LayoutGraph {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  /** preferred order of nodes (e.g. from another design's layout, for a synchronised compare) */
  order?: string[];
  direction?: 'RIGHT' | 'DOWN';
  /**
   * edges have a direction that should shape the layout (e.g. a class diagram: TALA then arranges the nodes in ranks
   * along the edges); default: undirected (edges only pull their ends together)
   */
  directed?: boolean;
}

export interface Box { x: number; y: number; width: number; height: number }

export interface LayoutResult {
  nodes: Record<string, Box>;
  /** per edge: a polyline (absolute), or with `curve` a cubic Bézier [start, c1, c2, end]; empty: not routed */
  edges: Record<string, { points: { x: number; y: number }[]; curve?: boolean }>;
  width: number;
  height: number;
  layouter: string;
  ms: number;
}

export interface Layouter {
  readonly id: string;
  readonly label: string;
  layout(graph: LayoutGraph, signal?: AbortSignal): Promise<LayoutResult>;
}
