/**
 * Typed API client for all 5 ET AI News Platform services.
 *
 * All calls go through Next.js API route proxies (/api/*) to avoid
 * browser CORS restrictions. The proxies forward to the actual
 * service ports on the server side.
 */

// Proxy base paths — all relative so they work on any host
const PROXY = {
  vernacular: "/api/vernacular",
  feed:       "/api/feed",
  briefing:   "/api/briefing",
  arc:        "/api/arc",
  video:      "/api/video",
} as const;

export type ServiceName = keyof typeof PROXY;

// ── Shared fetch helper ────────────────────────────────────────────────────────

async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const detail = await res.text().catch(() => res.statusText);
    throw new Error(`API error ${res.status}: ${detail}`);
  }
  return res.json() as Promise<T>;
}

// ── TypeScript interfaces ──────────────────────────────────────────────────────

export interface HealthResponse {
  status: string;
  service: string;
  ffmpeg_available?: boolean;
}

// Vernacular
export interface TranslateResponse {
  article_id: string;
  lang: string;
  translated: string;
  cached: boolean;
}

// Feed
export interface OnboardResponse {
  user_id: string;
  status: string;
}

export interface Article {
  id: string | number;
  title: string;
  summary?: string;
  score?: number;
  url?: string;
}

export interface FeedResponse {
  user_id: string;
  articles: Article[];
}

// Briefing
export interface BriefingSection {
  heading: string;
  body: string;
  source_ids: string[];
}

export interface BriefingResponse {
  topic: string;
  sections: BriefingSection[];
  cached: boolean;
}

// Arc
export interface ArcEntity {
  name: string;
  type: string;
  connections?: number;
}

export interface ArcSentiment {
  article_id: string;
  score: number;
  label: string;
}

export interface ArcProcessResponse {
  article_id: string;
  entities: { name: string; type: string; sentence: number }[];
  sentiment: { score: number; label: string; reason: string };
}

export interface ArcResponse {
  topic: string;
  timeline: ArcSentiment[];
  sentiment_trend: "improving" | "declining" | "stable";
  key_entities: ArcEntity[];
  article_count: number;
  predictions: string[];
  contrarian_view: string;
  watch_for: string;
}

// Video
export interface VideoJobResponse {
  job_id: string;
  status: "queued" | "processing" | "done" | "failed";
}

export interface VideoStatusResponse {
  job_id: string;
  status: "queued" | "processing" | "done" | "failed";
  progress: number;
  output_path: string | null;
  error: string | null;
}

// ── API functions ──────────────────────────────────────────────────────────────

/** Ping a service's /health endpoint via the Next.js proxy. */
export async function healthCheck(service: ServiceName): Promise<HealthResponse> {
  return apiFetch<HealthResponse>(`${PROXY[service]}/health`);
}

// Vernacular ───────────────────────────────────────────────────────────────────

/** Translate an article into the given language code (hi, ta, te, bn, …). */
export async function translateArticle(
  articleId: string,
  text: string,
  lang: string,
): Promise<TranslateResponse> {
  const params = new URLSearchParams({ article_id: articleId, lang, text });
  return apiFetch<TranslateResponse>(
    `${PROXY.vernacular}/translate?${params}`,
  );
}

// Feed ─────────────────────────────────────────────────────────────────────────

/** Onboard a new user with their role, sectors, and tickers. */
export async function onboardUser(
  userId: string,
  role: string,
  sectors: string[],
  tickers: string[],
): Promise<OnboardResponse> {
  return apiFetch<OnboardResponse>(`${PROXY.feed}/onboard`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, role, sectors, tickers }),
  });
}

/** Retrieve the personalised article feed for a user. */
export async function getFeed(userId: string): Promise<FeedResponse> {
  return apiFetch<FeedResponse>(`${PROXY.feed}/feed/${userId}`);
}

/** Send an engagement signal (opened, scroll_50, scroll_100, shared, skipped). */
export async function engageArticle(
  userId: string,
  articleId: string | number,
  signal: "opened" | "scroll_50" | "scroll_100" | "shared" | "skipped",
): Promise<void> {
  await apiFetch<unknown>(`${PROXY.feed}/engage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, article_id: articleId, signal }),
  });
}

// Briefing ─────────────────────────────────────────────────────────────────────

/**
 * Open an SSE stream for /briefing/generate via the Next.js stream proxy.
 * The caller is responsible for closing the EventSource.
 */
export function generateBriefing(topic: string): EventSource {
  const params = new URLSearchParams({ topic });
  return new EventSource(`${PROXY.briefing}/stream?${params}`);
}

/**
 * Open an SSE stream for /briefing/ask via the Next.js stream proxy.
 * The caller is responsible for closing the EventSource.
 */
export function askBriefing(topic: string, question: string): EventSource {
  const params = new URLSearchParams({ topic, question });
  return new EventSource(`${PROXY.briefing}/stream?${params}`);
}

// Arc ──────────────────────────────────────────────────────────────────────────

/** Run the full NER + sentiment pipeline on an article. */
export async function processArcArticle(
  articleId: string,
  topic: string,
  text: string,
  pubDate?: string,
): Promise<ArcProcessResponse> {
  return apiFetch<ArcProcessResponse>(`${PROXY.arc}/arc/process`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      article_id: articleId,
      topic,
      text,
      pub_date: pubDate ?? null,
    }),
  });
}

/** Retrieve the assembled story arc for a topic. */
export async function getArc(topic: string): Promise<ArcResponse> {
  return apiFetch<ArcResponse>(
    `${PROXY.arc}/arc/${encodeURIComponent(topic)}`,
  );
}

// Video ────────────────────────────────────────────────────────────────────────

/** Queue a video generation job. Returns immediately with a job_id. */
export async function generateVideo(
  articleId: string,
  title: string,
  text: string,
): Promise<VideoJobResponse> {
  return apiFetch<VideoJobResponse>(`${PROXY.video}/video/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ article_id: articleId, title, text }),
  });
}

/** Poll the status of a video generation job. */
export async function getVideoStatus(jobId: string): Promise<VideoStatusResponse> {
  return apiFetch<VideoStatusResponse>(
    `${PROXY.video}/video/status/${jobId}`,
  );
}

/** Return the proxied download URL for a completed video job. */
export function getVideoDownloadUrl(jobId: string): string {
  return `${PROXY.video}/video/download/${jobId}`;
}
