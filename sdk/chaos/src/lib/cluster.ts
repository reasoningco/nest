/**
 * Post-ingestion clustering pass.
 *
 * featureKey assignment during ingest only groups commits + tickets when the
 * commit message explicitly references the Jira key. If the team commits
 * "fix: sidebar changes" without mentioning FRMS-38, the ticket and the
 * commit end up as separate rollups even though they describe the same work.
 *
 * This pass looks at every (person, project) bucket with ≥2 features in the
 * last 60 days and asks an LLM which ones clearly describe the same change.
 * Returned groups are merged by rewriting non-canonical Activity.featureKey
 * values to point at the canonical one (preference: Jira key > PR > branch).
 */
import OpenAI from "openai";
import { prisma } from "./db";
import { buildProjectMapping, deriveProject } from "./project";

const JIRA_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;

function getClient(): OpenAI | null {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) return null;
  return new OpenAI({
    apiKey: key,
    baseURL: "https://openrouter.ai/api/v1",
    defaultHeaders: {
      "HTTP-Referer": process.env.OPENROUTER_REFERRER || "https://chaos.local",
      "X-Title": "Chaos",
    },
  });
}

function priorityOf(featureKey: string | null): number {
  if (!featureKey) return 0;
  if (JIRA_KEY_RE.test(featureKey)) return 3;
  if (featureKey.startsWith("pr:")) return 2;
  if (featureKey.startsWith("branch:")) return 1;
  return 0;
}

interface Candidate {
  id: string; // opaque identifier used in the LLM prompt
  featureKey: string | null;
  activityIds: string[]; // activities whose featureKey will be rewritten if merged
  title: string;
  priority: number;
}

export interface ClusterResult {
  bucketsExamined: number;
  llmCalls: number;
  mergesApplied: number; // groups of 2+ features merged
  activitiesReassigned: number;
}

export async function clusterAndMergeFeatures(): Promise<ClusterResult> {
  const result: ClusterResult = {
    bucketsExamined: 0,
    llmCalls: 0,
    mergesApplied: 0,
    activitiesReassigned: 0,
  };

  const client = getClient();
  if (!client) return result;
  const model = process.env.OPENROUTER_MODEL || "google/gemini-2.0-flash-lite-001";

  const projectMap = buildProjectMapping();

  const since = new Date();
  since.setDate(since.getDate() - 60);
  const activities = await prisma.activity.findMany({
    where: { occurredAt: { gte: since } },
    orderBy: { occurredAt: "desc" },
  });
  if (activities.length === 0) return result;

  // Build (personId → projectLabel → candidateKey → Candidate). The project
  // label comes from the shared mapping so "form" commits and "FRMS" tickets
  // end up in the same bucket.
  const buckets = new Map<string, Map<string, Map<string, Candidate>>>();
  for (const a of activities) {
    const projectLabel = deriveProject(a.source, a.featureKey, a.metadata, projectMap);
    if (!projectLabel) continue;
    const bucketKey = a.featureKey ?? `__anon_${a.id}`;
    const candidateId = a.featureKey ?? `anon:${a.id}`;

    if (!buckets.has(a.personId)) buckets.set(a.personId, new Map());
    const perPerson = buckets.get(a.personId)!;
    if (!perPerson.has(projectLabel)) perPerson.set(projectLabel, new Map());
    const perProject = perPerson.get(projectLabel)!;

    const existing = perProject.get(bucketKey);
    if (existing) {
      existing.activityIds.push(a.id);
      continue;
    }
    perProject.set(bucketKey, {
      id: candidateId,
      featureKey: a.featureKey,
      activityIds: [a.id],
      title: a.title,
      priority: priorityOf(a.featureKey),
    });
  }

  const people = await prisma.person.findMany({
    select: { id: true, displayName: true },
  });
  const personName = new Map(people.map((p) => [p.id, p.displayName]));

  for (const [personId, projects] of buckets) {
    for (const [project, candidateMap] of projects) {
      const candidates = [...candidateMap.values()];
      if (candidates.length < 2) continue;
      result.bucketsExamined += 1;

      const person = personName.get(personId) ?? personId;
      const prompt = buildPrompt(person, project, candidates);

      let text: string;
      try {
        const resp = await client.chat.completions.create({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0,
          max_tokens: 600,
        });
        result.llmCalls += 1;
        text = resp.choices[0]?.message?.content ?? "";
      } catch (err) {
        console.error(`[cluster] LLM failed for ${project}/${person}:`, err);
        continue;
      }

      const groups = parseGroups(text);
      for (const g of groups) {
        const members = g
          .map((id) => candidates.find((c) => c.id === id))
          .filter((x): x is Candidate => Boolean(x));
        if (members.length < 2) continue;

        // Canonical = highest priority (Jira > PR > branch > standalone).
        const canonical = members.reduce((a, b) => (b.priority > a.priority ? b : a));
        if (!canonical.featureKey) continue; // nothing valid to merge into

        for (const m of members) {
          if (m.id === canonical.id) continue;
          // Rewrite activity featureKeys.
          const upd = await prisma.activity.updateMany({
            where: { id: { in: m.activityIds } },
            data: { featureKey: canonical.featureKey },
          });
          result.activitiesReassigned += upd.count;

          // Drop the orphan Feature row if the old key now has no activities.
          if (m.featureKey && m.featureKey !== canonical.featureKey) {
            const remaining = await prisma.activity.count({
              where: { featureKey: m.featureKey },
            });
            if (remaining === 0) {
              await prisma.feature.deleteMany({
                where: { featureKey: m.featureKey },
              });
            }
          }
        }
        result.mergesApplied += 1;
      }
    }
  }

  return result;
}

function buildPrompt(
  person: string,
  project: string,
  candidates: Candidate[],
): string {
  const list = candidates
    .map((c) => `- ${c.id}: ${c.title.slice(0, 160)}`)
    .join("\n");
  return `You are clustering software work items for one developer in one project.

Developer: ${person}
Project: ${project}

Some of these items describe the SAME underlying change (for example a Jira
ticket and the commit/PR that implemented it). Your job is to return groups
of items that clearly describe the same work.

Rules:
- Be conservative. If wording is ambiguous, do NOT merge.
- Only group items whose descriptions clearly refer to the same change.
- Each group must contain 2 or more items.
- Use the ids verbatim as they appear below.

Items:
${list}

Respond with ONLY JSON, no prose, in this exact shape:
{"groups":[{"ids":["<id1>","<id2>"],"reason":"short explanation"}]}

If no merges apply, return {"groups":[]}.`;
}

function parseGroups(text: string): string[][] {
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  try {
    const obj = JSON.parse(cleaned) as {
      groups?: { ids?: unknown }[];
    };
    const groups = obj.groups ?? [];
    const out: string[][] = [];
    for (const g of groups) {
      if (!Array.isArray(g.ids)) continue;
      const ids = g.ids.filter((x): x is string => typeof x === "string");
      if (ids.length >= 2) out.push(ids);
    }
    return out;
  } catch {
    return [];
  }
}
