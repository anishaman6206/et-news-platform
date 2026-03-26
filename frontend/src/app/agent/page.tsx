"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Bot,
  Globe,
  GitBranch,
  BookOpen,
  Video,
  LayoutList,
  RefreshCw,
  Play,
  Activity,
  Zap,
} from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { cn } from "@/lib/utils";
import {
  getAgentHealth,
  getAgentDecisions,
  getAgentStats,
  triggerAgentCycle,
} from "@/lib/api";
import type { AgentHealth, AgentDecision, AgentStats } from "@/lib/api";

// ── Helpers ────────────────────────────────────────────────────────────────────

const CYCLE_MINUTES = 35;

function parseTools(raw: string[] | string | null | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function elapsedMinutes(unixSeconds: number | null): number | null {
  if (unixSeconds === null) return null;
  return Math.floor((Date.now() / 1000 - unixSeconds) / 60);
}

function timeAgoFromUnix(unixSeconds: number | null): string {
  const mins = elapsedMinutes(unixSeconds);
  if (mins === null) return "Never";
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

function timeAgoFromISO(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diffSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const mins = Math.floor(diffSec / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

// ── Colour maps ────────────────────────────────────────────────────────────────

function sectionBadgeClass(section: string): string {
  switch (section?.toLowerCase()) {
    case "economy":  return "border-blue-700/50 bg-blue-950/60 text-blue-300";
    case "markets":  return "border-green-700/50 bg-green-950/60 text-green-300";
    case "tech":     return "border-purple-700/50 bg-purple-950/60 text-purple-300";
    case "startups": return "border-amber-700/50 bg-amber-950/60 text-amber-300";
    default:         return "border-white/10 bg-white/5 text-gray-400";
  }
}

function statusBadgeClass(status: string): string {
  switch (status) {
    case "completed": return "border-green-700/50 bg-green-950/60 text-green-300";
    case "partial":   return "border-amber-700/50 bg-amber-950/60 text-amber-300";
    case "failed":    return "border-red-700/50 bg-red-950/60 text-red-300";
    default:          return "border-white/10 bg-white/5 text-gray-400";
  }
}

function statusLabel(status: string): string {
  switch (status) {
    case "completed": return "completed ✓";
    case "partial":   return "partial ⚠";
    case "failed":    return "failed ✗";
    default:          return status;
  }
}

// ── Tool pill config ───────────────────────────────────────────────────────────

type ToolIconComponent = React.ElementType;

const TOOL_CONFIG: Record<string, { icon: ToolIconComponent; label: string; color: string }> = {
  translate: { icon: Globe,      label: "Translate", color: "border-blue-700/40 bg-blue-950/40 text-blue-300"    },
  arc:       { icon: GitBranch,  label: "Arc",       color: "border-purple-700/40 bg-purple-950/40 text-purple-300" },
  briefing:  { icon: BookOpen,   label: "Briefing",  color: "border-amber-700/40 bg-amber-950/40 text-amber-300" },
  video:     { icon: Video,      label: "Video",     color: "border-red-700/40 bg-red-950/40 text-red-300"       },
  feed:      { icon: LayoutList, label: "Feed",      color: "border-green-700/40 bg-green-950/40 text-green-300" },
};

// ── Sub-components ─────────────────────────────────────────────────────────────

function ToolPill({ tool }: { tool: string }) {
  const config = TOOL_CONFIG[tool] ?? {
    icon: Zap,
    label: tool,
    color: "border-white/10 bg-white/5 text-gray-400",
  };
  const Icon = config.icon;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
        config.color,
      )}
    >
      <Icon className="h-3 w-3" />
      {config.label}
    </span>
  );
}

function DecisionCard({ decision }: { decision: AgentDecision }) {
  const tools = parseTools(decision.tools_invoked);
  return (
    <div className="rounded-2xl border border-white/10 bg-gray-800/50 p-5 space-y-3">
      {/* Header row */}
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={cn(
            "rounded-full border px-2.5 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
            sectionBadgeClass(decision.section),
          )}
        >
          {decision.section}
        </span>
        <span className="flex-1" />
        <span
          className={cn(
            "rounded-full border px-2.5 py-0.5 text-[11px] font-medium",
            statusBadgeClass(decision.status),
          )}
        >
          {statusLabel(decision.status)}
        </span>
      </div>

      {/* Title */}
      <p className="text-sm font-semibold text-white leading-snug">
        {decision.article_title || `Article ${decision.article_id}`}
      </p>

      {/* Reasoning */}
      {decision.reasoning && (
        <p className="text-xs italic text-gray-400 leading-relaxed">
          💭 &ldquo;{decision.reasoning}&rdquo;
        </p>
      )}

      {/* Tool pills */}
      {tools.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tools.map((tool) => (
            <ToolPill key={tool} tool={tool} />
          ))}
        </div>
      )}

      {/* Timestamp */}
      <p className="text-[11px] text-gray-600">
        {timeAgoFromISO(decision.decided_at)}
        {decision.duration_ms > 0 && (
          <span className="ml-2">· {decision.duration_ms}ms</span>
        )}
      </p>
    </div>
  );
}

function DecisionSkeleton() {
  return (
    <div className="animate-pulse rounded-2xl border border-white/10 bg-gray-800/50 p-5 space-y-3">
      <div className="flex gap-2">
        <div className="h-5 w-16 rounded-full bg-gray-700" />
        <div className="h-5 w-20 rounded-full bg-gray-700 ml-auto" />
      </div>
      <div className="h-4 w-3/4 rounded bg-gray-700" />
      <div className="h-3 w-full rounded bg-gray-700" />
      <div className="h-3 w-2/3 rounded bg-gray-700" />
      <div className="flex gap-2">
        <div className="h-5 w-20 rounded-full bg-gray-700" />
        <div className="h-5 w-16 rounded-full bg-gray-700" />
        <div className="h-5 w-14 rounded-full bg-gray-700" />
      </div>
    </div>
  );
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string | number;
  sub?: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-gray-800/50 p-5 space-y-1">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
        {label}
      </p>
      <p className="text-3xl font-bold text-white">{value}</p>
      {sub && <p className="text-xs text-gray-500">{sub}</p>}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function AgentPage() {
  const [health, setHealth]         = useState<AgentHealth | null>(null);
  const [decisions, setDecisions]   = useState<AgentDecision[]>([]);
  const [stats, setStats]           = useState<AgentStats | null>(null);
  const [loading, setLoading]       = useState(true);
  const [triggering, setTriggering] = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [toast, setToast]           = useState<string | null>(null);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  const fetchAll = useCallback(async () => {
    try {
      const [h, d, s] = await Promise.all([
        getAgentHealth().catch(() => null),
        getAgentDecisions(20).catch(() => ({ decisions: [] })),
        getAgentStats().catch(() => null),
      ]);
      if (h) setHealth(h);
      setDecisions(d.decisions);
      if (s) setStats(s);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load agent data");
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch + auto-refresh every 15 s
  useEffect(() => {
    void fetchAll();
    const id = setInterval(() => void fetchAll(), 15_000);
    return () => clearInterval(id);
  }, [fetchAll]);

  async function handleTrigger() {
    setTriggering(true);
    try {
      const result = await triggerAgentCycle();
      const processed = result.articles_processed ?? 0;
      showToast(
        processed > 0
          ? `Cycle complete — ${processed} article${processed !== 1 ? "s" : ""} processed`
          : "Cycle complete — no new articles",
      );
      await fetchAll();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Trigger failed");
    } finally {
      setTriggering(false);
    }
  }

  // Status bar derived values
  const elapsed = elapsedMinutes(health?.last_run ?? null);
  const isActive = elapsed !== null && elapsed < 40;
  const nextRunIn =
    elapsed !== null ? Math.max(0, CYCLE_MINUTES - elapsed) : null;

  // Stats bar chart
  const breakdown = stats?.tools_breakdown ?? {};
  const maxBreakdown = Math.max(1, ...Object.values(breakdown));

  return (
    <div className="min-h-screen bg-gray-900">
      {/* Toast */}
      {toast && (
        <div className="fixed right-4 top-4 z-50 rounded-xl border border-green-700/50 bg-green-950/90 px-4 py-2.5 text-sm text-green-300 shadow-lg backdrop-blur-sm">
          {toast}
        </div>
      )}

      <div className="mx-auto max-w-4xl space-y-6 px-4 py-8">
        <PageHeader
          title="ET News Agent"
          subtitle="Autonomous AI orchestrating your news platform"
        />

        {/* ── 1. Status bar ── */}
        <div className="rounded-2xl border border-white/10 bg-gray-800/50 p-6 space-y-4">
          {/* Active indicator + trigger */}
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-2.5">
              <span
                className={cn(
                  "h-3 w-3 rounded-full flex-shrink-0",
                  isActive
                    ? "bg-green-500 animate-pulse"
                    : "bg-gray-600",
                )}
              />
              <span
                className={cn(
                  "text-sm font-semibold",
                  isActive ? "text-green-400" : "text-gray-500",
                )}
              >
                {isActive ? "Agent Active" : "Agent Idle"}
              </span>
            </div>

            <span className="flex-1" />

            <button
              onClick={() => void handleTrigger()}
              disabled={triggering}
              className={cn(
                "flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition-all",
                triggering
                  ? "cursor-not-allowed bg-gray-700 text-gray-500"
                  : "bg-[#FF6B35] text-white hover:bg-[#e55a25] active:scale-95",
              )}
            >
              {triggering ? (
                <>
                  <LoadingSpinner size="sm" /> Running…
                </>
              ) : (
                <>
                  <Play className="h-3.5 w-3.5" /> Trigger Now
                </>
              )}
            </button>
          </div>

          {/* Stats row */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="rounded-xl border border-white/5 bg-gray-900/60 px-4 py-3 space-y-1">
              <p className="text-[10px] uppercase tracking-widest text-gray-500">Articles Today</p>
              <p className="text-xl font-bold text-white">
                {health?.articles_processed_today ?? "—"}
              </p>
            </div>
            <div className="rounded-xl border border-white/5 bg-gray-900/60 px-4 py-3 space-y-1">
              <p className="text-[10px] uppercase tracking-widest text-gray-500">Tools Today</p>
              <p className="text-xl font-bold text-white">
                {health?.tools_invoked_today ?? "—"}
              </p>
            </div>
            <div className="rounded-xl border border-white/5 bg-gray-900/60 px-4 py-3 space-y-1">
              <p className="text-[10px] uppercase tracking-widest text-gray-500">Last Run</p>
              <p className="text-xl font-bold text-white">
                {timeAgoFromUnix(health?.last_run ?? null)}
              </p>
            </div>
            <div className="rounded-xl border border-white/5 bg-gray-900/60 px-4 py-3 space-y-1">
              <p className="text-[10px] uppercase tracking-widest text-gray-500">Next Run</p>
              <p className="text-xl font-bold text-white">
                {nextRunIn !== null ? `in ${nextRunIn}m` : "—"}
              </p>
            </div>
          </div>

          {/* Refresh note */}
          <p className="flex items-center gap-1.5 text-[10px] text-gray-600">
            <RefreshCw className="h-3 w-3" />
            Auto-refreshes every 15 seconds
          </p>
        </div>

        {/* ── 2. Live decisions feed ── */}
        <section className="space-y-4">
          <div>
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-[#FF6B35]" />
              <h2 className="text-base font-bold text-white">Autonomous Decisions</h2>
            </div>
            <p className="mt-0.5 text-xs text-gray-500">
              Every decision the agent makes, with its reasoning
            </p>
          </div>

          {error && (
            <div className="rounded-xl border border-red-700/50 bg-red-950/30 px-4 py-3 text-sm text-red-400">
              {error}
            </div>
          )}

          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 3 }).map((_, i) => (
                <DecisionSkeleton key={i} />
              ))}
            </div>
          ) : decisions.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-white/10 bg-gray-800/30 py-16 text-center">
              <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/5">
                <Bot className="h-6 w-6 text-gray-500" />
              </div>
              <div>
                <p className="text-sm font-medium text-gray-300">No decisions yet</p>
                <p className="mt-1 text-xs text-gray-600">
                  Trigger a cycle or wait for the next scheduled run
                </p>
              </div>
              <button
                onClick={() => void handleTrigger()}
                disabled={triggering}
                className="flex items-center gap-2 rounded-xl bg-[#FF6B35] px-4 py-2 text-sm font-semibold text-white hover:bg-[#e55a25] transition-all active:scale-95 disabled:opacity-50"
              >
                <Play className="h-3.5 w-3.5" />
                Trigger First Cycle
              </button>
            </div>
          ) : (
            <div className="space-y-3">
              {decisions.map((d, i) => (
                <DecisionCard key={`${d.article_id}-${i}`} decision={d} />
              ))}
            </div>
          )}
        </section>

        {/* ── 3. Stats ── */}
        {stats && (
          <section className="space-y-4">
            <div className="flex items-center gap-2">
              <Zap className="h-4 w-4 text-[#FF6B35]" />
              <h2 className="text-base font-bold text-white">Agent Stats</h2>
            </div>

            {/* Metric cards */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <StatCard
                label="Total Articles"
                value={stats.total_articles_processed}
              />
              <StatCard
                label="Total Tools Invoked"
                value={stats.total_tools_invoked}
              />
              <StatCard
                label="Avg Tools / Article"
                value={stats.avg_tools_per_article}
                sub="across all decisions"
              />
            </div>

            {/* Tools breakdown */}
            {Object.keys(breakdown).length > 0 && (
              <div className="rounded-2xl border border-white/10 bg-gray-800/50 p-5 space-y-4">
                <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
                  Tools Breakdown
                </p>
                <div className="space-y-3">
                  {Object.entries(breakdown)
                    .sort(([, a], [, b]) => b - a)
                    .map(([tool, count]) => {
                      const cfg = TOOL_CONFIG[tool];
                      const Icon = cfg?.icon ?? Zap;
                      return (
                        <div key={tool} className="flex items-center gap-3">
                          <Icon className="h-3.5 w-3.5 text-gray-500 flex-shrink-0" />
                          <span className="w-16 text-xs capitalize text-gray-400">
                            {tool}
                          </span>
                          <div className="flex-1 h-1.5 rounded-full bg-gray-700">
                            <div
                              className="h-1.5 rounded-full bg-[#FF6B35]/70 transition-all"
                              style={{ width: `${(count / maxBreakdown) * 100}%` }}
                            />
                          </div>
                          <span className="w-6 text-right text-xs text-gray-500">
                            {count}
                          </span>
                        </div>
                      );
                    })}
                </div>
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
