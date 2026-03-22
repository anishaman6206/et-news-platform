/**
 * Typed API client for all 5 ET AI News Platform services.
 * All service base URLs are driven by NEXT_PUBLIC_* env vars.
 */

const SERVICES = {
  vernacular: process.env.NEXT_PUBLIC_VERNACULAR_URL ?? "http://localhost:8005",
  feed:       process.env.NEXT_PUBLIC_FEED_URL       ?? "http://localhost:8011",
  briefing:   process.env.NEXT_PUBLIC_BRIEFING_URL   ?? "http://localhost:8002",
  arc:        process.env.NEXT_PUBLIC_ARC_URL        ?? "http://localhost:8004",
  video:      process.env.NEXT_PUBLIC_VIDEO_URL      ?? "http://localhost:8003",
};

export type ServiceName = keyof typeof SERVICES;

// ── Shared helper ──────────────────────────────────────────────────────────────

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

/** Ping a service /health endpoint. */
export async function healthCheck(service: ServiceName): Promise<HealthResponse> {
  return apiFetch<HealthResponse>(`${SERVICES[service]}/health`);
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
    `${SERVICES.vernacular}/translate?${params}`,
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
  return apiFetch<OnboardResponse>(`${SERVICES.feed}/onboard`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, role, sectors, tickers }),
  });
}

/** Retrieve the personalised article feed for a user. */
export async function getFeed(userId: string): Promise<FeedResponse> {
  return apiFetch<FeedResponse>(`${SERVICES.feed}/feed/${userId}`);
}

/** Send an engagement signal (opened, scroll_50, scroll_100, shared, skipped). */
export async function engageArticle(
  userId: string,
  articleId: string | number,
  signal: "opened" | "scroll_50" | "scroll_100" | "shared" | "skipped",
): Promise<void> {
  await apiFetch<unknown>(`${SERVICES.feed}/engage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ user_id: userId, article_id: articleId, signal }),
  });
}

// Briefing ─────────────────────────────────────────────────────────────────────

/**
 * Open an SSE stream for /briefing/generate.
 * The caller is responsible for closing the EventSource.
 */
export function generateBriefing(topic: string): EventSource {
  const params = new URLSearchParams({ topic });
  return new EventSource(`${SERVICES.briefing}/briefing/generate?${params}`);
}

/**
 * Open an SSE stream for /briefing/ask.
 * Uses a POST-backed EventSource via fetch (SSE over POST).
 * Returns an EventSource-like object wrapping fetch + ReadableStream.
 */
export function askBriefing(topic: string, question: string): EventSource {
  const params = new URLSearchParams({ topic, question });
  return new EventSource(
    `${SERVICES.briefing}/briefing/ask?${params}`,
  );
}

// Arc ──────────────────────────────────────────────────────────────────────────

/** Run the full NER + sentiment pipeline on an article. */
export async function processArcArticle(
  articleId: string,
  topic: string,
  text: string,
  pubDate?: string,
): Promise<ArcProcessResponse> {
  return apiFetch<ArcProcessResponse>(`${SERVICES.arc}/arc/process`, {
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
  return apiFetch<ArcResponse>(`${SERVICES.arc}/arc/${encodeURIComponent(topic)}`);
}

// Video ────────────────────────────────────────────────────────────────────────

/** Queue a video generation job. Returns immediately with a job_id. */
export async function generateVideo(
  articleId: string,
  title: string,
  text: string,
): Promise<VideoJobResponse> {
  return apiFetch<VideoJobResponse>(`${SERVICES.video}/video/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ article_id: articleId, title, text }),
  });
}

/** Poll the status of a video generation job. */
export async function getVideoStatus(jobId: string): Promise<VideoStatusResponse> {
  return apiFetch<VideoStatusResponse>(
    `${SERVICES.video}/video/status/${jobId}`,
  );
}

/** Return the direct download URL for a completed video job. */
export function getVideoDownloadUrl(jobId: string): string {
  return `${SERVICES.video}/video/download/${jobId}`;
}
