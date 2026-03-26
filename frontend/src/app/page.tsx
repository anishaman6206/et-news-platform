"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { RefreshCw, Bot } from "lucide-react";
import { FeedSidebar } from "@/components/feed/FeedSidebar";
import { ArticleCard } from "@/components/feed/ArticleCard";
import { AgentActivityPanel } from "@/components/feed/AgentActivityPanel";
import { VideoStudioPanel } from "@/components/feed/VideoStudioPanel";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { getIngestedArticles, getFeed, translateBatch } from "@/lib/api";
import type { IngestedArticle } from "@/lib/api";

const LANG_NAMES: Record<string, string> = {
  hi: "Hindi",
  ta: "Tamil",
  te: "Telugu",
  bn: "Bengali",
};

export default function NewsPage() {
  const [articles, setArticles] = useState<IngestedArticle[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [globalLang, setGlobalLang] = useState("en");
  const [globalTranslations, setGlobalTranslations] = useState<
    Record<string, string>
  >({});
  const [translatingGlobal, setTranslatingGlobal] = useState(false);

  const translateAll = useCallback(
    async (lang: string, arts: IngestedArticle[]) => {
      if (lang === "en" || arts.length === 0) {
        setGlobalTranslations({});
        return;
      }
      setTranslatingGlobal(true);
      try {
        const items = arts.map((a) => ({
          id: a.article_id,
          text: a.summary ?? a.title,
        }));
        const res = await translateBatch(items, lang);
        const map: Record<string, string> = {};
        for (const t of res.translations ?? []) {
          map[t.id] = t.translated;
        }
        setGlobalTranslations(map);
      } catch {
        // fail silently — individual article dropdowns still work
      } finally {
        setTranslatingGlobal(false);
      }
    },
    [],
  );

  // Keep stable ref so event handlers don't go stale
  const translateAllRef = useRef(translateAll);
  useEffect(() => {
    translateAllRef.current = translateAll;
  }, [translateAll]);

  const loadArticles = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let raw: IngestedArticle[] = [];
      let personalized = false;

      // Use personalized feed when user has onboarded with a role
      try {
        const userId = localStorage.getItem("et_feed_user_id");
        const profileStr = localStorage.getItem("et_feed_profile_v2");
        const profile = profileStr
          ? (JSON.parse(profileStr) as { role?: string })
          : null;
        if (userId && profile?.role) {
          const feedData = await getFeed(userId);
          if (feedData.articles.length > 0) {
            raw = feedData.articles;
            personalized = true;
          }
        }
      } catch {
        // fall through to chronological scroll
      }

      // Fallback: chronological scroll from ingestion service
      if (!personalized) {
        const data = await getIngestedArticles(50);
        const fallback = Array.isArray(data)
          ? (data as IngestedArticle[])
          : ((data as { articles?: IngestedArticle[] }).articles ?? []);
        // Sort descending by pub_ts only for chronological view
        raw = [...fallback].sort((a, b) => (b.pub_ts ?? 0) - (a.pub_ts ?? 0));
      }

      setArticles(raw);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to load articles";
      console.error("[NewsPage] fetch error:", msg);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadArticles();
  }, [loadArticles]);

  // Pick up stored preference and listen for changes dispatched by TopNav
  useEffect(() => {
    const stored = localStorage.getItem("et_lang_preference") ?? "en";
    setGlobalLang(stored);

    const handler = (e: Event) => {
      const lang = (e as CustomEvent<string>).detail;
      setGlobalLang(lang);
    };
    window.addEventListener("et_lang_change", handler);
    return () => window.removeEventListener("et_lang_change", handler);
  }, []);

  // Re-translate whenever globalLang or articles change
  useEffect(() => {
    if (articles.length === 0) return;
    if (globalLang !== "en") {
      void translateAllRef.current(globalLang, articles);
    } else {
      setGlobalTranslations({});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [globalLang, articles]);

  const handleChangeLang = () => {
    localStorage.setItem("et_lang_preference", "en");
    window.dispatchEvent(new CustomEvent("et_lang_change", { detail: "en" }));
  };

  return (
    <div>
      {/* Global language banner */}
      {globalLang !== "en" && (
        <div className="mb-4 flex items-center justify-between rounded-xl bg-blue-950/50 border border-blue-700/40 px-4 py-2.5">
          <span className="text-sm text-blue-300 flex items-center gap-2">
            {translatingGlobal ? (
              <>
                Translating to{" "}
                <strong>{LANG_NAMES[globalLang] ?? globalLang}</strong>
                <LoadingSpinner size="sm" />
              </>
            ) : (
              <>
                Showing articles in{" "}
                <strong>{LANG_NAMES[globalLang] ?? globalLang}</strong>
              </>
            )}
          </span>
          <button
            onClick={handleChangeLang}
            className="text-xs text-blue-400 hover:text-blue-200 transition-colors"
          >
            Change language
          </button>
        </div>
      )}

      {/* 3-column layout */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "20% 1fr 25%",
          gap: "1.5rem",
          alignItems: "start",
        }}
      >
        {/* LEFT: Feed personalisation */}
        <aside>
          <FeedSidebar onRefresh={loadArticles} />
        </aside>

        {/* CENTER: Article feed */}
        <main className="min-w-0">
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            <h1 className="text-lg font-bold text-white">Today&apos;s News</h1>
            {!loading && articles.length > 0 && (
              <span className="rounded-full bg-gray-700 px-2.5 py-0.5 text-xs text-gray-300 font-medium">
                {articles.length}
              </span>
            )}
            <span className="flex items-center gap-1 rounded-full bg-[#FF6B35]/10 border border-[#FF6B35]/20 px-2.5 py-0.5 text-xs text-[#FF6B35]">
              <Bot className="h-3 w-3" /> Agent processing
            </span>
            <button
              onClick={() => void loadArticles()}
              disabled={loading}
              className="ml-auto flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-gray-400 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-40"
            >
              <RefreshCw
                className={`h-3 w-3 ${loading ? "animate-spin" : ""}`}
              />
              Refresh
            </button>
          </div>

          {loading && (
            <div className="flex items-center justify-center py-24">
              <LoadingSpinner size="lg" />
            </div>
          )}

          {!loading && error && (
            <div className="rounded-xl border border-amber-700/40 bg-amber-950/20 p-4 mb-4 space-y-1">
              <p className="text-sm font-medium text-amber-300">
                Starting up — ingestion pipeline is loading articles…
              </p>
              <p className="text-xs text-gray-500">{error}</p>
              <button
                onClick={() => void loadArticles()}
                className="text-xs text-amber-400 underline hover:text-amber-200"
              >
                Retry
              </button>
            </div>
          )}

          {!loading && !error && articles.length === 0 && (
            <div className="rounded-2xl border border-white/10 bg-gray-800/30 py-20 text-center space-y-1">
              <p className="text-gray-400 text-sm font-medium">
                Starting up — ingestion pipeline is loading articles…
              </p>
              <p className="text-gray-600 text-xs">
                Articles will appear here once the pipeline processes its first batch.
              </p>
            </div>
          )}

          <div className="space-y-4">
            {articles.map((article) => (
              <ArticleCard
                key={article.article_id}
                article={article}
                globalLang={globalLang}
                globalTranslation={globalTranslations[article.article_id]}
              />
            ))}
          </div>
        </main>

        {/* RIGHT: Agent + Video panels */}
        <aside className="space-y-4 sticky top-20">
          <AgentActivityPanel />
          <VideoStudioPanel />
        </aside>
      </div>
    </div>
  );
}
