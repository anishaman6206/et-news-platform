"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  ChevronDown,
  ChevronUp,
  Globe,
  ExternalLink,
  BarChart2,
  Video,
  Send,
} from "lucide-react";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { translateBatch, engageArticle, generateVideo } from "@/lib/api";
import type { IngestedArticle, BriefingSection } from "@/lib/api";
import { cn } from "@/lib/utils";

// ── Constants ──────────────────────────────────────────────────────────────────

const LANG_OPTIONS = [
  { code: "en", label: "EN" },
  { code: "hi", label: "हिंदी" },
  { code: "ta", label: "தமிழ்" },
  { code: "te", label: "తెలుగు" },
  { code: "bn", label: "বাংলা" },
];

const LANG_NAMES: Record<string, string> = {
  hi: "Hindi",
  ta: "Tamil",
  te: "Telugu",
  bn: "Bengali",
  en: "English",
};

// ── Helpers ────────────────────────────────────────────────────────────────────

// pub_ts from the ingestion service is a unix timestamp in seconds (float).
// Handle both number (seconds) and ISO string gracefully.
function formatRelTime(ts: number | string): string {
  try {
    const ms = typeof ts === "number" ? ts * 1000 : new Date(ts).getTime();
    const diffMs = Date.now() - ms;
    const diffMin = Math.floor(diffMs / 60_000);
    if (diffMin < 1) return "Just now";
    if (diffMin < 60) return `${diffMin}m ago`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `${diffH}h ago`;
    return `${Math.floor(diffH / 24)}d ago`;
  } catch {
    return String(ts).slice(0, 10);
  }
}

// ── Topic extraction ───────────────────────────────────────────────────────────

function extractTopicFallback(title: string): string {
  // Known entity mapping
  const entities = [
    "RBI", "SEBI", "Infosys", "Budget", "Nifty",
    "JPMorgan", "Zerodha", "UDAN", "Adani", "Reliance",
    "NSE", "BSE", "Sensex"
  ];
  const upperTitle = title.toUpperCase();
  const found = entities.find(e => upperTitle.includes(e.toUpperCase()));
  if (found) return found;

  // Fallback: first 2 capitalized words
  const words = title.match(/[A-Z][a-z]+/g) ?? [];
  return words.slice(0, 2).join(" ") || title.split(" ").slice(0, 2).join(" ");
}

async function extractTopic(title: string, summary: string): Promise<string> {
  try {
    const res = await fetch("/api/arc/extract-topic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, summary: summary || "" }),
    });
    const data = await res.json() as { topic?: string };
    return data.topic || extractTopicFallback(title);
  } catch {
    return extractTopicFallback(title);
  }
}

// ── Briefing data types ─────────────────────────────────────────────────────────

interface BriefingData {
  summary?: string;
  key_developments?: { text: string; source_ids: number[] }[];
  stakeholders?: { name: string; role: string; sentiment: string }[];
  open_questions?: string[];
  what_to_watch?: string[];
  error?: string;
}

/** Extract first 5 words of title as briefing search topic; fall back to section. */
function extractBriefingTopic(title: string, section?: string): string {
  const words = title.trim().split(/\s+/).slice(0, 5).join(" ");
  return words.length > 3 ? words : section ?? title;
}

// ── Q&A types ──────────────────────────────────────────────────────────────────

interface QaItem {
  q: string;
  a: string;
  streaming: boolean;
}

// ── Props ──────────────────────────────────────────────────────────────────────

interface ArticleCardProps {
  article: IngestedArticle;
  globalLang: string;
  globalTranslation?: string;
}

// ── Component ──────────────────────────────────────────────────────────────────

export function ArticleCard({
  article,
  globalLang,
  globalTranslation,
}: ArticleCardProps) {
  const router = useRouter();

  // Story Arc topic cache + loading
  const [arcTopic, setArcTopic] = useState<string | null>(null);
  const [arcTopicLoading, setArcTopicLoading] = useState(false);

  // Briefing state
  const [briefingOpen, setBriefingOpen] = useState(false);
  const [briefingData, setBriefingData] = useState<BriefingData | null>(null);
  const [briefingStreaming, setBriefingStreaming] = useState(false);
  const [briefingDone, setBriefingDone] = useState(false);
  const [briefingError, setBriefingError] = useState<string | null>(null);
  const briefingEsRef = useRef<EventSource | null>(null);
  const briefingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Per-article translation state
  const [artLang, setArtLang] = useState("en");
  const [translation, setTranslation] = useState<string | null>(null);
  const [translating, setTranslating] = useState(false);
  const [showTranslation, setShowTranslation] = useState(false);
  // Cache translations to avoid re-fetching
  const translationCache = useRef<Record<string, string>>({});

  // Q&A state
  const [question, setQuestion] = useState("");
  const [qaHistory, setQaHistory] = useState<QaItem[]>([]);

  // Apply global translation when it arrives (only if per-article lang not manually set)
  useEffect(() => {
    if (globalLang !== "en" && globalTranslation && artLang === globalLang) {
      setTranslation(globalTranslation);
      setShowTranslation(true);
    }
  }, [globalLang, globalTranslation, artLang]);

  // When global lang resets to EN, clear if we were showing a global translation
  useEffect(() => {
    if (globalLang === "en" && artLang === "en") {
      setShowTranslation(false);
    }
  }, [globalLang, artLang]);

  // Sync artLang with global lang changes (unless user manually set a different lang)
  const prevGlobalLang = useRef(globalLang);
  useEffect(() => {
    if (prevGlobalLang.current !== globalLang) {
      prevGlobalLang.current = globalLang;
      setArtLang(globalLang);
    }
  }, [globalLang]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      briefingEsRef.current?.close();
      if (briefingTimeoutRef.current) clearTimeout(briefingTimeoutRef.current);
    };
  }, []);

  // ── Briefing ────────────────────────────────────────────────────────────────

  const handleToggleBriefing = useCallback(() => {
    if (!briefingOpen) {
      setBriefingOpen(true);
      // Fire engagement signal so the user's interest vector is updated
      const userId = localStorage.getItem("et_feed_user_id");
      if (userId) {
        void engageArticle(userId, article.article_id, "opened").catch(() => {});
      }
      if (!briefingDone && !briefingStreaming) {
        setBriefingStreaming(true);
        setBriefingError(null);
        setBriefingData(null);

        const briefingTopic = extractBriefingTopic(article.title, article.section);
        const url = `/api/briefing/stream?topic=${encodeURIComponent(briefingTopic)}`;
        console.log("Briefing URL:", url);
        const es = new EventSource(url);
        briefingEsRef.current = es;

        // 15s timeout — show friendly error if no data arrives
        briefingTimeoutRef.current = setTimeout(() => {
          if (!briefingDone) {
            setBriefingError(
              "Could not generate briefing for this article. The article may be too recent for our knowledge base."
            );
            setBriefingStreaming(false);
            es.close();
          }
        }, 15000);

        es.onmessage = (e: MessageEvent<string>) => {
          if (e.data === "[DONE]") {
            if (briefingTimeoutRef.current) clearTimeout(briefingTimeoutRef.current);
            setBriefingStreaming(false);
            setBriefingDone(true);
            es.close();
            return;
          }
          try {
            const parsed = JSON.parse(e.data) as BriefingData;
            if (parsed.error) {
              if (briefingTimeoutRef.current) clearTimeout(briefingTimeoutRef.current);
              setBriefingError(
                "Could not generate briefing for this article. The article may be too recent for our knowledge base."
              );
              setBriefingStreaming(false);
              es.close();
            } else {
              setBriefingData(parsed);
            }
          } catch {
            // ignore parse errors
          }
        };

        es.onerror = () => {
          if (briefingTimeoutRef.current) clearTimeout(briefingTimeoutRef.current);
          setBriefingStreaming(false);
          if (!briefingDone)
            setBriefingError(
              "Could not generate briefing for this article. The article may be too recent for our knowledge base."
            );
          es.close();
        };
      }
    } else {
      setBriefingOpen(false);
    }
  }, [briefingOpen, briefingDone, briefingStreaming, article.title, article.section]);

  // ── Story Arc ────────────────────────────────────────────────────────────────

  const handleStoryArc = useCallback(async () => {
    // Navigate immediately with cached topic
    if (arcTopic) {
      router.push(`/arc?topic=${encodeURIComponent(arcTopic)}`);
      return;
    }
    setArcTopicLoading(true);
    try {
      const topic = await extractTopic(article.title, article.summary ?? "");
      setArcTopic(topic);
      router.push(`/arc?topic=${encodeURIComponent(topic)}`);
    } finally {
      setArcTopicLoading(false);
    }
  }, [arcTopic, article.title, article.summary, router]);

  // ── Per-article translation ─────────────────────────────────────────────────

  const handleLangChange = useCallback(
    async (lang: string) => {
      setArtLang(lang);
      if (lang === "en") {
        setShowTranslation(false);
        return;
      }
      // Use cache if available
      if (translationCache.current[lang]) {
        setTranslation(translationCache.current[lang]);
        setShowTranslation(true);
        return;
      }
      const text = article.summary ?? article.topic ?? article.title;
      setTranslating(true);
      try {
        const res = await translateBatch(
          [{ id: article.article_id, text }],
          lang,
        );
        const translated = res.translations?.[0]?.translated;
        if (translated) {
          translationCache.current[lang] = translated;
          setTranslation(translated);
          setShowTranslation(true);
        }
      } catch {
        // fail silently
      } finally {
        setTranslating(false);
      }
    },
    [article],
  );

  // ── Q&A ──────────────────────────────────────────────────────────────────────

  // ── Video ────────────────────────────────────────────────────────────────────

  const [videoQueued, setVideoQueued] = useState(false);

  const handleGenerateVideo = useCallback(async () => {
    setVideoQueued(true);
    try {
      const text = article.summary ?? article.topic ?? article.title;
      await generateVideo(article.article_id, article.title, text);
    } catch {
      // fail silently — job will appear in video page if service is up
    }
    router.push("/video");
  }, [article, router]);

  const NOT_IN_ARTICLES = /not (in|found in|available in|covered (in|by)) (the )?articles?/i;

  const handleAskQuestion = useCallback(async () => {
    const q = question.trim();
    if (!q) return;
    setQuestion("");

    const idx = qaHistory.length;
    setQaHistory((prev) => [...prev, { q, a: "", streaming: true }]);

    try {
      const res = await fetch("/api/briefing/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: article.title,
          question: q,
          context: article.summary ?? "",
        }),
      });

      const reader = res.body?.getReader();
      if (!reader) throw new Error("no body");
      const decoder = new TextDecoder();
      let buffer = "";
      let answer = "";

      outer: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";
        for (const event of events) {
          const dataLine = event.split("\n").find((l) => l.startsWith("data: "));
          if (!dataLine) continue;
          // Do NOT trim — a token may be a single space character
          const data = dataLine.slice(6);
          if (data === "[DONE]") {
            // Full answer is now complete — apply "not in articles" check here
            const finalAnswer = NOT_IN_ARTICLES.test(answer)
              ? `This article doesn't cover that specific detail. Try asking about ${article.title.split(" ").slice(0, 4).join(" ")} more broadly.`
              : answer;
            setQaHistory((prev) =>
              prev.map((item, i) =>
                i === idx ? { ...item, a: finalAnswer, streaming: false } : item
              )
            );
            break outer;
          }
          if (data) {
            // Accumulate tokens progressively
            answer += data;
            setQaHistory((prev) =>
              prev.map((item, i) => i === idx ? { ...item, a: answer } : item)
            );
          }
        }
      }
    } catch {
      // fail silently
    }
    setQaHistory((prev) =>
      prev.map((item, i) => i === idx ? { ...item, streaming: false } : item)
    );
  }, [question, qaHistory, article.title, article.summary]);

  // ── Render ───────────────────────────────────────────────────────────────────

  const displayText =
    showTranslation && translation
      ? translation
      : (article.summary ?? article.topic ?? "");

  const relTime = article.pub_ts != null ? formatRelTime(article.pub_ts) : "";

  return (
    <article className="rounded-2xl border border-white/10 bg-gray-800/50 overflow-hidden">
      {/* ── Card header ── */}
      <div className="p-4">
        <div className="flex items-start justify-between gap-3 mb-2">
          {/* Section badge */}
          <div className="flex items-center gap-2 flex-wrap min-h-[24px]">
            {article.section && (
              <span className="px-2 py-0.5 rounded-full bg-[#FF6B35]/15 text-[#FF6B35] text-[10px] font-bold uppercase tracking-wide">
                {article.section}
              </span>
            )}
          </div>

          {/* Per-article language dropdown */}
          <div className="relative shrink-0">
            <select
              value={artLang}
              onChange={(e) => void handleLangChange(e.target.value)}
              className="bg-gray-700 text-gray-300 text-xs border border-gray-600 rounded px-2 py-1 pr-6 appearance-none cursor-pointer hover:border-gray-400 focus:outline-none focus:border-[#FF6B35]"
            >
              {LANG_OPTIONS.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.label}
                </option>
              ))}
            </select>
            <Globe className="pointer-events-none absolute right-1.5 top-1/2 -translate-y-1/2 h-3 w-3 text-gray-500" />
          </div>
        </div>

        {/* Title */}
        <h3 className="text-sm font-semibold text-white leading-snug mb-2">
          {article.title}
        </h3>

        {/* Translation badge */}
        {showTranslation && translation && (
          <span className="inline-block mb-1 px-2 py-0.5 rounded-full bg-blue-900/40 text-blue-400 text-[10px] border border-blue-700/40">
            Translated to {LANG_NAMES[artLang] ?? artLang}
          </span>
        )}

        {/* Summary / translated text */}
        {translating ? (
          <div className="flex items-center gap-2 text-xs text-gray-500 my-1">
            <LoadingSpinner size="sm" /> Translating…
          </div>
        ) : displayText.length > 20 ? (
          <p className="text-sm text-gray-400 leading-relaxed line-clamp-3">
            {displayText}
          </p>
        ) : null}

        {/* Toggle original/translation */}
        {showTranslation && translation && (
          <button
            onClick={() => setShowTranslation((v) => !v)}
            className="mt-1 text-[10px] text-blue-400 hover:text-blue-300 transition-colors"
          >
            {showTranslation ? "Show Original" : "Show Translation"}
          </button>
        )}

        {/* Meta row */}
        <div className="flex items-center gap-2 mt-2.5 text-[11px] text-gray-600">
          {article.source && <span>{article.source}</span>}
          {article.source && relTime && <span>·</span>}
          {relTime && <span>{relTime}</span>}
          {article.url && (
            <>
              <span>·</span>
              <a
                href={article.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-0.5 text-[#FF6B35] hover:underline"
              >
                ET <ExternalLink className="h-2.5 w-2.5" />
              </a>
            </>
          )}
        </div>
      </div>

      {/* ── AI Insights bar ── */}
      <div className="px-4 py-2 border-t border-white/5 bg-gray-900/30">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-semibold uppercase tracking-widest text-gray-600 mr-1">
            AI Insights
          </span>

          <button
            onClick={handleToggleBriefing}
            className={cn(
              "flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs transition-colors",
              briefingOpen
                ? "border-[#FF6B35]/40 bg-[#FF6B35]/10 text-[#FF6B35]"
                : "border-white/10 bg-white/5 text-gray-400 hover:bg-white/10 hover:text-white",
            )}
          >
            {briefingOpen ? (
              <ChevronUp className="h-3 w-3" />
            ) : (
              <ChevronDown className="h-3 w-3" />
            )}
            {briefingStreaming
              ? "Loading…"
              : briefingDone
                ? briefingOpen
                  ? "Hide Briefing"
                  : "Show Briefing"
                : "Show Briefing"}
          </button>

          <button
            onClick={() => void handleStoryArc()}
            disabled={arcTopicLoading}
            className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-gray-400 hover:bg-white/10 hover:text-white transition-colors disabled:opacity-50"
          >
            {arcTopicLoading ? (
              <LoadingSpinner size="sm" />
            ) : (
              <BarChart2 className="h-3 w-3" />
            )}
            Story Arc
          </button>

          <button
            onClick={() => void handleGenerateVideo()}
            disabled={videoQueued}
            className="flex items-center gap-1 rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-gray-400 hover:bg-white/10 hover:text-white transition-colors disabled:opacity-50"
          >
            {videoQueued ? <LoadingSpinner size="sm" /> : <Video className="h-3 w-3" />}
            {videoQueued ? "Queued…" : "Video"}
          </button>
        </div>
      </div>

      {/* ── Briefing panel ── */}
      {briefingOpen && (
        <div className="border-t border-white/5 bg-gray-900/20 px-4 py-3 space-y-3">
          {briefingStreaming && (
            <div className="flex items-center gap-2 text-xs text-gray-500">
              <LoadingSpinner size="sm" /> Generating briefing…
            </div>
          )}

          {briefingError && (
            <p className="text-xs text-red-400">{briefingError}</p>
          )}

          {briefingData && (
            <div className="space-y-3">
              {briefingData.summary && (
                <div className="space-y-1">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-[#FF6B35]">Summary</p>
                  <p className="text-xs text-gray-300 leading-relaxed">{briefingData.summary}</p>
                </div>
              )}
              {briefingData.key_developments?.length ? (
                <div className="space-y-1">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-[#FF6B35]">Key Developments</p>
                  <div className="space-y-1">
                    {briefingData.key_developments.map((d, i) => (
                      <p key={i} className="text-xs text-gray-300 leading-relaxed">• {d.text}</p>
                    ))}
                  </div>
                </div>
              ) : null}
              {briefingData.stakeholders?.length ? (
                <div className="space-y-1">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-[#FF6B35]">Stakeholders</p>
                  <div className="space-y-0.5">
                    {briefingData.stakeholders.map((s, i) => (
                      <p key={i} className="text-xs text-gray-300 leading-relaxed">
                        <span className="text-white font-medium">{s.name}</span>
                        {s.role ? ` — ${s.role}` : ""}
                        {s.sentiment ? <span className="text-gray-500"> ({s.sentiment})</span> : null}
                      </p>
                    ))}
                  </div>
                </div>
              ) : null}
              {briefingData.open_questions?.length ? (
                <div className="space-y-1">
                  <p className="text-[10px] font-bold uppercase tracking-widest text-[#FF6B35]">Open Questions</p>
                  <div className="space-y-1">
                    {briefingData.open_questions.map((q, i) => (
                      <p key={i} className="text-xs text-gray-300 leading-relaxed">• {q}</p>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          )}

          {/* Q&A section */}
          {briefingDone && (
            <div className="mt-2 space-y-2 pt-2 border-t border-white/5">
              {qaHistory.map((qa, i) => (
                <div key={i} className="space-y-1">
                  <div className="flex justify-end">
                    <span className="rounded-2xl rounded-tr-sm bg-[#FF6B35]/20 text-[#FF6B35] px-3 py-1.5 text-xs max-w-[85%] leading-relaxed">
                      {qa.q}
                    </span>
                  </div>
                  {(qa.a || qa.streaming) && (
                    <div className="flex">
                      <span className="rounded-2xl rounded-tl-sm bg-gray-700/80 text-gray-200 px-3 py-1.5 text-xs max-w-[85%] leading-relaxed">
                        {qa.streaming && !qa.a ? (
                          <LoadingSpinner size="sm" />
                        ) : (
                          <>
                            {qa.a && (
                              <span className="block text-[9px] text-gray-500 mb-1">
                                Based on this article:
                              </span>
                            )}
                            {qa.a}
                            {qa.streaming && (
                              <span className="inline-block w-1 h-3 bg-gray-400 animate-pulse ml-0.5 align-middle" />
                            )}
                          </>
                        )}
                      </span>
                    </div>
                  )}
                </div>
              ))}

              <div className="flex gap-2 pt-1">
                <input
                  type="text"
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void handleAskQuestion();
                  }}
                  placeholder="Ask a follow-up…"
                  className="flex-1 rounded-lg border border-white/10 bg-gray-800 px-3 py-1.5 text-xs text-white placeholder-gray-600 outline-none focus:border-[#FF6B35]/50"
                />
                <button
                  onClick={() => void handleAskQuestion()}
                  disabled={!question.trim()}
                  className="rounded-lg bg-[#FF6B35] px-2.5 py-1.5 text-white hover:bg-[#e55a25] disabled:opacity-40 transition-colors"
                >
                  <Send className="h-3 w-3" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </article>
  );
}
