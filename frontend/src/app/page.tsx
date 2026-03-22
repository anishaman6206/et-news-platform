import Link from "next/link";
import {
  Globe,
  LayoutList,
  BookOpen,
  GitBranch,
  Video,
} from "lucide-react";
import { ServiceStatus } from "@/components/ui/ServiceStatus";
import type { ServiceName } from "@/lib/api";

const FEATURES = [
  {
    href:        "/vernacular",
    label:       "Vernacular Engine",
    icon:        Globe,
    service:     "vernacular" as ServiceName,
    description: "Translate any ET article into Hindi, Tamil, Telugu or Bengali — financial terms correctly localised automatically.",
    accent:      "from-orange-500/20 to-orange-900/10 border-orange-700/30",
    iconColor:   "text-orange-400",
  },
  {
    href:        "/feed",
    label:       "Personalised Feed",
    icon:        LayoutList,
    service:     "feed" as ServiceName,
    description: "Personalised news feed that learns from what you read, share and skip — updates your interest profile in real time.",
    accent:      "from-blue-500/20 to-blue-900/10 border-blue-700/30",
    iconColor:   "text-blue-400",
  },
  {
    href:        "/briefing",
    label:       "News Navigator",
    icon:        BookOpen,
    service:     "briefing" as ServiceName,
    description: "Ask any financial question and get a structured briefing sourced strictly from ET articles, with citations.",
    accent:      "from-purple-500/20 to-purple-900/10 border-purple-700/30",
    iconColor:   "text-purple-400",
  },
  {
    href:        "/arc",
    label:       "Story Arc Tracker",
    icon:        GitBranch,
    service:     "arc" as ServiceName,
    description: "Track any ongoing business story — entity graph, sentiment trend over time, and AI predictions on what comes next.",
    accent:      "from-green-500/20 to-green-900/10 border-green-700/30",
    iconColor:   "text-green-400",
  },
  {
    href:        "/video",
    label:       "AI Video Studio",
    icon:        Video,
    service:     "video" as ServiceName,
    description: "Turn any ET article into a broadcast-ready MP4 with AI narration in under 2 minutes.",
    accent:      "from-red-500/20 to-red-900/10 border-red-700/30",
    iconColor:   "text-red-400",
  },
];

const STATS = [
  { value: "5",  label: "Active Services"        },
  { value: "45", label: "Tests Passing"          },
  { value: "5",  label: "Languages Supported"    },
  { value: "0",  label: "External Dependencies"  },
];

const TECH_BADGES = [
  "GPT-4o", "OpenAI TTS", "Embeddings", "Qdrant", "Neo4j",
  "Redis", "PostgreSQL", "spaCy", "FFmpeg", "Next.js 14",
];

export default function Home() {
  return (
    <div className="max-w-5xl mx-auto space-y-10">
      {/* Hero */}
      <section className="pt-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-[#FF6B35]">
            <span className="text-lg font-black text-white tracking-tight">ET</span>
          </div>
          <div>
            <h1 className="text-3xl font-black text-white leading-tight">
              ET AI News Platform
            </h1>
            <p className="text-sm text-gray-500">AI-Native News Experience — ET AI Hackathon 2026</p>
          </div>
        </div>
        <p className="text-gray-400 max-w-2xl text-sm leading-relaxed">
          Five independently deployable microservices that bring personalisation, multilingual
          access, intelligent briefings, story tracking, and AI-generated video to Economic Times
          readers. All powered by GPT-4o.
        </p>
      </section>

      {/* Stats bar */}
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {STATS.map(({ value, label }) => (
          <div
            key={label}
            className="flex flex-col items-center justify-center rounded-xl border border-white/10 bg-gray-800/50 py-5 px-3 text-center"
          >
            <span className="text-3xl font-black text-[#FF6B35] leading-none mb-1">
              {value}
            </span>
            <span className="text-xs text-white font-medium">{label}</span>
          </div>
        ))}
      </section>

      {/* Feature cards */}
      <section>
        <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-600 mb-4">
          Features
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ href, label, icon: Icon, service, description, accent, iconColor }) => (
            <div
              key={href}
              className={`relative flex flex-col rounded-xl border bg-gradient-to-br p-5 ${accent}`}
            >
              <div className="flex items-start justify-between mb-3">
                <Icon className={`h-6 w-6 ${iconColor}`} />
                <ServiceStatus service={service} showLabel={false} />
              </div>

              <h3 className="font-semibold text-white mb-1.5">{label}</h3>
              <p className="text-xs text-gray-400 leading-relaxed flex-1 mb-4">
                {description}
              </p>

              <Link
                href={href}
                className="inline-flex items-center gap-1 text-xs font-medium text-white/70 hover:text-white transition-colors"
              >
                Try it →
              </Link>
            </div>
          ))}
        </div>
      </section>

      {/* Tech stack */}
      <section className="pb-4">
        <div className="flex flex-wrap gap-2">
          {TECH_BADGES.map((badge) => (
            <span
              key={badge}
              className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-gray-400"
            >
              {badge}
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}
