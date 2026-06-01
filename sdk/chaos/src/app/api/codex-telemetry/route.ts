import { readFileSync } from "node:fs";
import { join } from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-static";
export const revalidate = 60;

/**
 * Public read of the codex-telemetry helper. No secrets — same script that
 * lives in the repo, fetched at install time.
 */
export async function GET() {
  const body = readFileSync(
    join(process.cwd(), "scripts", "codex-telemetry"),
    "utf-8",
  );
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "public, max-age=60",
    },
  });
}
