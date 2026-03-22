"use client";

import { useState, useRef } from "react";
import { Globe, Copy, Check, Zap, RefreshCw } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { ErrorBanner } from "@/components/ui/ErrorBanner";
import { LoadingSpinner } from "@/components/ui/LoadingSpinner";
import { translateArticle, type TranslateResponse } from "@/lib/api";
import { cn } from "@/lib/utils";

// ── Language config ────────────────────────────────────────────────────────────

const LANGUAGES = [
  { code: "hi", label: "Hindi",   native: "हिंदी"    },
  { code: "ta", label: "Tamil",   native: "தமிழ்"   },
  { code: "te", label: "Telugu",  native: "తెలుగు"  },
  { code: "bn", label: "Bengali", native: "বাংলা"   },
] as const;

type LangCode = (typeof LANGUAGES)[number]["code"];

// ── Sample articles ────────────────────────────────────────────────────────────

const SAMPLES: Record<string, string> = {
  "RBI Rate Decision":
    "The Reserve Bank of India kept the repo rate unchanged at 6.5% in its March 2026 meeting. " +
    "Governor Shaktikanta Das cited easing inflation and stable GDP growth as key factors. " +
    "The equity markets reacted positively with Nifty gaining 200 points on the news.",

  "SEBI Regulations":
    "SEBI has tightened mutual fund regulations requiring all equity funds to disclose portfolio " +
    "overlap with benchmark indices. The move affects over 500 mutual fund schemes across 40 " +
    "asset management companies. SEBI chairperson said the new norms improve transparency for retail investors.",

  "Budget 2026":
    "Finance Minister Nirmala Sitharaman presented the Union Budget 2026 with a fiscal deficit " +
    "target of 4.5% of GDP. The budget allocated increased funds for infrastructure with a capital " +
    "expenditure of Rs 15 lakh crore. Income tax slabs were revised benefiting the middle class " +
    "with no tax up to Rs 12 lakh annual income.",
};

// ── Hindi glossary terms to detect in output ──────────────────────────────────
// Representative subset of common financial terms used by the backend translator.

const HINDI_GLOSSARY_TERMS = [
  "रेपो दर", "सेबी", "म्यूचुअल फंड", "शेयर बाजार", "निफ्टी", "सेंसेक्स",
  "ब्याज दर", "मुद्रास्फीति", "जीडीपी", "राजकोषीय घाटा", "पूंजीगत व्यय",
  "आयकर", "वित्त मंत्री", "भारतीय रिजर्व बैंक", "गवर्नर", "बजट",
  "बेंचमार्क", "पोर्टफोलियो", "इक्विटी", "खुदरा निवेशक",
];

// ── Skeleton loader ────────────────────────────────────────────────────────────

function SkeletonLines() {
  return (
    <div className="space-y-3 animate-pulse">
      {[100, 90, 95, 85, 75].map((w, i) => (
        <div
          key={i}
          className="h-4 rounded bg-gray-700"
          style={{ width: `${w}%` }}
        />
      ))}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function VernacularPage() {
  const [lang, setLang]         = useState<LangCode>("hi");
  const [input, setInput]       = useState("");
  const [result, setResult]     = useState<TranslateResponse | null>(null);
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const [elapsed, setElapsed]   = useState<number | null>(null);
  const [copied, setCopied]     = useState(false);
  const textareaRef             = useRef<HTMLTextAreaElement>(null);

  const activeLang = LANGUAGES.find((l) => l.code === lang)!;

  // Detected glossary terms present in the translated output
  const detectedTerms =
    result
      ? HINDI_GLOSSARY_TERMS.filter((term) => result.translated.includes(term))
      : [];

  const lengthRatio =
    result && input.length > 0
      ? result.translated.length / input.length
      : null;

  const ratioColor =
    lengthRatio !== null
      ? lengthRatio >= 0.7 && lengthRatio <= 1.5
        ? "text-green-400"
        : "text-red-400"
      : "text-gray-400";

  async function handleTranslate() {
    if (!input.trim()) return;
    setError(null);
    setResult(null);
    setLoading(true);
    const t0 = performance.now();
    try {
      const data = await translateArticle(
        `web_${Date.now()}`,
        input.trim(),
        lang,
      );
      setElapsed(Math.round(performance.now() - t0));
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Translation failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleCopy() {
    if (!result) return;
    await navigator.clipboard.writeText(result.translated);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleSample(text: string) {
    setInput(text);
    setResult(null);
    setError(null);
    textareaRef.current?.focus();
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <PageHeader
        title="Vernacular Engine"
        subtitle="Translate ET articles into Indian regional languages"
        backHref="/"
      />

      {error && (
        <ErrorBanner message={error} onDismiss={() => setError(null)} />
      )}

      {/* Language selector */}
      <div className="flex flex-wrap gap-2">
        {LANGUAGES.map((l) => (
          <button
            key={l.code}
            onClick={() => { setLang(l.code); setResult(null); }}
            className={cn(
              "rounded-lg border px-4 py-2 text-sm font-medium transition-colors",
              lang === l.code
                ? "border-[#FF6B35] bg-[#FF6B35]/20 text-[#FF6B35]"
                : "border-white/10 bg-white/5 text-gray-400 hover:text-white hover:border-white/20",
            )}
          >
            {l.label}{" "}
            <span className="text-xs opacity-70">({l.native})</span>
          </button>
        ))}
      </div>

      {/* Two-column panels */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* ── Left: Input ── */}
        <div className="flex flex-col gap-3">
          <label className="text-xs font-semibold uppercase tracking-widest text-gray-500">
            English Article
          </label>

          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              "Paste an ET article here...\n\nExample: The Reserve Bank of India kept the repo rate unchanged at 6.5% in its March 2026 meeting. Governor Shaktikanta Das cited easing inflation and stable GDP growth as key factors."
            }
            className="min-h-[220px] w-full resize-y rounded-xl border border-white/10 bg-gray-800/60 p-4 text-sm text-gray-200 placeholder-gray-600 focus:border-[#FF6B35]/50 focus:outline-none focus:ring-1 focus:ring-[#FF6B35]/30 leading-relaxed"
          />

          <div className="flex items-center justify-between text-xs text-gray-600">
            <span>{input.length} characters</span>
          </div>

          <button
            onClick={handleTranslate}
            disabled={loading || !input.trim()}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-[#FF6B35] py-3 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {loading ? (
              <LoadingSpinner size="sm" />
            ) : (
              <Globe className="h-4 w-4" />
            )}
            {loading ? "Translating…" : `Translate to ${activeLang.label}`}
          </button>

          {/* Sample article quick-fills */}
          <div className="flex flex-wrap gap-2 pt-1">
            <span className="text-xs text-gray-600 self-center">Try:</span>
            {Object.keys(SAMPLES).map((name) => (
              <button
                key={name}
                onClick={() => handleSample(SAMPLES[name])}
                className="rounded-md border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-gray-400 hover:text-white hover:border-white/20 transition-colors"
              >
                {name}
              </button>
            ))}
          </div>
        </div>

        {/* ── Right: Output ── */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <label className="text-xs font-semibold uppercase tracking-widest text-gray-500">
              Translated Article
              <span className="ml-1 normal-case font-normal text-gray-600">
                — {activeLang.label} ({activeLang.native})
              </span>
            </label>

            {result && (
              <button
                onClick={handleCopy}
                className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-gray-400 hover:text-white hover:bg-white/5 transition-colors"
              >
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-green-400" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
                {copied ? "Copied!" : "Copy"}
              </button>
            )}
          </div>

          <div className="min-h-[220px] rounded-xl border border-white/10 bg-gray-800/60 p-4">
            {loading && <SkeletonLines />}

            {!loading && !result && (
              <p className="text-sm text-gray-600 leading-relaxed">
                Translation will appear here…
              </p>
            )}

            {!loading && result && (
              <p className="text-sm text-gray-200 leading-relaxed whitespace-pre-wrap">
                {result.translated}
              </p>
            )}
          </div>

          {/* Meta: cache badge + char count */}
          {result && (
            <div className="flex items-center justify-between text-xs text-gray-600">
              <span>
                {result.cached ? (
                  <span className="inline-flex items-center gap-1 text-green-400">
                    <Zap className="h-3 w-3" />
                    Cached response
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-blue-400">
                    <RefreshCw className="h-3 w-3" />
                    Fresh translation
                  </span>
                )}
              </span>
              <span>{result.translated.length} characters</span>
            </div>
          )}

          {/* Glossary terms */}
          {result && detectedTerms.length > 0 && (
            <div className="rounded-xl border border-white/10 bg-gray-800/40 p-3">
              <p className="text-xs font-semibold uppercase tracking-widest text-gray-500 mb-2">
                Glossary terms used
              </p>
              <div className="flex flex-wrap gap-1.5">
                {detectedTerms.map((term) => (
                  <span
                    key={term}
                    className="rounded-full border border-[#FF6B35]/30 bg-[#FF6B35]/10 px-2.5 py-0.5 text-xs text-[#FF6B35]"
                  >
                    {term}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Stats bar */}
      {(result || elapsed !== null) && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            {
              label: "Translation time",
              value: elapsed !== null ? `${elapsed} ms` : "—",
              color: "text-white",
            },
            {
              label: "Source length",
              value: input.length ? `${input.length} chars` : "—",
              color: "text-white",
            },
            {
              label: "Translated length",
              value: result ? `${result.translated.length} chars` : "—",
              color: "text-white",
            },
            {
              label: "Length ratio",
              value: lengthRatio !== null ? lengthRatio.toFixed(2) : "—",
              color: ratioColor,
            },
          ].map(({ label, value, color }) => (
            <div
              key={label}
              className="rounded-xl border border-white/10 bg-gray-800/50 px-4 py-3 text-center"
            >
              <p className={`text-lg font-bold ${color}`}>{value}</p>
              <p className="text-xs text-gray-500 mt-0.5">{label}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
