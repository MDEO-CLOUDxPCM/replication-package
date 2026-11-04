/**
 * A small parser of mdeo's metamodel files (`metamodel/*.mm`) for the input-model export: classes with attributes and supertypes, enums, references (`A.x[m] *--> B.y[m]`, `-->`,
 * `<-->`), views and section headers, with the comment block before each declaration as its doc.
 * Pure; the exporter (the case packet's export-model.ts) runs it at export time, so the metamodels are never
 * written by hand.
 */
import type { MmAttribute, MmClass, MmEnum, MmReference, MmView } from './types';

export interface ParsedMm {
  /** the comment block at the top of the file */
  description: string;
  imports: string[];
  enums: MmEnum[];
  classes: MmClass[];
  references: MmReference[];
  views: MmView[];
  /** section headers in file order (`// ═══ Name ═══`, or a `// ----` rule followed by `// Name`) */
  sections: string[];
}

const SECTION = /^\/\/\s*[═=]{3,}\s*(.+?)\s*[═=]*\s*$/;
const RULE = /^\/\/\s*-{8,}\s*$/;
const CLASS = /^(abstract\s+)?class\s+(\w+)(?:\s+extends\s+([\w\s,]+?))?\s*\{\s*(\})?\s*(?:\/\/.*)?$/;
const ENUM = /^enum\s+(\w+)\s*\{\s*(?:\/\/\s*(.*))?$/;
const VIEW = /^view\s+(\w+)\s*\{\s*$/;
const REF = /^(\w+)\.(\w+)\[([^\]]*)\]\s*(\*-->|<-->|-->)\s*(\w+)(?:\.(\w+)\[([^\]]*)\])?\s*(?:\/\/.*)?$/;
const ATTR = /^(\w+)\s*:\s*(\w+)(?:\[([^\]]*)\])?\s*(?:\/\/.*)?$/;

/** `[*]` → `*`, `[1]` → `1`, `[0..1]` → `0..1`, no brackets → `1` */
const mult = (m: string | undefined) => (m === undefined || m === '' ? '1' : m.trim());

export function parseMetamodel(text: string): ParsedMm {
  const lines = text.split('\n');
  const out: ParsedMm = { description: '', imports: [], enums: [], classes: [], references: [], views: [], sections: [] };
  // the file's own header: the first comment block
  let i = 0;
  const head: string[] = [];
  while (i < lines.length && lines[i].trim().startsWith('//')) head.push(lines[i++].trim().replace(/^\/\/\s?/, ''));
  out.description = head.join('\n').trim();
  let doc: string[] = [];
  let section: string | undefined;
  let pendingRule = false;
  for (; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trim();
    if (!line) { doc = []; pendingRule = false; continue; }
    const sec = SECTION.exec(line);
    if (sec) { section = sec[1].trim(); out.sections.push(section); doc = []; continue; }
    if (RULE.test(line)) { pendingRule = true; doc = []; continue; }
    if (line.startsWith('//')) {
      const c = line.replace(/^\/\/\s?/, '');
      if (pendingRule && c && !RULE.test(line)) { section = c.trim(); out.sections.push(section); pendingRule = false; continue; }
      doc.push(c);
      continue;
    }
    pendingRule = false;
    const docText = doc.join(' ').replace(/\s+/g, ' ').trim() || undefined;
    doc = [];
    let m: RegExpExecArray | null;
    if ((m = /^import\s+"([^"]+)"/.exec(line))) { out.imports.push(m[1]); continue; }
    if ((m = ENUM.exec(line))) {
      const literals: string[] = [];
      for (i++; i < lines.length && lines[i].trim() !== '}'; i++) {
        const l = lines[i].trim().replace(/\/\/.*$/, '').trim();
        if (l) literals.push(l);
      }
      out.enums.push({ name: m[1], literals, doc: docText ?? (m[2] || undefined), section });
      continue;
    }
    if ((m = VIEW.exec(line))) {
      const members: string[] = [];
      for (i++; i < lines.length && lines[i].trim() !== '}'; i++) {
        const l = lines[i].trim().replace(/\/\/.*$/, '').trim();
        if (l) members.push(l);
      }
      out.views.push({ name: m[1], classes: members });
      continue;
    }
    if ((m = CLASS.exec(line))) {
      const cls: MmClass = {
        name: m[2], abstract: !!m[1], supers: m[3] ? m[3].split(',').map((s) => s.trim()).filter(Boolean) : [],
        attributes: [], doc: docText, section,
      };
      if (!m[4]) {
        let adoc: string[] = [];
        for (i++; i < lines.length && lines[i].trim() !== '}'; i++) {
          const l = lines[i].trim();
          if (!l) { adoc = []; continue; }
          if (l.startsWith('//')) { adoc.push(l.replace(/^\/\/\s?/, '')); continue; }
          const a = ATTR.exec(l);
          if (a) {
            const attr: MmAttribute = { name: a[1], type: a[2], multiplicity: mult(a[3]) };
            const d = adoc.join(' ').replace(/\s+/g, ' ').trim();
            if (d) attr.doc = d;
            cls.attributes.push(attr);
          }
          adoc = [];
        }
      }
      out.classes.push(cls);
      continue;
    }
    if ((m = REF.exec(line))) {
      const kind = m[4] === '*-->' ? 'containment' : m[4] === '<-->' ? 'bidirectional' : 'reference';
      const r: MmReference = { source: m[1], name: m[2], multiplicity: mult(m[3]), kind, target: m[5], doc: docText, section };
      if (m[6]) { r.opposite = m[6]; r.oppositeMultiplicity = mult(m[7]); }
      out.references.push(r);
      continue;
    }
  }
  return out;
}

/** every supertype of a class (transitively), over several parsed metamodels */
export function supertypes(name: string, classes: Map<string, MmClass>): string[] {
  const out: string[] = [];
  const todo = [...(classes.get(name)?.supers ?? [])];
  while (todo.length) {
    const s = todo.shift()!;
    if (out.includes(s)) continue;
    out.push(s);
    todo.push(...(classes.get(s)?.supers ?? []));
  }
  return out;
}
