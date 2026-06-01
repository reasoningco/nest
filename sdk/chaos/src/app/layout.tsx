import type { Metadata } from "next";
import "./globals.css";
import { startBackgroundJobs } from "@/server/cron";

// Side-effect: fire up cron + config watcher once per server process.
if (process.env.NEXT_PHASE !== "phase-production-build") {
  startBackgroundJobs();
}

export const metadata: Metadata = {
  title: "Chaos",
  description: "Team activity — what shipped, by person and by day.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
