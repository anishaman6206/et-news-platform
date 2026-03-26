import type { Metadata } from "next";
import "./globals.css";
import { TopNav } from "@/components/ui/TopNav";

export const metadata: Metadata = {
  title: "ET News Platform",
  description: "AI-Native News Experience — ET AI Hackathon 2026",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="min-h-screen bg-gray-900 text-white antialiased">
        <TopNav />
        <main className="max-w-[1400px] mx-auto px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
