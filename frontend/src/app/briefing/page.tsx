"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import {
  Search, Zap, RefreshCw, Send, Eye,
  BookOpen, MessageCircle,
} from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { generateBriefing, askBriefing } from "@/lib/api";
import { cn } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────────────────────────────

interface BriefingDevelopment {
  text: string;
  source_ids: string[];
}

interface BriefingStakeholder {
  name: string;
  role: string;
  sentiment: string;
}

interface BriefingData {
  topic: string;
  summary?: string;
  key_developments?: BriefingDevelopment[];
  stakeholders?: BriefingStakeholder[];
  open_questions?: string[];
  what_to_watch?: string[];
  sections?: Array<{ heading: string; body: string; source_ids: string[] }>;
  cached?: boolean;
}

interface ChatEntry {
  question: string;
  answer: string;
  streaming: boolean;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const QUICK_TOPICS = [
  "RBI Monetary Policy",
  "SEBI Regulations",
  "Union Budget 2026",
  "Nifty 50 Markets",
];

// ── Helpers ────────────────────────────────────────────────────────────────────

function sentimentStyle(sentiment: string): string {
  switch (sentiment.toLowerCase()) {
    case "optimistic": return "border-green-700/50 bg-green-950/50 text-green-400";
    case "cautious":   return "border-amber-700/50 bg-amber-950/50 text-amber-400";
    case "negative":   return "border-red-700/50   bg-red-950/50   text-red-400";
    default:           return "border-white/10      bg-white/5       text-gray-400";
  }
}

// Parse raw accumulated SSE text into a BriefingData object.
// Handles: proper SSE chunks, raw JSON, or fenced JSON in a single message.
function parseBriefingText(raw: string): BriefingData | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Strip markdown fences — GPT-4o sometimes wraps JSON in ```json ... ```
  const clean = trimmed
    .replace(/^```json\n?/, "")
    .replace(/^```\n?/, "")
    .replace(/\n?```$/, "")
    .trim();

  try {
    return JSON.parse(clean) as BriefingData;
  } catch {
    return null;
  }
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function BriefingSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="space-y-2">
        <div className="h-3 rounded bg-gray-700 w-20" />
        <div className="h-4 rounded bg-gray-700 w-full" />
        <div className="h-4 rounded bg-gray-700 w-4/5" />
        <div className="h-4 rounded bg-gray-700 w-3/5" />
      </div>
      {[1, 2, 3].map((i) => (
        <div key={i} className="space-y-2">
          <div className="h-3 rounded bg-gray-700 w-32" />
          <div className="h-4 rounded bg-gray-700 w-11/12" />
          <div className="h-4 rounded bg-gray-700 w-2/3" />
        </div>
      ))}
    </div>
  );
}

interface EmptyStateProps {
  onQuickTopic: (topic: string) => void;
}

function EmptyState({ onQuickTopic }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center h-full min-h-[320px] gap-6 text-center px-6">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-white/10 bg-white/5">
        <BookOpen className="h-6 w-6 text-gray-500" />
      </div>
      <div>
        <p className="text-sm font-medium text-gray-400">Enter a topic to generate an AI briefing</p>
        <p className="text-xs text-gray-600 mt-1">Sourced strictly from ET articles</p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {QUICK_TOPICS.map((t) => (
          <button
            key={t}
            onClick={() => onQuickTopic(t)}
            className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-gray-400 hover:text-white hover:border-white/20 transition-colors"
          >
            {t}
          </button>
        ))}
      </div>
    </div>
  );
}

interface BriefingDisplayProps {
  data: BriefingData;
  elapsed: number | null;
}

function BriefingDisplay({ data, elapsed }: BriefingDisplayProps) {
  return (
    <div className="space-y-6">
      {/* Cache + timing badge */}
      <div className="flex items-center justify-between">
        <h2 className="text-base font-bold text-white truncate pr-4">{data.topic}</h2>
        <div className="flex items-center gap-2 flex-shrink-0">
          {data.cached ? (
            <span className="flex items-center gap-1 rounded-full border border-green-700/50 bg-green-950/50 px-2.5 py-1 text-xs text-green-400">
              <Zap className="h-3 w-3" /> Cached
            </span>
          ) : (
            <span className="flex items-center gap-1 rounded-full border border-blue-700/50 bg-blue-950/50 px-2.5 py-1 text-xs text-blue-400">
              <RefreshCw className="h-3 w-3" /> Fresh
            </span>
          )}
          {elapsed !== null && (
            <span className="text-xs text-gray-600">{elapsed}ms</span>
          )}
        </div>
      </div>

      {/* SUMMARY */}
      {data.summary && (
        <section className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">Summary</p>
          <p className="text-sm text-gray-200 leading-relaxed">{data.summary}</p>
        </section>
      )}

      {/* KEY DEVELOPMENTS */}
      {data.key_developments && data.key_developments.length > 0 && (
        <section className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">Key Developments</p>
          <div className="space-y-2">
            {data.key_developments.map((dev, i) => (
              <div key={i} className="rounded-xl border border-white/10 bg-gray-800/50 p-3.5">
                <p className="text-sm text-gray-200 leading-relaxed mb-2">{dev.text}</p>
                {dev.source_ids && dev.source_ids.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {dev.source_ids.map((sid) => (
                      <span
                        key={sid}
                        title={`Source: ${sid}`}
                        className="rounded border border-[#FF6B35]/30 bg-[#FF6B35]/10 px-1.5 py-0.5 text-[10px] font-mono text-[#FF6B35] cursor-default"
                      >
                        [{sid}]
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* STAKEHOLDERS */}
      {data.stakeholders && data.stakeholders.length > 0 && (
        <section className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">Stakeholders</p>
          <div className="space-y-1.5">
            {data.stakeholders.map((s, i) => (
              <div
                key={i}
                className="flex items-center justify-between rounded-xl border border-white/10 bg-gray-800/40 px-3.5 py-2.5 gap-3"
              >
                <div className="min-w-0">
                  <span className="text-sm font-medium text-white">{s.name}</span>
                  {s.role && (
                    <span className="text-xs text-gray-500 ml-2">{s.role}</span>
                  )}
                </div>
                <span
                  className={cn(
                    "flex-shrink-0 rounded-full border px-2.5 py-0.5 text-[10px] capitalize",
                    sentimentStyle(s.sentiment),
                  )}
                >
                  {s.sentiment}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* OPEN QUESTIONS */}
      {data.open_questions && data.open_questions.length > 0 && (
        <section className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">Open Questions</p>
          <ol className="space-y-1.5 list-none">
            {data.open_questions.map((q, i) => (
              <li key={i} className="flex gap-2 text-sm text-gray-400 italic">
                <span className="text-gray-600 flex-shrink-0">{i + 1}.</span>
                <span>{q}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      {/* WHAT TO WATCH */}
      {data.what_to_watch && data.what_to_watch.length > 0 && (
        <section className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">What to Watch</p>
          <ul className="space-y-1.5">
            {data.what_to_watch.map((item, i) => (
              <li key={i} className="flex gap-2 text-sm text-gray-300">
                <Eye className="h-3.5 w-3.5 text-gray-600 flex-shrink-0 mt-0.5" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Fallback: generic sections if named fields absent */}
      {!data.summary && data.sections && data.sections.map((section, i) => (
        <section key={i} className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
            {section.heading}
          </p>
          <p className="text-sm text-gray-300 leading-relaxed">{section.body}</p>
          {section.source_ids && section.source_ids.length > 0 && (
            <div className="flex flex-wrap gap-1.5 mt-1">
              {section.source_ids.map((sid) => (
                <span
                  key={sid}
                  title={`Source: ${sid}`}
                  className="rounded border border-[#FF6B35]/30 bg-[#FF6B35]/10 px-1.5 py-0.5 text-[10px] font-mono text-[#FF6B35]"
                >
                  [{sid}]
                </span>
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function BriefingPage() {
  const [topic, setTopic]           = useState("");
  const [briefing, setBriefing]     = useState<BriefingData | null>(null);
  const [streaming, setStreaming]   = useState(false);
  const [elapsed, setElapsed]       = useState<number | null>(null);
  const [error, setError]           = useState<string | null>(null);

  // Q&A
  const [question, setQuestion]     = useState("");
  const [chatHistory, setChatHistory] = useState<ChatEntry[]>([]);
  const [qaStreaming, setQaStreaming]  = useState(false);

  // Refs
  const esRef       = useRef<EventSource | null>(null);
  const qaEsRef     = useRef<EventSource | null>(null);
  const accRef      = useRef<string>("");
  const qaAccRef    = useRef<string>("");
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const t0Ref       = useRef<number>(0);

  // Scroll chat to bottom when history updates
  useEffect(() => {
    chatScrollRef.current?.scrollTo({ top: chatScrollRef.current.scrollHeight, behavior: "smooth" });
  }, [chatHistory]);

  // Cleanup EventSources on unmount
  useEffect(() => {
    return () => {
      esRef.current?.close();
      qaEsRef.current?.close();
    };
  }, []);

  const closeES = useCallback(() => {
    esRef.current?.close();
    esRef.current = null;
  }, []);

  const closeQaES = useCallback(() => {
    qaEsRef.current?.close();
    qaEsRef.current = null;
  }, []);

  const handleGenerate = useCallback((topicStr: string) => {
    if (!topicStr.trim()) return;
    closeES();
    closeQaES();
    setBriefing(null);
    setChatHistory([]);
    setError(null);
    setStreaming(true);
    setElapsed(null);
    accRef.current = "";
    t0Ref.current = performance.now();

    const es = generateBriefing(topicStr.trim());
    esRef.current = es;

    es.onmessage = (event: MessageEvent<string>) => {
      console.log("[SSE briefing]", event.data);

      if (event.data === "[DONE]") {
        // [DONE] sentinel — parse whatever we have accumulated
        const parsed = parseBriefingText(accRef.current);
        if (parsed) {
          setBriefing(parsed);
          setElapsed(Math.round(performance.now() - t0Ref.current));
        } else {
          setError("Could not parse briefing response. Is the briefing service running?");
        }
        setStreaming(false);
        closeES();
        return;
      }

      // Accumulate chunk
      accRef.current += event.data;

      // Try to parse immediately — backend sends full JSON in one event
      // before the [DONE] sentinel, so we can render as soon as it arrives.
      const eagerParsed = parseBriefingText(accRef.current);
      if (eagerParsed) {
        setBriefing(eagerParsed);
        setElapsed(Math.round(performance.now() - t0Ref.current));
        setStreaming(false);
        closeES();
      }
    };

    es.onerror = () => {
      // Backend may send the full JSON then close without [DONE]
      const parsed = parseBriefingText(accRef.current);
      if (parsed) {
        setBriefing(parsed);
        setElapsed(Math.round(performance.now() - t0Ref.current));
      } else if (!accRef.current) {
        setError("Cannot connect to briefing service — is it running on port 8002?");
      } else {
        setError("Connection closed unexpectedly. Try again.");
      }
      setStreaming(false);
      closeES();
    };
  }, [closeES, closeQaES]);

  function handleQuickTopic(t: string) {
    setTopic(t);
    handleGenerate(t);
  }

  function handleSubmitTopic(e: React.FormEvent) {
    e.preventDefault();
    handleGenerate(topic);
  }

  const handleAsk = useCallback(() => {
    if (!question.trim() || !briefing || qaStreaming) return;
    const q = question.trim();
    setQuestion("");
    setQaStreaming(true);
    qaAccRef.current = "";

    // Add placeholder entry that we'll update as tokens arrive
    setChatHistory((prev) => [...prev, { question: q, answer: "", streaming: true }]);

    const es = askBriefing(briefing.topic ?? topic, q);
    qaEsRef.current = es;

    es.onmessage = (event: MessageEvent<string>) => {
      if (event.data === "[DONE]") {
        setChatHistory((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = { question: q, answer: qaAccRef.current, streaming: false };
          return updated;
        });
        setQaStreaming(false);
        closeQaES();
        return;
      }
      qaAccRef.current += event.data;
      setChatHistory((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = { question: q, answer: qaAccRef.current, streaming: true };
        return updated;
      });
    };

    es.onerror = () => {
      // Finalise with whatever we have
      setChatHistory((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        const answer = qaAccRef.current || "Unable to get answer — is the briefing service running?";
        updated[updated.length - 1] = { ...last, answer, streaming: false };
        return updated;
      });
      setQaStreaming(false);
      closeQaES();
    };
  }, [question, briefing, topic, qaStreaming, closeQaES]);

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      <PageHeader
        title="News Navigator"
        subtitle="AI briefings sourced from ET articles"
        backHref="/"
      />

      {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}

      <div className="flex gap-4 h-[calc(100vh-180px)] min-h-[500px]">

        {/* ── Left panel (40%) ── */}
        <div className="w-[38%] flex-shrink-0 flex flex-col gap-4">

          {/* Topic search */}
          <div className="rounded-2xl border border-white/10 bg-gray-800/50 p-4 space-y-3">
            <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">
              Search a topic
            </p>

            <form onSubmit={handleSubmitTopic} className="space-y-2">
              <div className="relative">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-gray-600" />
                <input
                  type="text"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                  placeholder="e.g. RBI repo rate, SEBI regulations, Budget 2026"
                  className="w-full rounded-xl border border-white/10 bg-gray-700/50 pl-9 pr-3 py-2.5 text-sm text-gray-200 placeholder-gray-600 focus:border-[#FF6B35]/50 focus:outline-none focus:ring-1 focus:ring-[#FF6B35]/30"
                />
              </div>
              <button
                type="submit"
                disabled={!topic.trim() || streaming}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#FF6B35] py-2.5 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {streaming ? <LoadingSpinner size="sm" /> : null}
                {streaming ? "Generating…" : "Generate Briefing"}
              </button>
            </form>

            {/* Quick topic pills */}
            <div className="flex flex-wrap gap-1.5">
              {QUICK_TOPICS.map((t) => (
                <button
                  key={t}
                  onClick={() => handleQuickTopic(t)}
                  disabled={streaming}
                  className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-gray-400 hover:text-white hover:border-white/20 transition-colors disabled:opacity-40"
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          {/* Q&A chat — only after briefing exists */}
          {briefing && (
            <div className="flex-1 flex flex-col rounded-2xl border border-white/10 bg-gray-800/50 overflow-hidden min-h-0">
              <div className="border-b border-white/10 px-4 py-3 flex items-center gap-2">
                <MessageCircle className="h-3.5 w-3.5 text-gray-500" />
                <p className="text-xs font-semibold uppercase tracking-widest text-gray-500">
                  Ask a follow-up
                </p>
              </div>

              {/* Chat history */}
              <div
                ref={chatScrollRef}
                className="flex-1 overflow-y-auto p-4 space-y-3 min-h-0"
              >
                {chatHistory.length === 0 && (
                  <p className="text-xs text-gray-600 text-center pt-4">
                    Ask anything about this briefing topic
                  </p>
                )}
                {chatHistory.map((entry, i) => (
                  <div key={i} className="space-y-2">
                    {/* Question bubble — right aligned */}
                    <div className="flex justify-end">
                      <div className="rounded-2xl rounded-tr-sm bg-[#FF6B35] px-3.5 py-2 text-sm text-white max-w-[85%]">
                        {entry.question}
                      </div>
                    </div>
                    {/* Answer bubble — left aligned */}
                    <div className="flex justify-start">
                      <div className="rounded-2xl rounded-tl-sm border border-white/10 bg-gray-700/60 px-3.5 py-2 text-sm text-gray-200 max-w-[90%] leading-relaxed">
                        {entry.answer || (
                          <span className="flex items-center gap-2 text-gray-500">
                            <LoadingSpinner size="sm" />
                            <span>Thinking…</span>
                          </span>
                        )}
                        {entry.streaming && entry.answer && (
                          <span className="inline-block ml-1 h-3.5 w-0.5 bg-gray-400 animate-pulse" />
                        )}
                      </div>
                    </div>
                  </div>
                ))}
              </div>

              {/* Q&A input */}
              <div className="border-t border-white/10 p-3">
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleAsk()}
                    placeholder="Ask about this topic…"
                    disabled={qaStreaming}
                    className="flex-1 min-w-0 rounded-xl border border-white/10 bg-gray-700/50 px-3 py-2 text-sm text-gray-200 placeholder-gray-600 focus:border-[#FF6B35]/50 focus:outline-none focus:ring-1 focus:ring-[#FF6B35]/30 disabled:opacity-40"
                  />
                  <button
                    onClick={handleAsk}
                    disabled={!question.trim() || qaStreaming}
                    className="flex-shrink-0 rounded-xl bg-[#FF6B35] p-2 text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <Send className="h-4 w-4" />
                  </button>
                </div>
                <p className="text-[10px] text-gray-600 mt-2 text-center">
                  Answers are based strictly on ET articles only
                </p>
              </div>
            </div>
          )}
        </div>

        {/* ── Right panel (60%) ── */}
        <div className="flex-1 min-w-0 rounded-2xl border border-white/10 bg-gray-800/50 overflow-hidden flex flex-col">
          <div className="flex-1 overflow-y-auto p-6">
            {/* Empty state */}
            {!briefing && !streaming && (
              <EmptyState onQuickTopic={handleQuickTopic} />
            )}

            {/* Generating skeleton */}
            {streaming && (
              <div className="space-y-4">
                <div className="flex items-center gap-2 text-sm text-gray-400">
                  <LoadingSpinner size="sm" />
                  <span className="animate-pulse">Generating briefing…</span>
                </div>
                <BriefingSkeleton />
              </div>
            )}

            {/* Briefing display */}
            {briefing && !streaming && (
              <BriefingDisplay data={briefing} elapsed={elapsed} />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
