import { z } from "zod";

const changelogItem = z.object({
  field: z.string().optional(),
  fromString: z.string().nullable().optional(),
  toString: z.string().nullable().optional(),
});

const issueFields = z
  .object({
    summary: z.string().optional().default(""),
    description: z.unknown().optional(),
    labels: z.array(z.string()).optional().default([]),
  })
  .partial();

export const jiraWebhookSchema = z.object({
  webhookEvent: z.string().optional(),
  issue: z
    .object({
      key: z.string(),
      fields: issueFields.optional().default({}),
    })
    .optional(),
  changelog: z
    .object({
      items: z.array(changelogItem).optional().default([]),
    })
    .optional(),
});

export type JiraWebhook = z.infer<typeof jiraWebhookSchema>;

export interface TriggerEvent {
  issueKey: string;
  summary: string;
  description: string;
  labels: string[];
}

function splitLabels(s: string | null | undefined): string[] {
  if (!s) return [];
  return s
    .split(/\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function detectTrigger(
  payload: unknown,
  triggerLabel: string,
): TriggerEvent | null {
  const parsed = jiraWebhookSchema.safeParse(payload);
  if (!parsed.success) return null;
  const data = parsed.data;
  if (data.webhookEvent !== "jira:issue_updated") return null;
  if (!data.issue) return null;

  const items = data.changelog?.items ?? [];
  const labelChange = items.find((i) => i.field === "labels");
  if (!labelChange) return null;

  const before = new Set(splitLabels(labelChange.fromString));
  const after = new Set(splitLabels(labelChange.toString));
  const added: string[] = [];
  for (const l of after) if (!before.has(l)) added.push(l);

  if (!added.includes(triggerLabel)) return null;

  return {
    issueKey: data.issue.key,
    summary: data.issue.fields?.summary ?? "",
    description: stringifyDescription(data.issue.fields?.description),
    labels: data.issue.fields?.labels ?? [],
  };
}

function stringifyDescription(d: unknown): string {
  if (typeof d === "string") return d;
  if (d == null) return "";
  return adfToText(d);
}

function adfToText(node: any): string {
  if (!node) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(adfToText).join("");
  let out = "";
  if (node.type === "text" && typeof node.text === "string") out += node.text;
  if (Array.isArray(node.content)) {
    out += node.content.map(adfToText).join("");
    if (node.type === "paragraph" || node.type === "heading") out += "\n";
  }
  return out;
}
