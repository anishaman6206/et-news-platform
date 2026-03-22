import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "@/components/ui/Sidebar";

export const metadata: Metadata = {
  title: "ET AI News Platform",
  description: "AI-Native News Experience — ET AI Hackathon 2026",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className="flex min-h-screen bg-gray-900 text-white antialiased">
        <Sidebar />
        <main className="flex-1 min-w-0 overflow-y-auto p-6 md:p-8">
          {children}
        </main>
      </body>
    </html>
  );
}
