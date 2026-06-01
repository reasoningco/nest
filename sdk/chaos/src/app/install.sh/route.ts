import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Public installer. Substitutes the runtime URL into the script so users
 * curl from chaos.reasoning.company and the script knows where to fetch
 * the helper from + which URL to set in shell rc.
 *
 *   curl -fsSL https://chaos.reasoning.company/install.sh | bash -s -- <token>
 */
export async function GET(req: NextRequest) {
  const raw = readFileSync(
    join(process.cwd(), "scripts", "install.sh"),
    "utf-8",
  );
  // Prefer the public URL the request actually came in on (handles proxies).
  const proto = req.headers.get("x-forwarded-proto") ?? "https";
  const host = req.headers.get("host") ?? "chaos.reasoning.company";
  const url = `${proto}://${host}`;
  const body = raw.replace(/__CHAOS_URL__/g, url);

  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/x-shellscript; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
