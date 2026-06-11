const BASE_URL = 'https://www.courtlistener.com/api/rest/v4';
const DEFAULT_THROTTLE_MS = 500;
const MAX_ATTEMPTS = 4;
const MAX_RETRY_WAIT_MS = 60_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, Math.max(0, ms)));

export interface CourtListenerCitation {
  volume: number;
  reporter: string;
  page: string;
  type: number;
}

export interface CourtListenerCluster {
  id: number;
  case_name: string;
  case_name_short: string | null;
  case_name_full: string | null;
  date_filed: string | null;
  docket: string | null;
  docket_id: number | null;
  citations: CourtListenerCitation[];
  sub_opinions: string[];
  headnotes: string | null;
  summary: string | null;
  syllabus: string | null;
  [key: string]: unknown;
}

export interface CourtListenerOpinion {
  id: number;
  resource_uri: string;
  type: string;
  author_str: string | null;
  html_with_citations: string | null;
  html: string | null;
  plain_text: string | null;
  html_lawbox: string | null;
  html_columbia: string | null;
  xml_harvard: string | null;
  [key: string]: unknown;
}

export interface ClustersPage {
  count: number;
  next: string | null;
  previous: string | null;
  results: CourtListenerCluster[];
}

function authHeaders(): Record<string, string> {
  const token = process.env.COURTLISTENER_TOKEN?.trim();
  if (!token) throw new Error('COURTLISTENER_TOKEN not set. Add it to .env.');
  return {
    Authorization: `Token ${token}`,
    'User-Agent': 'guardrailed-rag-scotus/0.1',
    Accept: 'application/json',
  };
}

async function fetchJson<T>(url: string, throttleMs = DEFAULT_THROTTLE_MS): Promise<T> {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await fetch(url, { headers: authHeaders() });

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after') ?? '30');
      const waitMs = Math.min(retryAfter * 1000 + 500, MAX_RETRY_WAIT_MS);
      console.warn(`[courtlistener] 429 on ${url}, waiting ${waitMs}ms`);
      await sleep(waitMs);
      continue;
    }

    if (res.status >= 500 && attempt < MAX_ATTEMPTS) {
      const waitMs = 1000 * Math.pow(2, attempt - 1);
      console.warn(`[courtlistener] ${res.status} on ${url}, retrying in ${waitMs}ms`);
      await sleep(waitMs);
      continue;
    }

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `CourtListener ${res.status} on ${url}: ${body.slice(0, 300)}`,
      );
    }

    const data = (await res.json()) as T;
    await sleep(throttleMs);
    return data;
  }
  throw new Error(`CourtListener: exhausted ${MAX_ATTEMPTS} attempts on ${url}`);
}

export async function listSCOTUSClusters(
  page = 1,
  pageSize = 50,
): Promise<ClustersPage> {
  const url =
    `${BASE_URL}/clusters/` +
    `?docket__court=scotus` +
    `&order_by=-date_filed` +
    `&page_size=${pageSize}` +
    `&page=${page}`;
  return fetchJson<ClustersPage>(url);
}

export async function getCluster(id: number): Promise<CourtListenerCluster> {
  return fetchJson<CourtListenerCluster>(`${BASE_URL}/clusters/${id}/`);
}

export async function getOpinion(id: number): Promise<CourtListenerOpinion> {
  return fetchJson<CourtListenerOpinion>(`${BASE_URL}/opinions/${id}/`);
}

export function extractIdFromUri(uri: string): number {
  const match = uri.match(/\/(\d+)\/?$/);
  if (!match || !match[1]) {
    throw new Error(`Cannot extract ID from URI: ${uri}`);
  }
  return Number(match[1]);
}
