import type { CourtListenerCitation } from './courtlistener-client.js';
import type { SectionMeta } from './cleaner.js';

export interface ClusterForChunking {
  cluster_id: number;
  case_name: string;
  citations: CourtListenerCitation[] | null;
  date_filed: string | null;
  text: string;
  sections: SectionMeta[];
}

export interface Chunk {
  chunk_id: string;
  cluster_id: number;
  opinion_id: number;
  case_name: string;
  citation: string | null;
  section: string;
  author: string | null;
  year: number | null;
  text: string;
  char_count: number;
  approx_tokens: number;
  start_offset: number;
  end_offset: number;
}

export const TARGET_CHARS = 3200;
export const OVERLAP_CHARS = 400;
export const MIN_CHUNK_CHARS = 200;

export interface ChunkOptions {
  /** Target chunk size in characters (~4 chars per token). */
  targetChars: number;
  /** Overlap between adjacent chunks in characters. */
  overlapChars: number;
}

const DEFAULT_OPTIONS: ChunkOptions = {
  targetChars: TARGET_CHARS,
  overlapChars: OVERLAP_CHARS,
};

export function chunkCluster(
  input: ClusterForChunking,
  options: ChunkOptions = DEFAULT_OPTIONS,
): Chunk[] {
  const chunks: Chunk[] = [];
  const citation = formatCitation(input.citations, input.date_filed);
  const year = parseYear(input.date_filed);

  for (const section of input.sections) {
    const sectionText = input.text.slice(section.start_offset, section.end_offset);
    if (sectionText.trim().length === 0) continue;

    const pieces = splitSection(sectionText, options);
    pieces.forEach((piece, idx) => {
      if (piece.text.length < MIN_CHUNK_CHARS && pieces.length > 1) return;
      chunks.push({
        chunk_id: `${input.cluster_id}-${section.opinion_id}-${idx}`,
        cluster_id: input.cluster_id,
        opinion_id: section.opinion_id,
        case_name: input.case_name,
        citation,
        section: section.label,
        author: section.author,
        year,
        text: piece.text,
        char_count: piece.text.length,
        approx_tokens: Math.ceil(piece.text.length / 4),
        start_offset: section.start_offset + piece.start,
        end_offset: section.start_offset + piece.end,
      });
    });
  }

  return chunks;
}

interface Piece {
  text: string;
  start: number;
  end: number;
}

function splitSection(text: string, options: ChunkOptions): Piece[] {
  if (text.length <= options.targetChars) {
    return [{ text, start: 0, end: text.length }];
  }

  const paragraphs = splitParagraphs(text);
  const chunks: Piece[] = [];
  let buf: Piece[] = [];
  let bufLen = 0;

  for (const para of paragraphs) {
    if (para.text.length > options.targetChars) {
      if (buf.length) {
        chunks.push(materialize(buf));
        buf = [];
        bufLen = 0;
      }
      for (const sub of hardSplit(para, options)) chunks.push(sub);
      continue;
    }

    const wouldExceed = bufLen + para.text.length + 2 > options.targetChars;
    if (wouldExceed && buf.length > 0) {
      chunks.push(materialize(buf));
      buf = takeOverlap(buf, options.overlapChars);
      bufLen = totalLen(buf);
    }
    buf.push(para);
    bufLen += para.text.length + 2;
  }

  if (buf.length) chunks.push(materialize(buf));
  return chunks;
}

function splitParagraphs(text: string): Piece[] {
  const out: Piece[] = [];
  const re = /\n\n+/g;
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > cursor) {
      const slice = text.slice(cursor, m.index);
      if (slice.trim().length > 0) {
        out.push({ text: slice, start: cursor, end: m.index });
      }
    }
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) {
    const slice = text.slice(cursor);
    if (slice.trim().length > 0) {
      out.push({ text: slice, start: cursor, end: text.length });
    }
  }
  return out;
}

function materialize(paras: Piece[]): Piece {
  const first = paras[0]!;
  const last = paras[paras.length - 1]!;
  const text = paras.map((p) => p.text).join('\n\n');
  return { text, start: first.start, end: last.end };
}

function totalLen(paras: Piece[]): number {
  return paras.reduce((s, p) => s + p.text.length + 2, 0);
}

function takeOverlap(buf: Piece[], overlapChars: number): Piece[] {
  const out: Piece[] = [];
  let len = 0;
  for (let i = buf.length - 1; i >= 0; i--) {
    out.unshift(buf[i]!);
    len += buf[i]!.text.length + 2;
    if (len >= overlapChars) break;
  }
  return out;
}

function hardSplit(para: Piece, options: ChunkOptions): Piece[] {
  const out: Piece[] = [];
  const text = para.text;
  // Sentence-boundary search window scales with chunk size (was 600 for 3200 chars)
  const sentenceWindow = Math.max(200, Math.round(options.targetChars * 0.1875));
  let i = 0;
  while (i < text.length) {
    const limit = Math.min(i + options.targetChars, text.length);
    let breakAt = limit;
    if (limit < text.length) {
      const window = text.slice(i, limit);
      const sentEnd = findLastSentenceEnd(window);
      if (sentEnd >= options.targetChars - sentenceWindow) {
        breakAt = i + sentEnd;
      }
    }
    out.push({
      text: text.slice(i, breakAt),
      start: para.start + i,
      end: para.start + breakAt,
    });
    if (breakAt >= text.length) break;
    i = Math.max(0, breakAt - options.overlapChars);
  }
  return out;
}

function findLastSentenceEnd(text: string): number {
  const re = /[.!?]\s+(?=[A-Z])/g;
  let last = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    last = m.index + m[0].length;
  }
  return last;
}

function formatCitation(
  citations: CourtListenerCitation[] | null,
  dateFiled: string | null,
): string | null {
  if (!citations || citations.length === 0) return null;
  const us = citations.find((c) => {
    const r = c.reporter.replace(/\s+/g, '').toUpperCase();
    return r === 'U.S.' || r === 'US';
  });
  const c = us ?? citations[0]!;
  const year = dateFiled?.slice(0, 4);
  const yearSuffix = year ? ` (${year})` : '';
  const page = c.page && c.page.length > 0 ? c.page : '___';
  return `${c.volume} ${c.reporter} ${page}${yearSuffix}`;
}

function parseYear(dateFiled: string | null): number | null {
  if (!dateFiled) return null;
  const y = Number(dateFiled.slice(0, 4));
  return Number.isFinite(y) ? y : null;
}
