"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { Film, ChevronRight, Download, Loader2 } from "lucide-react";
import { listVideoJobs, getVideoDownloadUrl } from "@/lib/api";
import type { VideoStatusResponse } from "@/lib/api";

export function VideoStudioPanel() {
  const [jobs, setJobs] = useState<VideoStatusResponse[]>([]);

  const refresh = useCallback(async () => {
    try {
      const res = await listVideoJobs();
      // Show done jobs + any in-progress ones (so users can see queued/processing)
      const all = res.jobs ?? [];
      const visible = all
        .filter((j) => j.status === "done" || j.status === "processing" || j.status === "queued")
        .slice(0, 4);
      setJobs(visible);
    } catch {
      // fail silently
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
          <div className="h-5 w-5 rounded-full bg-purple-500/10 flex items-center justify-center">
            <Film className="h-3 w-3 text-purple-400" />
          </div>
          <p className="text-xs font-semibold text-white">Video Studio</p>
        </div>
        <Link
          href="/video"
          className="flex items-center gap-0.5 text-[10px] text-purple-400 hover:text-purple-300"
        >
          View all <ChevronRight className="h-3 w-3" />
        </Link>
      </div>

      {jobs.length === 0 ? (
        <div className="text-center py-4 space-y-1">
          <Film className="h-5 w-5 text-gray-700 mx-auto" />
          <p className="text-[10px] text-gray-600">No videos yet</p>
          <p className="text-[10px] text-gray-600">
            Click &ldquo;Video&rdquo; on any article to generate
          </p>
        </div>
      ) : (
        <div className="space-y-3">
          {jobs.map((job) => {
            const isDone = job.status === "done";
            const downloadUrl = isDone ? getVideoDownloadUrl(job.job_id) : null;
            return (
              <div key={job.job_id} className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <p className="text-[11px] text-gray-300 font-medium line-clamp-1 flex-1">
                    {job.title ?? `Video ${job.job_id.slice(0, 8)}`}
                  </p>
                  {!isDone && (
                    <span className="flex items-center gap-1 text-[9px] text-purple-400">
                      <Loader2 className="h-2.5 w-2.5 animate-spin" />
                      {job.status}
                    </span>
                  )}
                </div>
                {isDone && downloadUrl && (
                  <>
                    <div className="rounded-lg overflow-hidden bg-black border border-white/10">
                      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                      <video
                        src={downloadUrl}
                        controls
                        className="w-full"
                        style={{ maxHeight: "120px" }}
                      />
                    </div>
                    <a
                      href={downloadUrl}
                      download="et-news-video.mp4"
                      className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-white transition-colors"
                    >
                      <Download className="h-3 w-3" /> Download
                    </a>
                  </>
                )}
                {!isDone && (
                  <div className="h-1 w-full rounded-full bg-gray-700">
                    <div
                      className="h-1 rounded-full bg-purple-500/70 transition-all"
                      style={{ width: `${job.progress ?? 5}%` }}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
