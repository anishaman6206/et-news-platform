import Link from "next/link";
import { ChevronLeft } from "lucide-react";

interface Props {
  title: string;
  subtitle?: string;
  backHref?: string;
}

export function PageHeader({ title, subtitle, backHref }: Props) {
  return (
    <header className="flex items-center gap-4 mb-8">
      {/* ET logo mark */}
      <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded bg-[#FF6B35]">
        <span className="text-sm font-black text-white tracking-tight">ET</span>
      </div>

      <div className="flex-1 min-w-0">
        <h1 className="text-xl font-bold text-white leading-tight truncate">{title}</h1>
        {subtitle && (
          <p className="text-sm text-gray-400 truncate">{subtitle}</p>
        )}
      </div>

      {backHref && (
        <Link
          href={backHref}
          className="flex items-center gap-1 rounded px-3 py-1.5 text-sm text-gray-400 hover:text-white hover:bg-white/10 transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
          Back
        </Link>
      )}
    </header>
  );
}
