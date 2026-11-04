import { memo, useMemo } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';

/** a TeX formula (KaTeX, rendered to HTML; inherits the text colour, so it follows the theme) */
export const Tex = memo(function Tex({ tex, display = false, className }: { tex: string; display?: boolean; className?: string }) {
  const html = useMemo(() => {
    try { return katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: 'ignore', output: 'html' }); }
    catch { return tex; }
  }, [tex, display]);
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
});
