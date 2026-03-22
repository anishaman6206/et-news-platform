"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  Globe,
  LayoutList,
  BookOpen,
  GitBranch,
  Video,
  Home,
  Menu,
  X,
} from "lucide-react";
import { ServiceStatus } from "./ServiceStatus";
import type { ServiceName } from "@/lib/api";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/",           label: "Home",       icon: Home,       service: null             },
  { href: "/vernacular", label: "Vernacular",  icon: Globe,      service: "vernacular"     },
  { href: "/feed",       label: "Feed",        icon: LayoutList, service: "feed"           },
  { href: "/briefing",   label: "Briefing",    icon: BookOpen,   service: "briefing"       },
  { href: "/arc",        label: "Story Arc",   icon: GitBranch,  service: "arc"            },
  { href: "/video",      label: "Video",       icon: Video,      service: "video"          },
] as const;

export function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const inner = (
    <nav className="flex flex-col h-full">
      {/* Logo */}
      <div className="flex items-center gap-3 px-4 py-5 border-b border-white/10">
        <div className="flex h-9 w-9 items-center justify-center rounded bg-[#FF6B35] flex-shrink-0">
          <span className="text-sm font-black text-white tracking-tight">ET</span>
        </div>
        <div className="min-w-0">
          <p className="text-sm font-bold text-white leading-tight truncate">ET News</p>
          <p className="text-[10px] text-gray-500 truncate">AI Hackathon 2026</p>
        </div>
      </div>

      {/* Links */}
      <ul className="flex-1 px-2 py-3 space-y-0.5 overflow-y-auto">
        {NAV.map(({ href, label, icon: Icon, service }) => {
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <li key={href}>
              <Link
                href={href}
                onClick={() => setOpen(false)}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                  active
                    ? "bg-[#FF6B35]/20 text-[#FF6B35] font-medium"
                    : "text-gray-400 hover:text-white hover:bg-white/5",
                )}
              >
                <Icon className="h-4 w-4 flex-shrink-0" />
                <span className="flex-1 truncate">{label}</span>
                {service && (
                  <ServiceStatus service={service as ServiceName} showLabel={false} />
                )}
              </Link>
            </li>
          );
        })}
      </ul>

    </nav>
  );

  return (
    <>
      {/* Mobile hamburger */}
      <button
        className="fixed top-4 left-4 z-50 md:hidden rounded-lg bg-gray-900 p-2 text-gray-400 hover:text-white border border-white/10"
        onClick={() => setOpen(!open)}
        aria-label="Toggle menu"
      >
        {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
      </button>

      {/* Mobile overlay */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/60 md:hidden"
          onClick={() => setOpen(false)}
        />
      )}

      {/* Mobile drawer */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 w-56 bg-gray-950 border-r border-white/10 transition-transform duration-200 md:hidden",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        {inner}
      </aside>

      {/* Desktop sidebar */}
      <aside className="hidden md:flex flex-col w-56 flex-shrink-0 bg-gray-950 border-r border-white/10 h-screen sticky top-0">
        {inner}
      </aside>
    </>
  );
}
