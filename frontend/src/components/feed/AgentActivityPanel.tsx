"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Bot, ChevronRight } from "lucide-react";
import { getAgentHealth, getAgentDecisions } from "@/lib/api";
import type { AgentDecision } from "@/lib/api";

function formatRelTime(ts: number | string | null): string {
  if (ts === null || ts === undefined) return "Never";
  const d = typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "Just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  return `${Math.floor(diffH / 24)}d ago`;
}

function getTools(decision: AgentDecision): string[] {
  if (Array.isArray(decision.tools_invoked)) return decision.tools_invoked;
  if (typeof decision.tools_invoked === "string") {
    try {
      return JSON.parse(decision.tools_invoked) as string[];
    } catch {
      return decision.tools_invoked ? [decision.tools_invoked] : [];
    }
  }
  return [];
}

export function AgentActivityPanel() {
  const [lastRun, setLastRun] = useState("—");
  const [articlesProcessed, setArticlesProcessed] = useState(0);
  const [decisions, setDecisions] = useState<AgentDecision[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [health, decisionsRes] = await Promise.all([
        getAgentHealth(),
        getAgentDecisions(3),
      ]);
      setLastRun(formatRelTime(health.last_run));
      setArticlesProcessed(health.articles_processed_today);
      setDecisions(decisionsRes.decisions ?? []);
    } catch {
      // fail silently
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(interval);
  }, [refresh]);

  return (
    <div className="rounded-2xl border border-white/10 bg-gray-800/50 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="h-5 w-5 rounded-full bg-[#FF6B35]/10 flex items-center justify-center">
            <Bot className="h-3 w-3 text-[#FF6B35]" />
          </div>
          <p className="text-xs font-semibold text-white">Agent Activity</p>
        </div>
        <Link
          href="/agent"
          className="flex items-center gap-0.5 text-[10px] text-[#FF6B35] hover:text-[#e55a25]"
        >
          View Agent <ChevronRight className="h-3 w-3" />
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-xl bg-gray-900/50 p-2.5">
          <p className="text-[10px] text-gray-500">Last run</p>
          <p className="text-xs font-semibold text-white mt-0.5">{lastRun}</p>
        </div>
        <div className="rounded-xl bg-gray-900/50 p-2.5">
          <p className="text-[10px] text-gray-500">Today</p>
          <p className="text-xs font-semibold text-white mt-0.5">
            {articlesProcessed} articles
          </p>
        </div>
      </div>

      {loading && (
        <p className="text-[10px] text-gray-600 text-center py-2">Loading…</p>
      )}

      {!loading && decisions.length === 0 && (
        <p className="text-[10px] text-gray-600 text-center py-2">
          No recent decisions
        </p>
      )}

      <div className="space-y-2">
        {decisions.map((d, i) => (
          <div
            key={`${d.article_id}-${i}`}
            className="rounded-xl bg-gray-900/50 p-2.5 space-y-1.5"
          >
            <p className="text-[11px] text-gray-300 font-medium line-clamp-2 leading-tight">
              {d.article_title}
            </p>
            <div className="flex flex-wrap gap-1">
              {getTools(d)
                .slice(0, 3)
                .map((tool, j) => (
                  <span
                    key={j}
                    className="rounded-full bg-[#FF6B35]/10 text-[#FF6B35] px-1.5 py-0.5 text-[9px] font-medium"
                  >
                    {tool}
                  </span>
                ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
