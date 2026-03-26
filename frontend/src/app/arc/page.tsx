"use client";

import { useState, useCallback, useEffect, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Eye,
  Lightbulb,
  Search,
  BarChart2,
  Bot,
} from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { getArc, getArcTopics } from "@/lib/api";
import type { ArcResponse } from "@/lib/api";
import { cn } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────────────────────────────

interface TimelineItem {
  article_id: string;
  sentiment_score?: number | null;
  score?: number | null;
  label: string;
  pub_date?: string | null;
}

interface EntityItem {
  name: string;
  type: string;
  connections?: number | null;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const DEFAULT_TOPICS = ["RBI", "SEBI", "Markets", "Budget", "Adani", "Infosys"];

// ── Helpers ────────────────────────────────────────────────────────────────────

function getScore(item: TimelineItem): number {
  const s = item.sentiment_score ?? item.score;
  return s != null ? s : 0.5;
}

function scoreColorClass(score: number): string {
  if (score > 0.6) return "bg-green-500";
  if (score >= 0.4) return "bg-amber-500";
  return "bg-red-500";
}

function scoreRingClass(score: number): string {
  if (score > 0.6) return "ring-green-500/40";
  if (score >= 0.4) return "ring-amber-500/40";
  return "ring-red-500/40";
}

function labelStyle(label: string): string {
  switch (label?.toLowerCase()) {
    case "positive":
      return "border-green-700/50 bg-green-950/60 text-green-400";
    case "negative":
      return "border-red-700/50   bg-red-950/60   text-red-400";
    default:
      return "border-white/10      bg-white/5       text-gray-400";
  }
}

function entityTypeStyle(type: string): string {
  switch (type?.toUpperCase()) {
    case "ORG":
      return "bg-blue-900/60   text-blue-300   border-blue-700/50";
    case "PERSON":
      return "bg-purple-900/60 text-purple-300 border-purple-700/50";
    case "GPE":
      return "bg-green-900/60  text-green-300  border-green-700/50";
    case "MONEY":
      return "bg-amber-900/60  text-amber-300  border-amber-700/50";
    default:
      return "bg-gray-800       text-gray-400   border-white/10";
  }
}

function formatDate(raw: string | null | undefined): string {
  if (!raw) return "—";
  try {
    return new Intl.DateTimeFormat("en-IN", {
      month: "short",
      day: "numeric",
      year: "numeric",
    }).format(new Date(raw));
  } catch {
    return String(raw).slice(0, 10);
  }
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function TrendBadge({ trend }: { trend: string }) {
  if (trend === "improving") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-green-700/50 bg-green-950/60 px-2.5 py-1 text-xs font-medium text-green-400">
        <TrendingUp className="h-3.5 w-3.5" /> Improving
      </span>
    );
  }
  if (trend === "declining") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-red-700/50 bg-red-950/60 px-2.5 py-1 text-xs font-medium text-red-400">
        <TrendingDown className="h-3.5 w-3.5" /> Declining
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs font-medium text-gray-400">
      <Minus className="h-3.5 w-3.5" /> Stable
    </span>
  );
}

function TimelineCard({
  item,
  isLast,
}: {
  item: TimelineItem;
  isLast: boolean;
}) {
  const score = getScore(item);
  return (
    <div className="relative flex w-36 flex-shrink-0 flex-col items-center">
      {!isLast && (
        <div className="absolute left-1/2 top-9 z-0 h-px w-full bg-white/10" />
      )}
      <div className="relative z-10 flex w-full flex-col items-center gap-2 rounded-2xl border border-white/10 bg-gray-800/70 p-3">
        <p className="text-center text-[10px] leading-tight text-gray-500">
          {formatDate(item.pub_date)}
        </p>
        <div
          className={cn(
            "h-8 w-8 rounded-full ring-4",
            scoreColorClass(score),
            scoreRingClass(score),
          )}
        />
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-[10px] capitalize",
            labelStyle(item.label),
          )}
        >
          {item.label || "neutral"}
        </span>
        <p className="w-full truncate text-center font-mono text-[9px] text-gray-600">
          {String(item.article_id).slice(0, 10)}
        </p>
      </div>
    </div>
  );
}

function EntityCard({
  entity,
  maxConnections,
}: {
  entity: EntityItem;
  maxConnections: number;
}) {
  const connections = entity.connections ?? 0;
  const barWidth = maxConnections > 0 ? (connections / maxConnections) * 100 : 0;
  return (
    <div className="flex flex-col gap-2 rounded-2xl border border-white/10 bg-gray-800/50 p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold leading-tight text-white">
          {entity.name}
        </p>
        <span
          className={cn(
            "flex-shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase",
            entityTypeStyle(entity.type),
          )}
        >
          {entity.type}
        </span>
      </div>
      <p className="text-xs text-gray-500">
        {connections} connection{connections !== 1 ? "s" : ""}
      </p>
      <div className="h-1 w-full rounded-full bg-gray-700">
        <div
          className="h-1 rounded-full bg-[#FF6B35]/70 transition-all"
          style={{ width: `${barWidth}%` }}
        />
      </div>
    </div>
  );
}

function PredictionsSection({
  predictions,
  contrarianView,
  watchFor,
}: {
  predictions: string[];
  contrarianView: string;
  watchFor: string;
}) {
  if (!predictions.length && !contrarianView && !watchFor) return null;
  return (
    <section className="space-y-4">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
        AI Predictions
      </p>
      {predictions.length > 0 && (
        <div className="space-y-2">
          {predictions.slice(0, 3).map((pred, i) => (
            <div
              key={i}
              className="flex gap-3 rounded-2xl border border-white/10 bg-gray-800/50 p-4"
            >
              <div className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-full border border-[#FF6B35]/40 bg-[#FF6B35]/10">
                <Lightbulb className="h-3.5 w-3.5 text-[#FF6B35]" />
              </div>
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-[10px] font-semibold uppercase tracking-wide text-gray-500">
                  Prediction {i + 1}
                </span>
                <p className="text-sm leading-relaxed text-gray-200">{pred}</p>
              </div>
            </div>
          ))}
        </div>
      )}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {contrarianView && (
          <div className="space-y-1.5 rounded-2xl border border-amber-700/40 bg-amber-950/30 p-4">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-amber-500">
              Contrarian view
            </p>
            <p className="text-sm leading-relaxed text-amber-200/80">
              {contrarianView}
            </p>
          </div>
        )}
        {watchFor && (
          <div className="space-y-1.5 rounded-2xl border border-white/10 bg-gray-800/50 p-4">
            <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-widest text-gray-500">
              <Eye className="h-3 w-3" /> Watch for
            </p>
            <p className="text-sm leading-relaxed text-gray-300">{watchFor}</p>
          </div>
        )}
      </div>
    </section>
  );
}

function EmptyArcState({ onQuickTopic }: { onQuickTopic: (t: string) => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-6 rounded-2xl border border-white/10 bg-gray-800/30 py-20 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/5">
        <BarChart2 className="h-6 w-6 text-gray-500" />
      </div>
      <div>
        <p className="text-sm font-medium text-gray-300">
          Track any ongoing business story
        </p>
        <p className="mt-1 text-xs text-gray-600">
          Search for a topic below to explore its arc
        </p>
      </div>
    </div>
  );
}

// ── Main page (inner — uses useSearchParams) ────────────────────────────────────

function ArcPageContent() {
  const searchParams = useSearchParams();
  const initialTopic = searchParams.get("topic") ?? "";

  const [searchTopic, setSearchTopic] = useState(initialTopic);
  const [arc, setArc] = useState<ArcResponse | null>(null);
  const [arcLoading, setArcLoading] = useState(false);
  const [arcError, setArcError] = useState<string | null>(null);
  const [trackedTopics, setTrackedTopics] = useState<string[]>(DEFAULT_TOPICS);

  // Auto-load if topic provided via URL
  useEffect(() => {
    if (initialTopic) void handleLoadArc(initialTopic);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTopic]);

  // Try to fetch tracked topics from arc service
  useEffect(() => {
    getArcTopics()
      .then((res) => {
        if (res.topics?.length) setTrackedTopics(res.topics);
      })
      .catch(() => {
        // keep DEFAULT_TOPICS
      });
  }, []);

  const handleLoadArc = useCallback(async (topic: string) => {
    const t = topic.trim();
    if (!t) return;
    setSearchTopic(t);
    setArcLoading(true);
    setArcError(null);
    setArc(null);
    try {
      const data = await getArc(t);
      setArc(data);
    } catch (err) {
      setArcError(err instanceof Error ? err.message : "Failed to load arc");
    } finally {
      setArcLoading(false);
    }
  }, []);

  const shortNames: Record<string, string> = {
    "Reserve Bank of India": "RBI",
    "The Reserve Bank of India": "RBI",
    "Bombay Stock Exchange": "BSE",
    "Nirmala Sitharaman": "Nirmala Sitharaman",
    "Shaktikanta Das": "Shaktikanta Das",
  };

  const handleQuickTopic = (pill: string) => {
    const t = shortNames[pill] ?? pill;
    setSearchTopic(t);
    void handleLoadArc(t);
  };

  const timeline = (arc?.timeline ?? []) as TimelineItem[];
  const entities = (arc?.key_entities ?? []) as EntityItem[];
  const maxConns = Math.max(0, ...entities.map((e) => e.connections ?? 0));

  return (
    <div className="min-h-screen bg-gray-900">
      <div className="mx-auto max-w-4xl space-y-6 px-4 py-8">
        <PageHeader
          title="Story Arc Tracker"
          subtitle="Entity graphs, sentiment trends, and AI predictions"
        />

        {/* Agent auto-tracking note */}
        <div className="flex items-center gap-3 rounded-2xl border border-[#FF6B35]/20 bg-[#FF6B35]/5 px-4 py-3">
          <Bot className="h-4 w-4 text-[#FF6B35] shrink-0" />
          <p className="text-xs text-gray-300">
            Articles are tracked automatically by the ET News Agent — no manual
            input needed.
          </p>
        </div>

        {/* Recently tracked topics */}
        <div className="space-y-3 rounded-2xl border border-white/10 bg-gray-800/50 p-5">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
            Recently tracked topics
          </p>
          <div className="flex flex-wrap gap-2">
            {trackedTopics.map((t) => (
              <button
                key={t}
                onClick={() => handleQuickTopic(t)}
                className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-gray-400 transition-colors hover:border-[#FF6B35]/40 hover:bg-[#FF6B35]/10 hover:text-[#FF6B35]"
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {/* Search bar */}
        <div className="space-y-4 rounded-2xl border border-white/10 bg-gray-800/50 p-6">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
            View story arc for topic
          </p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void handleLoadArc(searchTopic);
            }}
            className="flex gap-2"
          >
            <input
              type="text"
              value={searchTopic}
              onChange={(e) => setSearchTopic(e.target.value)}
              placeholder="Enter topic…"
              className="min-w-0 flex-1 rounded-xl border border-white/10 bg-gray-900 px-3.5 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-[#FF6B35]/50 focus:ring-1 focus:ring-[#FF6B35]/30"
            />
            <button
              type="submit"
              disabled={arcLoading || !searchTopic.trim()}
              className={cn(
                "flex flex-shrink-0 items-center gap-2 rounded-xl px-5 py-2.5 text-sm font-semibold transition-all",
                arcLoading || !searchTopic.trim()
                  ? "cursor-not-allowed bg-gray-700 text-gray-500"
                  : "bg-[#FF6B35] text-white hover:bg-[#e55a25] active:scale-95",
              )}
            >
              {arcLoading ? (
                <LoadingSpinner size="sm" />
              ) : (
                <Search className="h-4 w-4" />
              )}
              Load Arc
            </button>
          </form>
        </div>

        {/* Arc display */}
        {arcError && <ErrorBanner message={arcError} />}

        {arcLoading && (
          <div className="flex items-center justify-center py-20">
            <LoadingSpinner size="lg" />
          </div>
        )}

        {!arcLoading && !arc && !arcError && (
          <EmptyArcState onQuickTopic={handleQuickTopic} />
        )}

        {!arcLoading && arc && (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-3">
              <h2 className="text-2xl font-bold text-white">{arc.topic}</h2>
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-gray-400">
                {arc.article_count} article{arc.article_count !== 1 ? "s" : ""}{" "}
                tracked
              </span>
              <TrendBadge trend={arc.sentiment_trend} />
            </div>

            {timeline.length > 0 ? (
              <section className="space-y-3">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
                  Timeline
                </p>
                <div className="overflow-x-auto pb-2">
                  <div className="flex min-w-max gap-4 px-1">
                    {timeline.map((item, i) => (
                      <TimelineCard
                        key={`${String(item.article_id)}-${i}`}
                        item={item}
                        isLast={i === timeline.length - 1}
                      />
                    ))}
                  </div>
                </div>
              </section>
            ) : (
              <div className="rounded-xl border border-white/10 bg-gray-800/30 py-8 text-center text-xs text-gray-600">
                No timeline data yet — agent is still processing articles
              </div>
            )}

            {entities.length > 0 && (
              <section className="space-y-3">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
                  Key Entities
                </p>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {entities.map((entity, i) => (
                    <EntityCard
                      key={`${entity.name}-${i}`}
                      entity={entity}
                      maxConnections={maxConns}
                    />
                  ))}
                </div>
              </section>
            )}

            <PredictionsSection
              predictions={arc.predictions}
              contrarianView={arc.contrarian_view}
              watchFor={arc.watch_for}
            />
          </div>
        )}
      </div>
    </div>
  );
}

// ── Export (wrapped in Suspense for useSearchParams) ───────────────────────────

export default function ArcPage() {
  return (
    <Suspense fallback={null}>
      <ArcPageContent />
    </Suspense>
  );
}
