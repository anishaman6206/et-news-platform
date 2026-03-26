"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Film,
  Download,
  CheckCircle,
  XCircle,
  RefreshCw,
  Bot,
} from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { listVideoJobs, getVideoStatus, getVideoDownloadUrl } from "@/lib/api";
import type { VideoStatusResponse } from "@/lib/api";
import { cn } from "@/lib/utils";

// ── Helpers ────────────────────────────────────────────────────────────────────

function statusLabel(job: VideoStatusResponse): string {
  if (job.status === "queued") return "Waiting to start…";
  if (job.status === "processing") {
    const p = job.progress ?? 0;
    if (p < 25) return "Generating script with GPT-4o…";
    if (p < 45) return "Synthesising audio with OpenAI TTS…";
    if (p < 65) return "Rendering video frames…";
    if (p < 80) return "Assembling final MP4 with FFmpeg…";
    return "Finalising video…";
  }
  if (job.status === "done") return "Video ready";
  if (job.status === "failed") return "Generation failed";
  return job.status;
}

function formatTs(ts: string | number | undefined): string {
  if (!ts) return "";
  try {
    const d = typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
    return new Intl.DateTimeFormat("en-IN", {
      hour: "2-digit",
      minute: "2-digit",
      day: "numeric",
      month: "short",
    }).format(d);
  } catch {
    return String(ts).slice(0, 16);
  }
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function ProgressBar({ progress }: { progress: number }) {
  return (
    <div className="h-3 w-full overflow-hidden rounded-full bg-gray-700">
      <div
        className="h-3 rounded-full bg-[#FF6B35] transition-all duration-700"
        style={{ width: `${Math.max(4, progress)}%` }}
      />
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "done")
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-green-700/50 bg-green-950/60 px-2.5 py-1 text-xs font-medium text-green-400">
        <CheckCircle className="h-3.5 w-3.5" /> Done
      </span>
    );
  if (status === "failed")
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-red-700/50 bg-red-950/60 px-2.5 py-1 text-xs font-medium text-red-400">
        <XCircle className="h-3.5 w-3.5" /> Failed
      </span>
    );
  if (status === "processing" || status === "queued")
    return (
      <span className="inline-flex items-center gap-1 rounded-full border border-amber-700/50 bg-amber-950/60 px-2.5 py-1 text-xs font-medium text-amber-400">
        <LoadingSpinner size="sm" /> {status === "queued" ? "Queued" : "Processing"}
      </span>
    );
  return (
    <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-gray-400 capitalize">
      {status}
    </span>
  );
}

interface VideoCardProps {
  job: VideoStatusResponse;
  onRefresh: (jobId: string) => void;
}

function VideoCard({ job, onRefresh }: VideoCardProps) {
  const downloadUrl = getVideoDownloadUrl(job.job_id);
  const isDone = job.status === "done";
  const isActive = job.status === "queued" || job.status === "processing";
  const isFailed = job.status === "failed";

  return (
    <div
      className={cn(
        "rounded-2xl border bg-gray-800/50 p-5 space-y-4",
        isDone
          ? "border-green-700/30"
          : isFailed
            ? "border-red-700/30"
            : "border-white/10",
      )}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-white leading-snug line-clamp-2">
            {job.title ?? `Video ${job.job_id.slice(0, 8)}…`}
          </p>
          {job.created_at && (
            <p className="text-xs text-gray-500 mt-0.5">{formatTs(job.created_at)}</p>
          )}
        </div>
        <StatusBadge status={job.status} />
      </div>

      {/* Progress bar for active jobs */}
      {isActive && (
        <div className="space-y-2">
          <ProgressBar progress={job.progress ?? 0} />
          <div className="flex items-center gap-2">
            <LoadingSpinner size="sm" />
            <p className="text-xs text-gray-400">{statusLabel(job)}</p>
            <span className="ml-auto text-xs text-gray-600">{job.progress ?? 0}%</span>
          </div>
          <button
            onClick={() => onRefresh(job.job_id)}
            className="flex items-center gap-1.5 text-xs text-gray-500 hover:text-white transition-colors"
          >
            <RefreshCw className="h-3 w-3" /> Refresh status
          </button>
        </div>
      )}

      {/* Video player for done jobs */}
      {isDone && (
        <>
          <div className="overflow-hidden rounded-xl border border-white/10 bg-black">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video
              controls
              src={downloadUrl}
              className="w-full"
              style={{ display: "block" }}
            />
          </div>
          <a
            href={downloadUrl}
            download="et-news-video.mp4"
            className="inline-flex items-center gap-2 rounded-xl bg-[#FF6B35] px-4 py-2 text-sm font-semibold text-white hover:bg-[#e55a25] transition-colors"
          >
            <Download className="h-4 w-4" /> Download MP4
          </a>
        </>
      )}

      {/* Error for failed jobs */}
      {isFailed && job.error && (
        <pre className="overflow-x-auto rounded-xl border border-white/10 bg-gray-900 p-3 font-mono text-xs text-red-400 whitespace-pre-wrap">
          {job.error}
        </pre>
      )}

      {/* Job ID */}
      <p className="font-mono text-[10px] text-gray-700">{job.job_id}</p>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-white/10 bg-gray-800/30 py-24 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/5">
        <Film className="h-6 w-6 text-gray-500" />
      </div>
      <div>
        <p className="text-sm font-medium text-gray-400">No videos generated yet</p>
        <p className="mt-1 text-xs text-gray-600">
          The agent automatically generates videos for high-importance articles
        </p>
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function VideoPage() {
  const [jobs, setJobs] = useState<VideoStatusResponse[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchJobs = useCallback(async () => {
    try {
      const res = await listVideoJobs();
      setJobs(res.jobs ?? []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load videos");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchJobs();
    // Poll every 5 s while any job is active
    const interval = setInterval(async () => {
      const hasActive = jobs.some(
        (j) => j.status === "queued" || j.status === "processing",
      );
      if (hasActive) await fetchJobs();
    }, 5_000);
    return () => clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchJobs]);

  const handleRefreshOne = async (jobId: string) => {
    try {
      const updated = await getVideoStatus(jobId);
      setJobs((prev) =>
        prev.map((j) => (j.job_id === jobId ? updated : j)),
      );
    } catch {
      // ignore
    }
  };

  return (
    <div className="min-h-screen bg-gray-900">
      <div className="mx-auto max-w-4xl space-y-6 px-4 py-8">
        <PageHeader
          title="AI Video Studio"
          subtitle="Broadcast-ready MP4 videos generated from ET articles"
        />

        {/* Agent note */}
        <div className="flex items-center gap-3 rounded-2xl border border-[#FF6B35]/20 bg-[#FF6B35]/5 px-4 py-3">
          <Bot className="h-4 w-4 text-[#FF6B35] shrink-0" />
          <p className="text-xs text-gray-300">
            Videos are generated automatically by the agent for high-importance
            articles. Generation takes 60–120 seconds per video.
          </p>
        </div>

        {/* Refresh button */}
        <div className="flex justify-end">
          <button
            onClick={() => void fetchJobs()}
            disabled={loading}
            className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-xs text-gray-400 hover:text-white hover:bg-white/10 transition-colors disabled:opacity-40"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>

        {/* Loading */}
        {loading && (
          <div className="flex items-center justify-center py-20">
            <LoadingSpinner size="lg" />
          </div>
        )}

        {/* Error */}
        {!loading && error && (
          <div className="rounded-xl border border-red-700/40 bg-red-950/30 p-4 text-sm text-red-400">
            {error} —{" "}
            <button
              onClick={() => void fetchJobs()}
              className="underline hover:text-red-300"
            >
              Retry
            </button>
          </div>
        )}

        {/* Empty */}
        {!loading && !error && jobs.length === 0 && <EmptyState />}

        {/* Video grid */}
        {jobs.length > 0 && (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2">
            {jobs.map((job) => (
              <VideoCard
                key={job.job_id}
                job={job}
                onRefresh={(id) => void handleRefreshOne(id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
