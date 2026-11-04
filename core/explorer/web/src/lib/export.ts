/** SVG and PDF export (always the light theme). */
import { jsPDF } from 'jspdf';
import 'svg2pdf.js';

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

function download(blob: Blob, name: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

export function downloadSvg(svg: string, name: string) {
  download(new Blob([svg], { type: 'image/svg+xml' }), `${name}.svg`);
}

export async function svgToPdfBlob(svg: string): Promise<Blob> {
  const el = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement as unknown as SVGSVGElement;
  const w = parseFloat(el.getAttribute('width') ?? '800');
  const h = parseFloat(el.getAttribute('height') ?? '600');
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-99999px;top:0';
  host.appendChild(el);
  document.body.appendChild(host);
  try {
    const pdf = new jsPDF({ orientation: w > h ? 'landscape' : 'portrait', unit: 'pt', format: [w, h], compress: true });
    await pdf.svg(el, { x: 0, y: 0, width: w, height: h });
    return pdf.output('blob');
  } finally {
    host.remove();
  }
}

export async function downloadPdf(svg: string, name: string) {
  download(await svgToPdfBlob(svg), `${name}.pdf`);
}

export async function exportAs(kind: 'svg' | 'pdf', svg: string, name: string) {
  if (kind === 'svg') downloadSvg(svg, name);
  else await downloadPdf(svg, name);
}
