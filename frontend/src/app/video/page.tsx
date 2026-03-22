"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { Video, Download, RefreshCw, CheckCircle, XCircle, Film } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { generateVideo, getVideoStatus, getVideoDownloadUrl } from "@/lib/api";
import type { VideoStatusResponse } from "@/lib/api";
import { cn } from "@/lib/utils";

// ── Sample articles ────────────────────────────────────────────────────────────

const SAMPLES: Record<string, { title: string; text: string }> = {
  "RBI Rate Decision": {
    title: "RBI holds repo rate at 6.5%",
    text:
      "The Reserve Bank of India kept the repo rate unchanged at 6.5% in its March 2026 meeting. " +
      "Governor Shaktikanta Das cited easing inflation and stable GDP growth as key factors. " +
      "The equity markets reacted positively with Nifty gaining 200 points on the news.",
  },
  "SEBI Regulations": {
    title: "SEBI tightens mutual fund disclosure norms",
    text:
      "SEBI has tightened mutual fund regulations requiring all equity funds to disclose portfolio " +
      "overlap with benchmark indices. The move affects over 500 mutual fund schemes across 40 " +
      "asset management companies. SEBI chairperson said the new norms improve transparency for retail investors.",
  },
  "Budget 2026": {
    title: "Union Budget 2026: Rs 15 lakh crore capex, no tax up to Rs 12 lakh",
    text:
      "Finance Minister Nirmala Sitharaman presented the Union Budget 2026 with a fiscal deficit " +
      "target of 4.5% of GDP. The budget allocated increased funds for infrastructure with a capital " +
      "expenditure of Rs 15 lakh crore. Income tax slabs were revised benefiting the middle class " +
      "with no tax up to Rs 12 lakh annual income.",
  },
};

// ── Types ──────────────────────────────────────────────────────────────────────

interface HistoryEntry {
  jobId: string;
  status: string;
  title: string;
  timestamp: number;
}

const HISTORY_KEY = "et_video_history";
const POLL_MS = 3000;

// ── Helpers ────────────────────────────────────────────────────────────────────

function statusLabel(job: VideoStatusResponse): string {
  if (job.status === "queued") return "Waiting to start...";
  if (job.status === "processing") {
    const p = job.progress ?? 0;
    if (p < 25)  return "Generating script with GPT-4o...";
    if (p < 45)  return "Synthesising audio with OpenAI TTS...";
    if (p < 65)  return "Rendering video frames...";
    if (p < 80)  return "Assembling final MP4 with FFmpeg...";
    return "Finalising video...";
  }
  if (job.status === "done")   return "Video ready";
  if (job.status === "failed") return "Generation failed";
  return job.status;
}

function loadHistory(): HistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]") as HistoryEntry[];
  } catch {
    return [];
  }
}

function saveHistory(entries: HistoryEntry[]) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(entries.slice(0, 3)));
}

function upsertHistory(entry: HistoryEntry) {
  const existing = loadHistory();
  const filtered = existing.filter((e) => e.jobId !== entry.jobId);
  saveHistory([entry, ...filtered]);
}

function formatTs(ts: number): string {
  return new Intl.DateTimeFormat("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    day: "numeric",
    month: "short",
  }).format(new Date(ts));
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-2xl border border-white/10 bg-gray-800/30 py-20 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/5">
        <Film className="h-6 w-6 text-gray-500" />
      </div>
      <p className="text-sm font-medium text-gray-400">Generate a video above to get started</p>
    </div>
  );
}

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

interface ActiveJobProps {
  job: VideoStatusResponse;
  elapsed: number;
}

function ActiveJobCard({ job, elapsed }: ActiveJobProps) {
  return (
    <div className="space-y-4 rounded-2xl border border-white/10 bg-gray-800/50 p-6">
      <div className="flex items-center justify-between">
        <p className="font-mono text-xs text-gray-600">
          Job {job.job_id.slice(0, 8)}…
        </p>
        <span className="text-xs text-gray-500">{elapsed}s elapsed</span>
      </div>

      <ProgressBar progress={job.progress ?? 0} />

      <div className="flex items-center gap-2">
        <LoadingSpinner size="sm" />
        <p className="text-sm text-gray-300">{statusLabel(job)}</p>
        <span className="ml-auto text-xs text-gray-600">{job.progress ?? 0}%</span>
      </div>
    </div>
  );
}

interface DoneJobProps {
  job: VideoStatusResponse;
  elapsed: number;
  onReset: () => void;
}

function DoneJobCard({ job, elapsed, onReset }: DoneJobProps) {
  const downloadUrl = getVideoDownloadUrl(job.job_id);

  return (
    <div className="space-y-5 rounded-2xl border border-green-700/40 bg-gray-800/50 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-green-700/50 bg-green-950/60 px-3 py-1 text-sm font-medium text-green-400">
          <CheckCircle className="h-4 w-4" /> Video ready
        </span>
        <span className="text-xs text-gray-500">Generated in {elapsed}s</span>
      </div>

      {/* Inline video player */}
      <div className="mx-auto w-full max-w-3xl overflow-hidden rounded-xl border border-white/10 bg-black">
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <video
          controls
          src={downloadUrl}
          className="w-full"
          style={{ display: "block" }}
        />
      </div>

      <div className="flex flex-wrap gap-3">
        <a
          href={downloadUrl}
          download="et-news-video.mp4"
          className="flex items-center gap-2 rounded-xl bg-[#FF6B35] px-5 py-2.5 text-sm font-semibold text-white transition-all hover:bg-[#e55a25] active:scale-95"
        >
          <Download className="h-4 w-4" /> Download MP4
        </a>
        <button
          onClick={onReset}
          className="flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-5 py-2.5 text-sm font-medium text-gray-300 transition-all hover:bg-white/10"
        >
          <RefreshCw className="h-4 w-4" /> Generate Another
        </button>
      </div>
    </div>
  );
}

interface FailedJobProps {
  job: VideoStatusResponse;
  onReset: () => void;
}

function FailedJobCard({ job, onReset }: FailedJobProps) {
  return (
    <div className="space-y-4 rounded-2xl border border-red-700/40 bg-gray-800/50 p-6">
      <span className="inline-flex items-center gap-1.5 rounded-full border border-red-700/50 bg-red-950/60 px-3 py-1 text-sm font-medium text-red-400">
        <XCircle className="h-4 w-4" /> Generation failed
      </span>

      {job.error && (
        <pre className="overflow-x-auto rounded-xl border border-white/10 bg-gray-900 p-4 font-mono text-xs text-red-400 whitespace-pre-wrap">
          {job.error}
        </pre>
      )}

      <button
        onClick={onReset}
        className="flex items-center gap-2 rounded-xl bg-[#FF6B35] px-5 py-2.5 text-sm font-semibold text-white transition-all hover:bg-[#e55a25] active:scale-95"
      >
        <RefreshCw className="h-4 w-4" /> Try Again
      </button>
    </div>
  );
}

function HistoryBadge({ status }: { status: string }) {
  if (status === "done")
    return <span className="rounded-full border border-green-700/50 bg-green-950/50 px-2 py-0.5 text-[10px] text-green-400">Done</span>;
  if (status === "failed")
    return <span className="rounded-full border border-red-700/50 bg-red-950/50 px-2 py-0.5 text-[10px] text-red-400">Failed</span>;
  return <span className="rounded-full border border-white/10 bg-white/5 px-2 py-0.5 text-[10px] text-gray-400 capitalize">{status}</span>;
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function VideoPage() {
  const [title,       setTitle]       = useState("");
  const [text,        setText]        = useState("");
  const [submitting,  setSubmitting]  = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const [job,         setJob]         = useState<VideoStatusResponse | null>(null);
  const [elapsed,     setElapsed]     = useState(0);
  const [history,     setHistory]     = useState<HistoryEntry[]>([]);

  const pollRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const timerRef   = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTime  = useRef<number>(0);

  // Load history from localStorage on mount
  useEffect(() => {
    setHistory(loadHistory());
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current)  { clearInterval(pollRef.current);  pollRef.current  = null; }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  }, []);

  const startPolling = useCallback((jobId: string, jobTitle: string) => {
    stopPolling();
    startTime.current = Date.now();
    setElapsed(0);

    // Elapsed counter
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTime.current) / 1000));
    }, 1000);

    // Status poller
    pollRef.current = setInterval(async () => {
      try {
        const status = await getVideoStatus(jobId);
        setJob(status);

        const entry: HistoryEntry = {
          jobId,
          status: status.status,
          title: jobTitle,
          timestamp: startTime.current,
        };
        upsertHistory(entry);
        setHistory(loadHistory());

        if (status.status === "done" || status.status === "failed") {
          stopPolling();
        }
      } catch {
        // Keep polling on transient errors
      }
    }, POLL_MS);
  }, [stopPolling]);

  // Cleanup on unmount
  useEffect(() => () => stopPolling(), [stopPolling]);

  const handleGenerate = useCallback(async () => {
    if (!title.trim() || !text.trim()) return;
    setSubmitting(true);
    setSubmitError(null);
    setJob(null);
    try {
      const articleId = `web_${Date.now()}`;
      const resp = await generateVideo(articleId, title.trim(), text.trim());
      // Seed the job state immediately so UI shows the active card
      setJob({ job_id: resp.job_id, status: resp.status, progress: 0, output_path: null, error: null });
      startPolling(resp.job_id, title.trim());
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : "Failed to queue video job");
    } finally {
      setSubmitting(false);
    }
  }, [title, text, startPolling]);

  function loadSample(key: string) {
    const s = SAMPLES[key];
    if (s) { setTitle(s.title); setText(s.text); }
  }

  function handleReset() {
    stopPolling();
    setJob(null);
    setElapsed(0);
    setSubmitError(null);
  }

  async function handleLoadHistory(entry: HistoryEntry) {
    if (entry.status !== "done") return;
    try {
      const status = await getVideoStatus(entry.jobId);
      setJob(status);
      setElapsed(0);
    } catch {
      // ignore
    }
  }

  const isActive = job && (job.status === "queued" || job.status === "processing");
  const isDone   = job?.status === "done";
  const isFailed = job?.status === "failed";

  return (
    <div className="min-h-screen bg-gray-900">
      <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
        <PageHeader
          title="AI Video Studio"
          subtitle="Turn ET articles into broadcast-ready MP4 videos"
        />

        {/* ── Input card ── */}
        <div className="space-y-4 rounded-2xl border border-white/10 bg-gray-800/50 p-6">
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. RBI holds repo rate at 6.5%"
            className="w-full rounded-xl border border-white/10 bg-gray-900 px-3.5 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-[#FF6B35]/50 focus:ring-1 focus:ring-[#FF6B35]/30"
          />

          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Paste article text..."
            rows={5}
            className="w-full resize-none rounded-xl border border-white/10 bg-gray-900 px-3.5 py-2.5 text-sm text-white placeholder-gray-600 outline-none focus:border-[#FF6B35]/50 focus:ring-1 focus:ring-[#FF6B35]/30"
            style={{ minHeight: "150px" }}
          />

          {submitError && <ErrorBanner message={submitError} />}

          <button
            onClick={() => void handleGenerate()}
            disabled={submitting || !title.trim() || !text.trim()}
            className={cn(
              "flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold transition-all",
              submitting || !title.trim() || !text.trim()
                ? "cursor-not-allowed bg-gray-700 text-gray-500"
                : "bg-[#FF6B35] text-white hover:bg-[#e55a25] active:scale-[0.98]",
            )}
          >
            {submitting ? (
              <><LoadingSpinner size="sm" /> Queuing job…</>
            ) : (
              <><Video className="h-4 w-4" /> Generate Video</>
            )}
          </button>

          {/* Sample buttons */}
          <div className="flex flex-wrap gap-2">
            {Object.keys(SAMPLES).map((key) => (
              <button
                key={key}
                onClick={() => loadSample(key)}
                className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-gray-400 transition-colors hover:border-white/20 hover:text-white"
              >
                {key}
              </button>
            ))}
          </div>

          {/* Info note */}
          <p className="rounded-xl border border-white/5 bg-white/5 px-4 py-3 text-xs leading-relaxed text-gray-500">
            Video generation takes 60–120 seconds. The AI writes the script, synthesises narration,
            renders frames, and assembles the MP4.
          </p>
        </div>

        {/* ── Job output ── */}
        {!job && !submitting && <EmptyState />}

        {isActive && <ActiveJobCard job={job} elapsed={elapsed} />}

        {isDone && (
          <DoneJobCard job={job} elapsed={elapsed} onReset={handleReset} />
        )}

        {isFailed && <FailedJobCard job={job} onReset={handleReset} />}

        {/* ── Job history ── */}
        {history.length > 0 && (
          <section className="space-y-2">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-600">
              Recent jobs
            </p>
            <div className="divide-y divide-white/5 rounded-2xl border border-white/10 bg-gray-800/30 overflow-hidden">
              {history.map((entry) => (
                <button
                  key={entry.jobId}
                  onClick={() => void handleLoadHistory(entry)}
                  disabled={entry.status !== "done"}
                  className={cn(
                    "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors",
                    entry.status === "done"
                      ? "hover:bg-white/5 cursor-pointer"
                      : "cursor-default opacity-60",
                  )}
                >
                  <span className="font-mono text-xs text-gray-600">
                    {entry.jobId.slice(0, 8)}…
                  </span>
                  <span className="flex-1 truncate text-xs text-gray-400">{entry.title}</span>
                  <HistoryBadge status={entry.status} />
                  <span className="flex-shrink-0 text-[10px] text-gray-600">
                    {formatTs(entry.timestamp)}
                  </span>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
