/**
 * Syntax highlighting of the source pane: Shiki (TextMate grammars on its JavaScript regex engine), loaded on first
 * use with only the grammars of the files shown. Every token carries both themes' colours (github-light and
 * github-dark as --shiki-light / --shiki-dark, picked by the `dark` class). Files too large to tokenize stay plain.
 */
import { useEffect, useState } from 'react';
import type { HighlighterCore } from 'shiki/core';
import type { HlTok } from './related';

/** the grammar of a file, by extension (or name) */
const LANGS: Record<string, () => Promise<unknown>> = {
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  properties: () => import('shiki/langs/properties.mjs'),
  shellscript: () => import('shiki/langs/shellscript.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
};
const EXT: Record<string, keyof typeof LANGS> = {
  kt: 'kotlin', kts: 'kotlin', sql: 'sql', yaml: 'yaml', yml: 'yaml', graphql: 'graphql', graphqls: 'graphql', gql: 'graphql',
  json: 'json', md: 'markdown', py: 'python', toml: 'toml', properties: 'properties', sh: 'shellscript', xml: 'xml', dockerfile: 'dockerfile',
};
export function langOf(path: string): keyof typeof LANGS | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  return EXT[name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name];
}

const MAX_CHARS = 400_000;
let core: Promise<HighlighterCore> | null = null;
const langs = new Map<string, Promise<void>>();
const cache = new Map<string, HlTok[][]>();

async function highlighter(lang: keyof typeof LANGS) {
  core ??= Promise.all([import('shiki/core'), import('shiki/engine/javascript'), import('shiki/themes/github-light.mjs'), import('shiki/themes/github-dark.mjs')])
    .then(([{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark]) =>
      createHighlighterCore({ themes: [light.default, dark.default], langs: [], engine: createJavaScriptRegexEngine({ forgiving: true }) }));
  const hl = await core;
  if (!langs.has(lang)) langs.set(lang, LANGS[lang]().then((m) => hl.loadLanguage((m as { default: Parameters<HighlighterCore['loadLanguage']>[0] }).default)));
  await langs.get(lang);
  return hl;
}

/** the tokens of each line, or undefined while loading (and for files that stay plain) */
export function useHighlight(path: string | undefined, text: string | undefined): HlTok[][] | undefined {
  const lang = path ? langOf(path) : undefined;
  const key = lang && text !== undefined && text.length <= MAX_CHARS ? `${lang}\0${path}\0${text}` : undefined;
  const [got, setGot] = useState<{ key: string; lines: HlTok[][] } | null>(null);
  useEffect(() => {
    if (!key || cache.has(key)) return;
    let live = true;
    highlighter(lang!).then((hl) => {
      const { tokens } = hl.codeToTokens(text!.replace(/\n$/, ''), { lang: lang!, themes: { light: 'github-light', dark: 'github-dark' }, defaultColor: false, tokenizeMaxLineLength: 2000 });
      const lines = tokens.map((l) => l.map((t) => ({ content: t.content, style: t.htmlStyle as Record<string, string> | undefined })));
      if (cache.size > 24) cache.delete(cache.keys().next().value!);
      cache.set(key, lines);
      if (live) setGot({ key, lines });
    }).catch(() => undefined);
    return () => { live = false; };
  }, [key, lang, text]);
  return key ? cache.get(key) ?? (got?.key === key ? got.lines : undefined) : undefined;
}
