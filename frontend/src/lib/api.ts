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
  agent:      "/api/agent",
  ingestion:  "/api/ingestion",
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
  articles: IngestedArticle[];
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
  title?: string;
  created_at?: string;
}

export interface VideoJobsResponse {
  jobs: VideoStatusResponse[];
}

// Ingestion — matches the Qdrant payload stored by ingestion-pipeline
export interface IngestedArticle {
  article_id: string;
  title: string;
  summary?: string;
  topic?: string;       // fallback subtitle used by some downstream services
  source?: string;
  pub_ts?: number | null;   // unix timestamp (seconds) — float from Python
  pub_date?: string | null; // ISO date string
  section?: string;
  url?: string;
}

export interface IngestedArticlesResponse {
  articles: IngestedArticle[];
  total?: number;
}

// Vernacular batch
export interface TranslateBatchItem {
  id: string;
  text: string;
}

export interface TranslateBatchResult {
  id: string;
  translated: string;
  lang: string;
}

export interface TranslateBatchResponse {
  translations: TranslateBatchResult[];
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
    body: JSON.stringify({ user_id: userId, role: role.toLowerCase(), sectors, tickers }),
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

/** List recent video jobs (last 10, newest first). */
export async function listVideoJobs(): Promise<VideoJobsResponse> {
  return apiFetch<VideoJobsResponse>(`${PROXY.video}/video/jobs`);
}

/** Return the proxied download URL for a completed video job. */
export function getVideoDownloadUrl(jobId: string): string {
  return `${PROXY.video}/video/download/${jobId}`;
}

// Agent ─────────────────────────────────────────────────────────────────────

export interface AgentHealth {
  status: string;
  service: string;
  last_run: number | null;
  articles_processed_today: number;
  tools_invoked_today: number;
}

export interface AgentDecision {
  article_id: string;
  article_title: string;
  section: string;
  decided_at: string;
  reasoning: string;
  tools_invoked: string[] | string;
  tool_results: Record<string, unknown>;
  status: "completed" | "partial" | "failed";
  duration_ms: number;
}

export interface AgentStats {
  total_articles_processed: number;
  total_tools_invoked: number;
  tools_breakdown: Record<string, number>;
  avg_tools_per_article: number;
  last_run_at: string | null;
}

export interface AgentRunSummary {
  articles_processed?: number;
  tools_invoked_total?: number;
  decisions?: unknown[];
  status?: string;
  message?: string;
}

export async function getAgentHealth(): Promise<AgentHealth> {
  return apiFetch<AgentHealth>(`${PROXY.agent}/health`);
}

export async function getAgentDecisions(
  limit = 20,
): Promise<{ decisions: AgentDecision[] }> {
  return apiFetch<{ decisions: AgentDecision[] }>(
    `${PROXY.agent}/agent/decisions?limit=${limit}`,
  );
}

export async function getAgentStats(): Promise<AgentStats> {
  return apiFetch<AgentStats>(`${PROXY.agent}/agent/stats`);
}

// Arc topics
export async function getArcTopics(): Promise<{ topics: string[] }> {
  return apiFetch<{ topics: string[] }>(`${PROXY.arc}/topics`);
}

export async function triggerAgentCycle(): Promise<AgentRunSummary> {
  return apiFetch<AgentRunSummary>(`${PROXY.agent}/agent/trigger`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
}

// Ingestion ───────────────────────────────────────────────────────────────────

/** Fetch ingested articles.
 *  Omits the section filter when section is "all" or empty — the ingestion
 *  service would otherwise try to match a literal "all" section in Qdrant. */
export async function getIngestedArticles(
  limit = 50,
  section = "all",
): Promise<IngestedArticlesResponse> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (section && section !== "all") params.set("section", section);
  return apiFetch<IngestedArticlesResponse>(
    `${PROXY.ingestion}/ingest/articles?${params}`,
  );
}

// Vernacular batch ─────────────────────────────────────────────────────────────

/** Translate multiple article snippets in a single request. */
export async function translateBatch(
  articles: TranslateBatchItem[],
  lang: string,
): Promise<TranslateBatchResponse> {
  return apiFetch<TranslateBatchResponse>(
    `${PROXY.vernacular}/translate/batch`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ articles, lang }),
    },
  );
}
