import { Version3Client } from "jira.js";
import type { PersonConfig, Sources } from "./config";
import { jiraCreds } from "./config";

export interface RawJiraActivity {
  kind: "jira";
  projectKey: string;
  issueKey: string;
  summary: string;
  url: string;
  accountId: string | null;
  type: "issue_created" | "issue_in_progress" | "issue_done";
  occurredAt: Date;
  labels: string[];
  status: string;
}

let cachedClient: { key: string; client: Version3Client } | null = null;

function buildClient(cfg: Sources) {
  const creds = jiraCreds(cfg);
  if (!creds) return null;
  const key = `${creds.baseUrl}|${creds.email}`;
  if (cachedClient && cachedClient.key === key) return cachedClient.client;
  const client = new Version3Client({
    host: creds.baseUrl,
    authentication: {
      basic: { email: creds.email, apiToken: creds.token },
    },
  });
  cachedClient = { key, client };
  return client;
}

function bucketStatus(category: string | undefined): RawJiraActivity["type"] | null {
  const c = (category ?? "").toLowerCase();
  if (c === "done") return "issue_done";
  // We deliberately ignore "indeterminate" / "in progress" — only closed
  // tickets surface on the dashboard. Commits associated with an open
  // ticket still appear via their own Activity rows.
  return null;
}

let authProbedOk: boolean | null = null;

async function probeJiraAuth(cfg: Sources): Promise<boolean> {
  if (authProbedOk !== null) return authProbedOk;
  const client = buildClient(cfg);
  if (!client) {
    authProbedOk = false;
    return false;
  }
  try {
    await client.myself.getCurrentUser();
    authProbedOk = true;
  } catch (err: any) {
    const status = err?.response?.status ?? err?.status;
    console.error(
      `[jira] /myself returned ${status ?? "?"} — the configured JIRA_API_TOKEN ` +
        `does not grant Jira content access. If the token starts with "ATCTT" it is ` +
        `an admin-scoped org API key; create a user API token at ` +
        `https://id.atlassian.com/manage-profile/security/api-tokens (format ATATT...) ` +
        `and set JIRA_API_TOKEN to that.`,
    );
    authProbedOk = false;
  }
  return authProbedOk;
}

interface SearchJqlResponse {
  issues?: Array<{
    key: string;
    fields?: {
      summary?: string;
      labels?: string[];
      status?: { name?: string };
      reporter?: { accountId?: string };
      assignee?: { accountId?: string };
      created?: string;
      updated?: string;
    };
  }>;
  nextPageToken?: string;
}

interface ChangelogResponse {
  values?: Array<{
    created: string;
    author?: { accountId?: string };
    items?: Array<{ field?: string; toString?: string }>;
  }>;
  nextPageToken?: string;
  isLast?: boolean;
}

async function jiraFetch<T>(
  cfg: Sources,
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const creds = jiraCreds(cfg);
  if (!creds) throw new Error("Jira credentials missing");
  const url = creds.baseUrl.replace(/\/$/, "") + path;
  const auth = Buffer.from(`${creds.email}:${creds.token}`).toString("base64");
  const resp = await fetch(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Basic ${auth}`,
      Accept: "application/json",
    },
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`${resp.status} ${path}: ${body.slice(0, 200)}`);
  }
  return (await resp.json()) as T;
}

export async function fetchJiraActivitySince(
  cfg: Sources,
  projectKey: string,
  since: Date,
): Promise<RawJiraActivity[]> {
  if (!(await probeJiraAuth(cfg))) {
    throw new Error(
      "Jira auth failed — /myself returned 401. Token likely lacks Jira content scopes; see logs for fix.",
    );
  }

  const days = Math.max(
    1,
    Math.ceil((Date.now() - since.getTime()) / 86_400_000),
  );
  const jql = `project = "${projectKey}" AND updated >= "-${days}d" ORDER BY updated DESC`;

  const out: RawJiraActivity[] = [];
  const baseUrl = (cfg.jira?.base_url ?? "").replace(/\/$/, "");
  let nextPageToken: string | undefined;
  let pagesSeen = 0;

  do {
    // New endpoint: POST /rest/api/3/search/jql — replaces deprecated /search.
    // Cursor-paginated (nextPageToken); no more startAt. `expand: changelog`
    // isn't supported here, so we fetch changelogs per-issue below.
    const body: Record<string, unknown> = {
      jql,
      fields: [
        "summary",
        "status",
        "labels",
        "assignee",
        "reporter",
        "created",
        "updated",
      ],
      maxResults: 100,
    };
    if (nextPageToken) body.nextPageToken = nextPageToken;

    const page = await jiraFetch<SearchJqlResponse>(
      cfg,
      "/rest/api/3/search/jql",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    );

    const issues = page.issues ?? [];
    for (const issue of issues) {
      const f = issue.fields ?? {};
      const summary = f.summary ?? issue.key;
      const labels = f.labels ?? [];
      const statusName = f.status?.name ?? "";
      const url = `${baseUrl}/browse/${issue.key}`;
      const reporterId = f.reporter?.accountId ?? null;
      const assigneeId = f.assignee?.accountId ?? null;
      const createdAt = new Date(f.created ?? Date.now());

      // issue_created suppressed — only closed tickets should appear.
      void createdAt;

      // Per-issue changelog. Skip if issue was created in-window and is still
      // in a bucket we don't emit for (saves a call).
      try {
        const changelog = await jiraFetch<ChangelogResponse>(
          cfg,
          `/rest/api/3/issue/${encodeURIComponent(issue.key)}/changelog?maxResults=100`,
        );
        for (const h of changelog.values ?? []) {
          const when = new Date(h.created);
          if (when < since) continue;
          const actor = h.author?.accountId ?? null;
          for (const item of h.items ?? []) {
            if (item.field !== "status") continue;
            const toCategory = item.toString && bucketLookup(item.toString);
            const typ = bucketStatus(toCategory);
            if (!typ) continue;
            out.push({
              kind: "jira",
              projectKey,
              issueKey: issue.key,
              summary,
              url,
              accountId: actor ?? assigneeId ?? reporterId,
              type: typ,
              occurredAt: when,
              labels,
              status: item.toString ?? statusName,
            });
          }
        }
      } catch (err) {
        console.warn(
          `[jira] changelog fetch failed for ${issue.key}: ${String(err).slice(0, 160)}`,
        );
      }
    }

    nextPageToken = page.nextPageToken;
    pagesSeen += 1;
  } while (nextPageToken && pagesSeen < 10);

  return out;
}

// Very loose status-name → category bucket. Jira's category info is more
// reliable but the changelog only has the display name, so we match on common
// English-language workflow names.
function bucketLookup(statusName: string): string {
  const s = statusName.toLowerCase();
  if (["done", "closed", "resolved", "completed", "shipped"].some((x) => s.includes(x))) {
    return "done";
  }
  if (["in progress", "in-progress", "in review", "review", "doing", "started"].some((x) => s.includes(x))) {
    return "indeterminate";
  }
  return "new";
}

export function resolvePersonByJiraAccountId(
  people: PersonConfig[],
  accountId: string | null,
): PersonConfig | null {
  if (!accountId) return null;
  return people.find((p) => p.jira_account_id === accountId) ?? null;
}

export async function fetchJiraIssueSummary(
  cfg: Sources,
  issueKey: string,
): Promise<string | null> {
  const client = buildClient(cfg);
  if (!client) return null;
  try {
    const issue = await client.issues.getIssue({
      issueIdOrKey: issueKey,
      fields: ["summary"],
    });
    return (issue.fields as any)?.summary ?? null;
  } catch {
    return null;
  }
}
