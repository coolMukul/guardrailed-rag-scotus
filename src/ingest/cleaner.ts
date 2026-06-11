import type { CourtListenerOpinion } from './courtlistener-client.js';

export type SectionLabel =
  | 'majority'
  | 'concurrence'
  | 'dissent'
  | 'combined'
  | 'other';

export interface SectionMeta {
  label: SectionLabel;
  opinion_type: string;
  opinion_id: number;
  author: string | null;
  text_source: string;
  start_offset: number;
  end_offset: number;
  text_length: number;
}

export interface CleanedCluster {
  text: string;
  sections: SectionMeta[];
}

export function cleanCluster(opinions: CourtListenerOpinion[]): CleanedCluster {
  const ordered = [...opinions].sort(
    (a, b) => sectionOrder(mapLabel(a.type)) - sectionOrder(mapLabel(b.type)),
  );

  let text = '';
  const sections: SectionMeta[] = [];

  for (const op of ordered) {
    const selected = selectBestText(op);
    if (!selected) continue;

    const label = mapLabel(op.type);
    const header = op.author_str
      ? `\n\n=== ${label.toUpperCase()} (${op.author_str}) ===\n\n`
      : `\n\n=== ${label.toUpperCase()} ===\n\n`;

    text += header;
    const start = text.length;
    text += selected.text;
    const end = text.length;

    sections.push({
      label,
      opinion_type: op.type,
      opinion_id: op.id,
      author: op.author_str,
      text_source: selected.source,
      start_offset: start,
      end_offset: end,
      text_length: end - start,
    });
  }

  return { text: text.trim(), sections };
}

function mapLabel(type: string): SectionLabel {
  const t = type.toLowerCase();
  if (t.includes('combined')) return 'combined';
  if (t.includes('lead') || t.includes('plurality') || t.includes('unanimous')) {
    return 'majority';
  }
  if (t.includes('concurrence')) return 'concurrence';
  if (t.includes('dissent')) return 'dissent';
  return 'other';
}

function sectionOrder(label: SectionLabel): number {
  switch (label) {
    case 'majority':
    case 'combined':
      return 0;
    case 'concurrence':
      return 1;
    case 'dissent':
      return 2;
    default:
      return 3;
  }
}

interface SelectedText {
  source: string;
  text: string;
}

function selectBestText(op: CourtListenerOpinion): SelectedText | null {
  const html = op.html_with_citations ?? op.html ?? op.html_lawbox ?? op.html_columbia;
  if (isUsable(html)) {
    const source =
      op.html_with_citations && isUsable(op.html_with_citations)
        ? 'html_with_citations'
        : op.html && isUsable(op.html)
          ? 'html'
          : op.html_lawbox && isUsable(op.html_lawbox)
            ? 'html_lawbox'
            : 'html_columbia';
    return { source, text: stripHtml(html!) };
  }
  if (isUsable(op.xml_harvard)) {
    return { source: 'xml_harvard', text: stripHtml(op.xml_harvard!) };
  }
  if (isUsable(op.plain_text)) {
    return { source: 'plain_text', text: normalizeWhitespace(op.plain_text!) };
  }
  return null;
}

function isUsable(s: string | null | undefined): boolean {
  return typeof s === 'string' && s.trim().length >= 100;
}

function stripHtml(html: string): string {
  let s = html;
  s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<br\s*\/?>/gi, '\n');
  s = s.replace(/<\/(p|div|h[1-6]|li|tr|blockquote|section|article)>/gi, '\n\n');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  return normalizeWhitespace(s);
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&sect;/g, '§')
    .replace(/&para;/g, '¶')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h: string) =>
      String.fromCharCode(parseInt(h, 16)),
    );
}

function normalizeWhitespace(s: string): string {
  return fixMojibake(s)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Detects classic UTF-8-misread-as-Latin1 mojibake (e.g. left double-quote
// 0xE2 0x80 0x9C arriving as the three Latin-1 chars 'â' '' '').
// If the pattern matches, round-trip through Latin-1 -> UTF-8 to recover.
function fixMojibake(s: string): string {
  if (!/[ÂÃâ][-¿]/.test(s)) return s;
  try {
    const fixed = Buffer.from(s, 'latin1').toString('utf8');
    if (!fixed.includes('�')) return fixed;
  } catch {
    /* fall through to return original */
  }
  return s;
}
