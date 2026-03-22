"use client";

import { useEffect, useState } from "react";
import { healthCheck, type ServiceName } from "@/lib/api";

interface Props {
  service: ServiceName;
  showLabel?: boolean;
}

type Status = "checking" | "online" | "offline";

const DOT_COLOR: Record<Status, string> = {
  checking: "bg-yellow-400 animate-pulse",
  online:   "bg-green-500",
  offline:  "bg-red-500",
};

const DOT_TITLE: Record<Status, string> = {
  checking: "Checking…",
  online:   "Online",
  offline:  "Offline",
};

export function ServiceStatus({ service, showLabel = true }: Props) {
  const [status, setStatus]   = useState<Status>("checking");
  const [latency, setLatency] = useState<number | null>(null);

  async function check() {
    setStatus("checking");
    const t0 = performance.now();
    try {
      await healthCheck(service);
      setLatency(Math.round(performance.now() - t0));
      setStatus("online");
    } catch {
      // Network error, CORS, or 503 from proxy — treat as offline
      setLatency(null);
      setStatus("offline");
    }
  }

  useEffect(() => {
    check();
    const id = setInterval(check, 30_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [service]);

  return (
    <span className="flex items-center gap-1.5" title={`${service}: ${DOT_TITLE[status]}`}>
      <span
        className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${DOT_COLOR[status]}`}
      />
      {showLabel && (
        <span className="text-xs text-gray-400">
          {service}
          {status === "online" && latency !== null && (
            <span className="ml-1 text-gray-500">{latency}ms</span>
          )}
          {status === "offline" && (
            <span className="ml-1 text-red-400">offline</span>
          )}
        </span>
      )}
    </span>
  );
}
