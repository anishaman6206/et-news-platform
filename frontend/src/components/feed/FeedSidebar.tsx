"use client";

import { useState, useEffect, useCallback } from "react";
import { RefreshCw } from "lucide-react";
import { onboardUser } from "@/lib/api";
import { cn } from "@/lib/utils";

const ROLES = ["Investor", "Founder", "Student", "Analyst"] as const;
type Role = (typeof ROLES)[number];

const SECTORS = ["Banking", "Markets", "Tech", "Startups", "Policy", "Budget"] as const;
type Sector = (typeof SECTORS)[number];

interface UserProfile {
  userId: string;
  role: Role | null;
  sectors: Sector[];
}

const STORAGE_KEY = "et_feed_profile_v2";

function loadProfile(): UserProfile | null {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as UserProfile | null;
  } catch {
    return null;
  }
}

function getOrCreateUserId(): string {
  let id = localStorage.getItem("et_feed_user_id");
  if (!id) {
    id = `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem("et_feed_user_id", id);
  }
  return id;
}

interface FeedSidebarProps {
  onRefresh: () => void;
}

export function FeedSidebar({ onRefresh }: FeedSidebarProps) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setProfile(loadProfile());
  }, []);

  const saveProfile = useCallback(async (updated: UserProfile) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(updated));
    setProfile(updated);
    if (!updated.role) return;
    setSaving(true);
    try {
      await onboardUser(updated.userId, updated.role, updated.sectors, []);
    } catch {
      // silent fail — preference is stored locally regardless
    } finally {
      setSaving(false);
    }
  }, []);

  const handleRoleChange = (role: Role) => {
    const userId = getOrCreateUserId();
    void saveProfile({ userId, role, sectors: profile?.sectors ?? [] });
  };

  const handleSectorToggle = (sector: Sector) => {
    const userId = getOrCreateUserId();
    const current = profile?.sectors ?? [];
    const sectors = current.includes(sector)
      ? current.filter((s) => s !== sector)
      : ([...current, sector] as Sector[]);
    void saveProfile({ userId, role: profile?.role ?? null, sectors });
  };

  const hasProfile = !!(profile?.role || (profile?.sectors ?? []).length > 0);

  return (
    <div className="rounded-2xl border border-white/10 bg-gray-800/50 p-4 space-y-4 sticky top-20">
      <p className="text-[10px] font-semibold uppercase tracking-widest text-gray-500">
        Build Your Feed
      </p>

      {!hasProfile && (
        <p className="text-xs text-[#FF6B35]">Personalise your feed →</p>
      )}

      {/* Role selector */}
      <div className="space-y-2">
        <p className="text-xs text-gray-500">I am a…</p>
        <div className="flex flex-wrap gap-2">
          {ROLES.map((role) => (
            <button
              key={role}
              onClick={() => handleRoleChange(role)}
              className={cn(
                "rounded-full px-3 py-1.5 text-xs font-medium transition-all border",
                profile?.role === role
                  ? "bg-[#FF6B35] border-[#FF6B35] text-white"
                  : "border-white/10 bg-white/5 text-gray-400 hover:border-white/20 hover:text-white",
              )}
            >
              {role}
            </button>
          ))}
        </div>
      </div>

      {/* Sector checkboxes */}
      <div className="space-y-2">
        <p className="text-xs text-gray-500">Sectors</p>
        <div className="space-y-1.5">
          {SECTORS.map((sector) => (
            <label
              key={sector}
              className="flex items-center gap-2 cursor-pointer group"
            >
              <input
                type="checkbox"
                checked={(profile?.sectors ?? []).includes(sector)}
                onChange={() => handleSectorToggle(sector)}
                className="h-3.5 w-3.5 rounded border-gray-600 bg-gray-700 accent-[#FF6B35]"
              />
              <span className="text-xs text-gray-400 group-hover:text-white transition-colors">
                {sector}
              </span>
            </label>
          ))}
        </div>
      </div>

      {/* Refresh button */}
      <button
        onClick={onRefresh}
        disabled={saving}
        className="w-full flex items-center justify-center gap-2 rounded-xl bg-[#FF6B35] py-2.5 text-xs font-semibold text-white hover:bg-[#e55a25] active:scale-95 transition-all disabled:opacity-60"
      >
        <RefreshCw className={`h-3.5 w-3.5 ${saving ? "animate-spin" : ""}`} />
        Refresh Feed
      </button>
    </div>
  );
}
