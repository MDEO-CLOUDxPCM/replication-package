/**
 * The Verify tab's marks: per part verified or an issue, a note, and the part's fingerprint at the time (a part whose
 * claims changed since shows as changed). Kept in this browser's localStorage per packet (`explorer-verify-v1:<packet
 * id>`, lib/packet.tsx packetKey; synced between its tabs); export and import as JSON move them elsewhere.
 */
import { create } from 'zustand';
import type { Part } from '@contract/verify';
import { packetKey, type Tx } from '@/lib/packet';

export interface Mark { ok?: boolean; issue?: boolean; note?: string; fp: string; at: string }
export type Marks = Record<string, Mark>;
export type MarkStatus = 'open' | 'ok' | 'changed' | 'issue';
/** what a mark is for: a part, or a row of a part (`<part key>#<row key>`, a row of what an operation causes) */
export type Markable = Pick<Part, 'key' | 'fp'>;

export const MARKS_KEY = 'explorer-verify-v1';
type Store = Pick<Storage, 'getItem' | 'setItem'>;
const storage = (): Store | null => { try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; } };

function parse(text: string | null | undefined): Marks {
  try { const m = JSON.parse(text ?? '{}'); return m && typeof m === 'object' && !Array.isArray(m) ? (m as Marks) : {}; } catch { return {}; }
}
function read(key: string | null): Marks {
  if (!key) return {};
  try { return parse(storage()?.getItem(key)); } catch { return {}; }
}
function write(key: string | null, m: Marks) {
  if (!key) return;
  try { storage()?.setItem(key, JSON.stringify(m)); } catch { /* blocked: the marks last as long as the page */ }
}

/** marks merged into others: a mark is taken over when the other has none for its key or an earlier one (`at`) */
export function mergeMarks(cur: Marks, m: Marks): { marks: Marks; n: number } {
  const out = { ...cur };
  let n = 0;
  for (const [k, v] of Object.entries(m)) {
    if (!v || typeof v.fp !== 'string' || typeof v.at !== 'string') continue;
    if (!out[k] || out[k].at < v.at) { out[k] = v; n++; }
  }
  return { marks: out, n };
}

interface MarksState {
  /** the packet whose marks these are, and their storage key (null: none opened, kept in memory only) */
  packet?: string;
  key: string | null;
  marks: Marks;
  /** switch to a packet's marks */
  open: (packet: string | undefined) => void;
  toggleOk: (p: Markable) => void;
  toggleIssue: (p: Markable) => void;
  setNote: (p: Markable, note: string) => void;
  /** merge imported marks: the later of two marks of a part wins */
  merge: (m: Marks) => number;
}

const put = (key: string | null, marks: Marks, p: Markable, patch: Partial<Mark>): Marks => {
  const next = { ...marks[p.key], ...patch, fp: p.fp, at: new Date().toISOString() };
  const copy = { ...marks };
  if (!next.ok && !next.issue && !next.note) delete copy[p.key];
  else copy[p.key] = next;
  write(key, copy);
  return copy;
};

export const useMarks = create<MarksState>((set, get) => ({
  key: null,
  marks: {},
  open: (packet) => {
    if (!packet) { if (get().packet !== undefined || get().key !== null) set({ packet: undefined, key: null, marks: {} }); return; }
    const key = packetKey(MARKS_KEY, packet);
    if (get().key === key && get().packet === packet) return;
    set({ packet, key, marks: read(key) });
  },
  toggleOk: (p) => { const m = get().marks[p.key]; const ok = !(m?.ok && m.fp === p.fp); set({ marks: put(get().key, get().marks, p, { ok, issue: ok ? false : m?.issue }) }); },
  toggleIssue: (p) => { const issue = !get().marks[p.key]?.issue; set({ marks: put(get().key, get().marks, p, { issue, ok: issue ? false : get().marks[p.key]?.ok }) }); },
  setNote: (p, note) => set({ marks: put(get().key, get().marks, p, { note: note || undefined }) }),
  merge: (m) => {
    const { marks, n } = mergeMarks(get().marks, m);
    write(get().key, marks);
    set({ marks });
    return n;
  },
}));

// another tab of this browser changed the marks
if (typeof window !== 'undefined') window.addEventListener('storage', (e) => { const { key } = useMarks.getState(); if (key && e.key === key) useMarks.setState({ marks: read(key) }); });

export function statusOf(p: Markable, m: Mark | undefined): MarkStatus {
  if (m?.issue) return 'issue';
  if (m?.ok) return m.fp === p.fp ? 'ok' : 'changed';
  return 'open';
}

export function exportMarks(marks: Marks, commit: string | undefined, packet?: string) {
  const body = JSON.stringify({ kind: 'explorer-verify', ...(packet ? { packet } : {}), commit, exportedAt: new Date().toISOString(), marks }, null, 1);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
  a.download = `verify-progress-${new Date().toISOString().slice(0, 16).replace(':', '')}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/**
 * the issues and notes as Markdown (to paste into a ticket or a chat); the packet's texts `verify.issues.title` and
 * `verify.issues.head` ({{tree}}, {{commit}}, {{n}}) head it, else a generic heading
 */
export function issuesMarkdown(parts: Pick<Part, 'key' | 'group'>[], marks: Marks, o: { tx?: Tx; tree?: string; commit?: string } = {}): string {
  const group = new Map(parts.map((p) => [p.key, p.group]));
  const rows = Object.entries(marks).filter(([k, m]) => (m.issue || m.note) && group.has(k.split('#')[0]));
  const vars = { tree: o.tree, commit: o.commit?.slice(0, 12) ?? '?', n: rows.length };
  const title = o.tx?.('verify.issues.title', vars) || '# Verification: issues and notes';
  const head = o.tx?.('verify.issues.head', vars) || `${o.tree ? `${o.tree} ` : ''}${vars.commit}; ${rows.length} marks.`;
  const lines = [title, '', head, ''];
  for (const [k, m] of rows) {
    lines.push(`- **${m.issue ? 'issue' : 'note'}** \`${k}\` (${group.get(k.split('#')[0])})${m.note ? `: ${m.note.replace(/\n+/g, ' ')}` : ''}`);
  }
  return lines.join('\n');
}
