"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const LANGUAGES = [
  { code: "en", label: "English Edition" },
  { code: "hi", label: "हिंदी" },
  { code: "ta", label: "தமிழ்" },
  { code: "te", label: "తెలుగు" },
  { code: "bn", label: "বাংলা" },
];

const NAV_LINKS = [
  { href: "/",      label: "News Feed" },
  { href: "/arc",   label: "Story Arc" },
  { href: "/agent", label: "Agent" },
  { href: "/video", label: "Video" },
];

export function TopNav() {
  const pathname = usePathname();
  const [lang, setLang] = useState("en");

  useEffect(() => {
    const stored = localStorage.getItem("et_lang_preference");
    if (stored) setLang(stored);
  }, []);

  const handleLangChange = (code: string) => {
    setLang(code);
    localStorage.setItem("et_lang_preference", code);
    window.dispatchEvent(new CustomEvent("et_lang_change", { detail: code }));
  };

  return (
    <header className="sticky top-0 z-50 bg-gray-900 border-b border-gray-700 shadow-lg">
      <div className="max-w-[1400px] mx-auto px-4 h-14 flex items-center gap-6">
        {/* Logo */}
        <Link href="/" className="flex items-center gap-2 shrink-0">
          <div className="w-8 h-8 bg-[#FF6B35] rounded flex items-center justify-center font-bold text-white text-sm select-none">
            ET
          </div>
          <span className="font-bold text-white text-lg hidden sm:block">ET News</span>
        </Link>

        {/* Nav tabs */}
        <nav className="flex items-center gap-1 flex-1">
          {NAV_LINKS.map((link) => {
            const isActive =
              link.href === "/"
                ? pathname === "/"
                : pathname.startsWith(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-[#FF6B35] text-white"
                    : "text-gray-400 hover:text-white hover:bg-gray-800"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>

        {/* Language selector */}
        <div className="relative shrink-0">
          <select
            value={lang}
            onChange={(e) => handleLangChange(e.target.value)}
            className="bg-gray-800 text-gray-200 text-sm border border-gray-600 rounded-lg px-3 py-1.5 pr-8 appearance-none cursor-pointer hover:border-gray-400 focus:outline-none focus:border-[#FF6B35]"
          >
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label}
              </option>
            ))}
          </select>
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-[10px]">
            ▼
          </span>
        </div>
      </div>
    </header>
  );
}
