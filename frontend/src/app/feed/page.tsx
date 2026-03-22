"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Rocket, TrendingUp, GraduationCap, BarChart2,
  Eye, ArrowDownUp, Share2, X,
  RefreshCw, UserCircle, CheckCircle,
} from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { onboardUser, getFeed, engageArticle } from "@/lib/api";
import { cn } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────────────────────────────

interface UserProfile {
  userId: string;
  role: string;
  sectors: string[];
  tickers: string[];
}

interface FeedArticle {
  id: string | number;
  title: string;
  summary?: string;
  score?: number;
  url?: string;
  section?: string;
  pub_date?: string;
  published_at?: string;
}

type EngageSignal = "opened" | "scroll_100" | "shared" | "skipped";

// ── Constants ──────────────────────────────────────────────────────────────────

const LS_KEY = "et_feed_user";

const ROLES: { id: string; label: string; icon: LucideIcon; desc: string }[] = [
  { id: "founder",  label: "Founder / Entrepreneur", icon: Rocket,          desc: "Track funding, exits, and startup ecosystem news"                },
  { id: "investor", label: "Investor",                icon: TrendingUp,      desc: "Markets, valuations, and portfolio company coverage"             },
  { id: "student",  label: "Student",                 icon: GraduationCap,   desc: "Learn about the economy, policy, and business fundamentals"      },
  { id: "analyst",  label: "Financial Analyst",       icon: BarChart2,       desc: "Deep-dive data, earnings, and sector analysis"                   },
];

const SECTORS = [
  "Banking", "Markets", "Technology", "Startups", "Policy",
  "Real Estate", "Commodities", "International", "Budget", "IPO",
];

const ENGAGE_BUTTONS: { icon: LucideIcon; label: string; signal: EngageSignal }[] = [
  { icon: Eye,        label: "Read",    signal: "opened"     },
  { icon: ArrowDownUp,label: "Scrolled",signal: "scroll_100" },
  { icon: Share2,     label: "Shared",  signal: "shared"     },
  { icon: X,          label: "Skip",    signal: "skipped"    },
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function scoreBarColor(score: number): string {
  if (score > 0.5)  return "bg-green-500";
  if (score >= 0.3) return "bg-amber-500";
  return "bg-red-500";
}

function relativeTime(dateStr?: string): string {
  if (!dateStr) return "";
  const ms = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 60)              return `${mins}m ago`;
  if (mins < 60 * 24)         return `${Math.floor(mins / 60)}h ago`;
  return `${Math.floor(mins / 1440)}d ago`;
}

// ── Skeleton card ──────────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="animate-pulse rounded-xl border border-white/10 bg-gray-800/50 overflow-hidden">
      <div className="h-1 w-full bg-gray-700" />
      <div className="p-4 space-y-3">
        <div className="h-3.5 rounded bg-gray-700 w-3/4" />
        <div className="h-3.5 rounded bg-gray-700 w-1/2" />
        <div className="h-3   rounded bg-gray-700 w-5/6" />
        <div className="flex gap-2 pt-2">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-7 w-16 rounded-lg bg-gray-700" />
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Article card ───────────────────────────────────────────────────────────────

interface ArticleCardProps {
  article: FeedArticle;
  userId: string;
  onEngage: () => void;
}

function ArticleCard({ article, userId, onEngage }: ArticleCardProps) {
  const score = article.score ?? 0;
  const [engaged, setEngaged] = useState<EngageSignal | null>(null);
  const dateStr = article.pub_date ?? article.published_at;

  async function handleEngage(signal: EngageSignal) {
    if (engaged) return;
    setEngaged(signal);
    try {
      await engageArticle(userId, article.id, signal);
      onEngage();
    } catch {
      // engagement is non-critical — don't surface an error
    }
  }

  return (
    <div className="flex flex-col rounded-xl border border-white/10 bg-gray-800/50 overflow-hidden">
      {/* Relevance score bar */}
      <div className="h-1 w-full bg-gray-700/60">
        <div
          className={`h-full transition-all duration-500 ${scoreBarColor(score)}`}
          style={{ width: `${Math.min(score * 100, 100)}%` }}
        />
      </div>

      <div className="flex flex-col flex-1 p-4 gap-2">
        {/* Section + time + score */}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 flex-wrap">
            {article.section && (
              <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-gray-400">
                {article.section}
              </span>
            )}
            {dateStr && (
              <span className="text-[10px] text-gray-600">{relativeTime(dateStr)}</span>
            )}
          </div>
          <span className="font-mono text-xs text-gray-500 flex-shrink-0">
            {score.toFixed(2)}
          </span>
        </div>

        {/* Title */}
        <h3 className="text-sm font-semibold text-white leading-snug line-clamp-2">
          {article.title}
        </h3>

        {/* Summary */}
        {article.summary && (
          <p className="text-xs text-gray-400 leading-relaxed line-clamp-2">
            {article.summary}
          </p>
        )}

        {/* Engagement buttons */}
        <div className="flex flex-wrap gap-1.5 mt-auto pt-2">
          {ENGAGE_BUTTONS.map(({ icon: Icon, label, signal }) => (
            <button
              key={signal}
              onClick={() => handleEngage(signal)}
              disabled={engaged !== null}
              className={cn(
                "flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs transition-colors",
                engaged === signal
                  ? "border-[#FF6B35]/50 bg-[#FF6B35]/20 text-[#FF6B35]"
                  : "border-white/10 bg-white/5 text-gray-400 hover:text-white hover:border-white/20",
                engaged !== null && engaged !== signal ? "opacity-40 cursor-default" : "",
              )}
            >
              <Icon className="h-3 w-3" />
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function FeedPage() {
  const [profile, setProfile]           = useState<UserProfile | null>(null);
  const [hydrated, setHydrated]         = useState(false);
  const [articles, setArticles]         = useState<FeedArticle[]>([]);
  const [loading, setLoading]           = useState(false);
  const [error, setError]               = useState<string | null>(null);
  const [toast, setToast]               = useState<string | null>(null);
  const toastTimer                      = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Onboarding form state
  const [selectedRole, setSelectedRole]         = useState("");
  const [selectedSectors, setSelectedSectors]   = useState<string[]>([]);
  const [tickerInput, setTickerInput]           = useState("");
  const [onboarding, setOnboarding]             = useState(false);

  // Read localStorage after mount (avoids SSR mismatch)
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) setProfile(JSON.parse(raw) as UserProfile);
    } catch {
      // ignore malformed data
    }
    setHydrated(true);
  }, []);

  const fetchFeed = useCallback(async (userId: string) => {
    setLoading(true);
    setError(null);
    try {
      const data = await getFeed(userId);
      setArticles(data.articles as FeedArticle[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load feed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (profile) fetchFeed(profile.userId);
  }, [profile, fetchFeed]);

  // Cleanup toast timer on unmount
  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  function showToast(msg: string) {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 2000);
  }

  function toggleSector(sector: string) {
    setSelectedSectors((prev) =>
      prev.includes(sector) ? prev.filter((s) => s !== sector) : [...prev, sector],
    );
  }

  async function handleOnboard() {
    if (!selectedRole) return;
    setOnboarding(true);
    setError(null);
    const userId = `user_${Date.now()}`;
    const tickers = tickerInput
      .split(",")
      .map((t) => t.trim().toUpperCase())
      .filter(Boolean);
    try {
      await onboardUser(userId, selectedRole, selectedSectors, tickers);
      const newProfile: UserProfile = { userId, role: selectedRole, sectors: selectedSectors, tickers };
      localStorage.setItem(LS_KEY, JSON.stringify(newProfile));
      setProfile(newProfile);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Onboarding failed. Is the feed service running?");
    } finally {
      setOnboarding(false);
    }
  }

  function resetProfile() {
    localStorage.removeItem(LS_KEY);
    setProfile(null);
    setArticles([]);
    setSelectedRole("");
    setSelectedSectors([]);
    setTickerInput("");
    setError(null);
  }

  function handleEngage() {
    showToast("✓ Feed updated");
    setTimeout(() => {
      if (profile) fetchFeed(profile.userId);
    }, 1000);
  }

  // Avoid hydration flash — render nothing until localStorage is read
  if (!hydrated) return null;

  // ── Onboarding view ────────────────────────────────────────────────────────

  if (!profile) {
    return (
      <div className="max-w-6xl mx-auto space-y-6">
        <PageHeader
          title="Personalised Feed"
          subtitle="Articles ranked by your reading interests"
          backHref="/"
        />

        {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

        <div className="max-w-2xl mx-auto">
          <div className="rounded-2xl border border-white/10 bg-gray-800/50 p-6 md:p-8 space-y-8">
            <div>
              <h2 className="text-lg font-bold text-white mb-1">Build your feed</h2>
              <p className="text-sm text-gray-400">
                Tell us about yourself so we can rank ET articles by relevance to you.
              </p>
            </div>

            {/* Step 1: Role */}
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">
                Step 1 — Your role
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {ROLES.map(({ id, label, icon: Icon, desc }) => (
                  <button
                    key={id}
                    onClick={() => setSelectedRole(id)}
                    className={cn(
                      "flex items-start gap-3 rounded-xl border p-3.5 text-left transition-colors",
                      selectedRole === id
                        ? "border-[#FF6B35] bg-[#FF6B35]/10"
                        : "border-white/10 bg-white/5 hover:border-white/20",
                    )}
                  >
                    <Icon
                      className={cn(
                        "mt-0.5 h-5 w-5 flex-shrink-0",
                        selectedRole === id ? "text-[#FF6B35]" : "text-gray-400",
                      )}
                    />
                    <div>
                      <p className={cn(
                        "text-sm font-medium",
                        selectedRole === id ? "text-[#FF6B35]" : "text-white",
                      )}>
                        {label}
                      </p>
                      <p className="text-xs text-gray-500 mt-0.5">{desc}</p>
                    </div>
                  </button>
                ))}
              </div>
            </div>

            {/* Step 2: Sectors */}
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">
                Step 2 — Sectors you follow
              </p>
              <div className="flex flex-wrap gap-2">
                {SECTORS.map((sector) => (
                  <button
                    key={sector}
                    onClick={() => toggleSector(sector)}
                    className={cn(
                      "rounded-full border px-3 py-1.5 text-sm transition-colors",
                      selectedSectors.includes(sector)
                        ? "border-[#FF6B35] bg-[#FF6B35]/20 text-[#FF6B35]"
                        : "border-white/10 bg-white/5 text-gray-400 hover:text-white hover:border-white/20",
                    )}
                  >
                    {sector}
                  </button>
                ))}
              </div>
            </div>

            {/* Step 3: Tickers */}
            <div className="space-y-3">
              <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">
                Step 3 — Tickers <span className="normal-case font-normal text-gray-600">(optional)</span>
              </p>
              <input
                type="text"
                value={tickerInput}
                onChange={(e) => setTickerInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleOnboard()}
                placeholder="RELIANCE, HDFC, INFY (comma separated)"
                className="w-full rounded-xl border border-white/10 bg-gray-700/50 px-4 py-2.5 text-sm text-gray-200 placeholder-gray-600 focus:border-[#FF6B35]/50 focus:outline-none focus:ring-1 focus:ring-[#FF6B35]/30"
              />
            </div>

            <button
              onClick={handleOnboard}
              disabled={!selectedRole || onboarding}
              className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#FF6B35] py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {onboarding && <LoadingSpinner size="sm" />}
              {onboarding ? "Building your feed…" : "Build My Feed"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Feed view ──────────────────────────────────────────────────────────────

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <PageHeader
        title="Personalised Feed"
        subtitle="Articles ranked by your reading interests"
        backHref="/"
      />

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      {/* Top bar */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Profile pill */}
        <div className="flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-gray-400">
          <UserCircle className="h-3.5 w-3.5 flex-shrink-0" />
          <span className="capitalize font-medium text-gray-300">{profile.role}</span>
          {profile.sectors.length > 0 && (
            <>
              <span className="text-gray-700">·</span>
              {profile.sectors.slice(0, 3).map((s) => (
                <span key={s}>{s}</span>
              ))}
              {profile.sectors.length > 3 && (
                <span className="text-gray-600">+{profile.sectors.length - 3}</span>
              )}
            </>
          )}
        </div>

        <div className="flex gap-2 ml-auto">
          <button
            onClick={() => fetchFeed(profile.userId)}
            disabled={loading}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-gray-400 hover:text-white transition-colors disabled:opacity-40"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", loading && "animate-spin")} />
            Refresh Feed
          </button>
          <button
            onClick={resetProfile}
            className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-gray-400 hover:text-red-400 hover:border-red-700/30 transition-colors"
          >
            Reset Profile
          </button>
        </div>
      </div>

      {/* Article grid */}
      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      ) : articles.length === 0 ? (
        <div className="rounded-xl border border-white/10 bg-gray-800/30 py-20 text-center">
          <p className="text-sm text-gray-500">
            No articles yet — your feed will populate as ET publishes new content.
          </p>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {articles.map((article) => (
            <ArticleCard
              key={article.id}
              article={article}
              userId={profile.userId}
              onEngage={handleEngage}
            />
          ))}
        </div>
      )}

      {/* Toast notification */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2 rounded-full border border-green-700/50 bg-green-950/90 px-5 py-2.5 text-sm font-medium text-green-300 shadow-xl">
          <CheckCircle className="h-4 w-4" />
          {toast}
        </div>
      )}
    </div>
  );
}
