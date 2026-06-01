import { NextRequest, NextResponse } from "next/server";

// chaos is now an API-only backend behind nest.reasoning.company.
// Auth model:
//   - /api/{claude,codex}-event use bearer-token auth (CHAOS_TELEMETRY_TOKEN)
//     enforced inside the route handler — machine-to-machine ingest from
//     developer laptops.
//   - /api/{claude,codex}-telemetry + /install.sh return public helper
//     scripts and the installer (token is supplied at install time).
//   - All other /api/* require the same bearer token at the middleware
//     layer — NEST proxies pass it through; nothing else should call
//     these endpoints directly.
//   - Anything that isn't an API path or open path is a stale UI URL;
//     redirect to NEST.
const OPEN_PATHS = new Set([
  "/",
  "/api/claude-event",
  "/api/claude-telemetry",
  "/api/codex-event",
  "/api/codex-telemetry",
  "/install.sh",
]);

const NEST_URL =
  process.env.CHAOS_UI_REDIRECT_URL ?? "https://nest.reasoning.company";

export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname === "/api/repos" && req.method === "GET") {
    return NextResponse.next();
  }
  if (OPEN_PATHS.has(pathname)) return NextResponse.next();

  const apiToken = process.env.CHAOS_TELEMETRY_TOKEN;
  if (apiToken && pathname.startsWith("/api/")) {
    const auth = req.headers.get("authorization") ?? "";
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m && m[1]?.trim() === apiToken) return NextResponse.next();
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // Anything else is a stale chaos UI URL — point browsers at NEST.
  return NextResponse.redirect(NEST_URL);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
