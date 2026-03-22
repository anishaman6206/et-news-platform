"use client";

import { useState } from "react";
import { X } from "lucide-react";

interface Props {
  message: string;
  onDismiss?: () => void;
}

export function ErrorBanner({ message, onDismiss }: Props) {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  function handleDismiss() {
    setDismissed(true);
    onDismiss?.();
  }

  return (
    <div
      role="alert"
      className="flex items-start justify-between gap-3 rounded-lg border border-red-700 bg-red-950/60 px-4 py-3 text-sm text-red-300"
    >
      <span className="flex-1">{message}</span>
      <button
        onClick={handleDismiss}
        aria-label="Dismiss error"
        className="mt-0.5 flex-shrink-0 rounded p-0.5 text-red-400 hover:text-red-200 hover:bg-red-800/40 transition-colors"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
