import OpenAI from "openai";

let client: OpenAI | null = null;

function getClient(): OpenAI | null {
  if (client) return client;
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  // OpenRouter exposes an OpenAI-compatible API surface, so we reuse the
  // openai SDK with a different baseURL.
  client = new OpenAI({
    apiKey: key,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": process.env.OPENROUTER_REFERRER || "https://chaos.local",
      "X-Title": "Chaos",
    },
  });
  return client;
}

/**
 * Summarize a set of commit messages on a branch into a single imperative-mood
 * feature description. Routed through OpenRouter; default model is
 * google/gemini-2.0-flash-lite-001 — fast and a fraction of a cent per call.
 */
export async function summarizeBranch(
  commitMessages: string[],
): Promise<string | null> {
  const c = getClient();
  if (!c) return null;
  const model =
    process.env.OPENROUTER_MODEL || "google/gemini-2.0-flash-lite-001";

  const messages = commitMessages
    .slice(0, 40)
    .map((m) => "- " + m.trim().split("\n")[0])
    .join("\n");

  const prompt = `You are naming a software feature based on its commits.
Return ONE single-line description in imperative mood, sentence case, under 70 characters.
No trailing period. No quotes. No preamble. Just the title.

Commits:
${messages}

Title:`;

  try {
    const resp = await c.chat.completions.create({
      model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
      max_tokens: 40,
    });
    const text = resp.choices[0]?.message?.content?.trim() ?? "";
    if (!text) return null;
    // Strip stray quotes / trailing punctuation.
    return text.replace(/^["'`]+|["'`.]+$/g, "").slice(0, 120);
  } catch (err) {
    console.error("[summarize] OpenRouter call failed:", err);
    return null;
  }
}
