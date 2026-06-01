// Chaos no longer ships a UI — middleware redirects browser hits to NEST.
// This page exists only because Next.js requires a root route under app/.
export const dynamic = "force-static";

export default function Page() {
  return (
    <main
      style={{
        fontFamily: "system-ui, sans-serif",
        padding: "3rem",
        maxWidth: "40rem",
        color: "#444",
      }}
    >
      <h1 style={{ fontSize: "1.25rem", color: "#111" }}>chaos</h1>
      <p>API-only backend. The dashboard moved to nest.reasoning.company.</p>
    </main>
  );
}
