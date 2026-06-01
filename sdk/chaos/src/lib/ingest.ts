import { prisma } from "./db";
import { loadSources, type PersonConfig } from "./config";
import {
  fetchCommitsSince,
  fetchPullRequestsSince,
  resolvePersonByGithubLogin,
  type RawCommitActivity,
  type RawPrActivity,
} from "./github";
import {
  fetchJiraActivitySince,
  fetchJiraIssueSummary,
  resolvePersonByJiraAccountId,
  type RawJiraActivity,
} from "./jira";
import { assignFeatureKey, featureSource } from "./grouping";
import { summarizeBranch } from "./summarize";
import { clusterAndMergeFeatures } from "./cluster";
import { enrichCommitStats } from "./enrich-commits";
import { enrichBlameStats } from "./enrich-blame";
import { ALL_TIME_ORIGIN } from "./time";

export interface SyncResult {
  ok: boolean;
  activitiesWritten: number;
  featuresUpserted: number;
  unmappedCount: number;
  errors: string[];
  startedAt: Date;
  finishedAt: Date;
}

export async function runSync(): Promise<SyncResult> {
  const startedAt = new Date();
  const errors: string[] = [];
  let activitiesWritten = 0;
  let featuresUpserted = 0;

  let cfg;
  try {
    cfg = loadSources();
  } catch (err) {
    return {
      ok: false,
      activitiesWritten: 0,
      featuresUpserted: 0,
      unmappedCount: 0,
      errors: [String(err)],
      startedAt,
      finishedAt: new Date(),
    };
  }

  await upsertPeople(cfg.people);

  // GitHub
  if (cfg.github) {
    const excludeLogins = new Set(
      (cfg.github.exclude_logins ?? []).map((l) => l.toLowerCase()),
    );
    for (const repo of cfg.github.repos) {
      const sourceId = `github:${repo.owner}/${repo.name}`;
      const since = await getSinceDate(sourceId);
      try {
        const [commits, prs] = await Promise.all([
          fetchCommitsSince(cfg, repo.owner, repo.name, since),
          fetchPullRequestsSince(cfg, repo.owner, repo.name, since),
        ]);
        const prByHead = new Map<string, RawPrActivity>();
        for (const pr of prs) prByHead.set(pr.headRef, pr);

        for (const c of commits) {
          if (c.authorLogin && excludeLogins.has(c.authorLogin.toLowerCase())) continue;
          activitiesWritten += await writeCommitActivity(cfg.people, c, prByHead);
        }
        for (const pr of prs) {
          if (pr.authorLogin && excludeLogins.has(pr.authorLogin.toLowerCase())) continue;
          activitiesWritten += await writePrActivities(cfg.people, pr);
        }
        await markSyncOk(sourceId);
      } catch (err) {
        const msg = `${sourceId}: ${String(err)}`;
        errors.push(msg);
        await markSyncError(sourceId, msg);
      }
    }
  }

  // Jira
  if (cfg.jira) {
    for (const project of cfg.jira.projects) {
      const sourceId = `jira:${project.key}`;
      const since = await getSinceDate(sourceId);
      try {
        const items = await fetchJiraActivitySince(cfg, project.key, since);
        for (const j of items) {
          activitiesWritten += await writeJiraActivity(cfg.people, j);
        }
        await markSyncOk(sourceId);
      } catch (err) {
        const msg = `${sourceId}: ${String(err)}`;
        errors.push(msg);
        await markSyncError(sourceId, msg);
      }
    }
  }

  featuresUpserted = await upsertFeatures(cfg);

  // LLM-driven semantic clustering: merges Jira tickets with their matching
  // commits/PRs when the commit didn't reference the ticket key.
  try {
    const c = await clusterAndMergeFeatures();
    if (c.mergesApplied > 0) {
      console.log(
        `[chaos] cluster — ${c.mergesApplied} merge(s), ${c.activitiesReassigned} activities reassigned across ${c.llmCalls} LLM call(s)`,
      );
      // Re-upsert features so titles reflect the consolidated state.
      featuresUpserted = await upsertFeatures(cfg);
    }
  } catch (err) {
    console.error("[chaos] cluster pass failed:", err);
  }

  // Enrich commits with additions/deletions so the UI can filter by size.
  try {
    const e = await enrichCommitStats();
    if (e.updated > 0) {
      console.log(
        `[chaos] enrich — ${e.updated}/${e.candidates} commits got LOC stats`,
      );
    }
  } catch (err) {
    console.error("[chaos] enrich pass failed:", err);
  }

  // Enrich commits with blame attribution for deleted lines.
  try {
    const b = await enrichBlameStats();
    if (b.updated > 0 || b.failed > 0) {
      const failedSuffix = b.failed > 0 ? `, ${b.failed} failed` : "";
      console.log(
        `[chaos] blame — ${b.updated}/${b.processed} commits got blame attribution${failedSuffix}`,
      );
    }
  } catch (err) {
    console.error("[chaos] blame pass failed:", err);
  }

  const unmappedCount = await prisma.unmappedContributor.count();

  return {
    ok: errors.length === 0,
    activitiesWritten,
    featuresUpserted,
    unmappedCount,
    errors,
    startedAt,
    finishedAt: new Date(),
  };
}

async function upsertPeople(people: PersonConfig[]) {
  for (const p of people) {
    // If both fields are configured and currently belong to two different
    // auto-created rows, merge the Jira row into the GitHub row first so the
    // subsequent upsert doesn't trip the unique constraint on jiraAccountId.
    if (p.github && p.jira_account_id) {
      const [byGh, byJira] = await Promise.all([
        prisma.person.findUnique({ where: { githubLogin: p.github } }),
        prisma.person.findUnique({ where: { jiraAccountId: p.jira_account_id } }),
      ]);
      if (byGh && byJira && byGh.id !== byJira.id) {
        await prisma.activity.updateMany({
          where: { personId: byJira.id },
          data: { personId: byGh.id },
        });
        await prisma.unmappedContributor
          .delete({ where: { jiraAccountId: p.jira_account_id } })
          .catch(() => {});
        await prisma.person.delete({ where: { id: byJira.id } });
      }
    }

    await prisma.person.upsert({
      where: p.github
        ? { githubLogin: p.github }
        : p.jira_account_id
        ? { jiraAccountId: p.jira_account_id }
        : { id: `__missing__${p.display_name}` },
      create: {
        displayName: p.display_name,
        githubLogin: p.github ?? null,
        jiraAccountId: p.jira_account_id ?? null,
        role: p.role ?? null,
      },
      update: {
        displayName: p.display_name,
        githubLogin: p.github ?? null,
        jiraAccountId: p.jira_account_id ?? null,
        role: p.role ?? null,
      },
    });
  }

  // Merge alias Persons into their primary, and clear the unmapped banner for
  // anyone now configured.
  for (const p of people) {
    if (!p.github) continue;
    const primary = await prisma.person.findUnique({
      where: { githubLogin: p.github },
    });
    if (!primary) continue;

    for (const alias of p.github_aliases ?? []) {
      if (alias === p.github) continue;
      const dupe = await prisma.person.findUnique({
        where: { githubLogin: alias },
      });
      if (!dupe || dupe.id === primary.id) continue;
      await prisma.activity.updateMany({
        where: { personId: dupe.id },
        data: { personId: primary.id },
      });
      await prisma.person.delete({ where: { id: dupe.id } });
    }

    // Any login now in config is no longer "unmapped".
    const logins = [p.github, ...(p.github_aliases ?? [])];
    for (const login of logins) {
      await prisma.unmappedContributor
        .delete({ where: { githubLogin: login } })
        .catch(() => {});
    }
    if (p.jira_account_id) {
      await prisma.unmappedContributor
        .delete({ where: { jiraAccountId: p.jira_account_id } })
        .catch(() => {});
    }
  }
}

async function getSinceDate(sourceId: string): Promise<Date> {
  const state = await prisma.syncState.findUnique({ where: { id: sourceId } });
  if (state) return state.lastSync;
  return new Date(ALL_TIME_ORIGIN);
}

async function markSyncOk(sourceId: string) {
  await prisma.syncState.upsert({
    where: { id: sourceId },
    create: { id: sourceId, lastSync: new Date(), lastError: null },
    update: { lastSync: new Date(), lastError: null },
  });
}

async function markSyncError(sourceId: string, message: string) {
  await prisma.syncState.upsert({
    where: { id: sourceId },
    create: { id: sourceId, lastSync: new Date(0), lastError: message },
    update: { lastError: message },
  });
}

async function writeCommitActivity(
  people: PersonConfig[],
  c: RawCommitActivity,
  prByHead: Map<string, RawPrActivity>,
): Promise<number> {
  let person = resolvePersonByGithubLogin(people, c.authorLogin);
  if (!person) {
    if (!c.authorLogin) return 0;
    // Auto-register: everyone who commits should appear in the dashboard.
    // Still record unmapped so the banner can prompt for a real display name.
    await recordUnmapped({
      githubLogin: c.authorLogin,
      sample: `commit ${c.sha.slice(0, 7)}: ${c.message.split("\n")[0]}`,
    });
    person = { display_name: c.authorLogin, github: c.authorLogin, github_aliases: [], external: true };
  }

  // PR association fallback: GitHub squash-merge commits often drop the
  // "#<num>" tag from their message, so first scan commit_message, then
  // (last resort) exact title match against any open/merged PR by the same
  // author. Without this, a squash merge appears as both an anon commit and
  // a PR — same title, two rollups.
  //
  // Title-match only kicks in for descriptive titles (length >= 20 AND
  // contains a space). Short generic titles like "sync" / "fix" / "WIP"
  // collide across many unrelated commits and would massively over-cluster.
  const firstLine = c.message.split("\n")[0];
  const titleMatchEligible = firstLine.length >= 20 && firstLine.includes(" ");
  const pr = c.associatedPrNumber
    ? null
    : ([...prByHead.values()].find((p) => p.headRef && c.message.includes(`#${p.number}`))
        ?? (titleMatchEligible
          ? [...prByHead.values()].find(
              (p) => p.title === firstLine && p.authorLogin === c.authorLogin,
            )
          : undefined)
        ?? null);

  const featureKey = assignFeatureKey({
    repoOwner: c.owner,
    repoName: c.repo,
    commitMessage: c.message,
    prTitle: c.associatedPrTitle ?? pr?.title ?? null,
    prNumber: c.associatedPrNumber ?? pr?.number ?? null,
    branchName: c.branch ?? pr?.headRef ?? null,
    defaultBranch: c.defaultBranch,
  });

  const dbPerson = await findPersonRecord(person);
  if (!dbPerson) return 0;

  const externalId = `github:${c.owner}/${c.repo}:${c.sha}`;
  await prisma.activity.upsert({
    where: { externalId },
    create: {
      personId: dbPerson.id,
      source: "github",
      type: "commit",
      externalId,
      title: c.message.split("\n")[0].slice(0, 500),
      url: c.url,
      occurredAt: c.occurredAt,
      metadata: JSON.stringify({
        sha: c.sha,
        owner: c.owner,
        repo: c.repo,
        branch: c.branch,
        prNumber: c.associatedPrNumber ?? pr?.number ?? null,
      }),
      featureKey,
    },
    update: { featureKey },
  });
  return 1;
}

async function writePrActivities(
  people: PersonConfig[],
  pr: RawPrActivity,
): Promise<number> {
  let person = resolvePersonByGithubLogin(people, pr.authorLogin);
  if (!person) {
    if (!pr.authorLogin) return 0;
    await recordUnmapped({
      githubLogin: pr.authorLogin,
      sample: `PR #${pr.number}: ${pr.title}`,
    });
    person = { display_name: pr.authorLogin, github: pr.authorLogin, github_aliases: [], external: true };
  }
  const dbPerson = await findPersonRecord(person);
  if (!dbPerson) return 0;

  const featureKey = assignFeatureKey({
    repoOwner: pr.owner,
    repoName: pr.repo,
    prTitle: pr.title,
    prNumber: pr.number,
    branchName: pr.headRef,
    defaultBranch: pr.baseRef,
  });

  const baseMeta = JSON.stringify({
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    headRef: pr.headRef,
    baseRef: pr.baseRef,
    labels: pr.labels,
  });

  let count = 0;

  // Opened event
  const openedKey = `github:${pr.owner}/${pr.repo}:pr:${pr.number}:opened`;
  await prisma.activity.upsert({
    where: { externalId: openedKey },
    create: {
      personId: dbPerson.id,
      source: "github",
      type: "pr_opened",
      externalId: openedKey,
      title: pr.title,
      url: pr.url,
      occurredAt: pr.createdAt,
      metadata: baseMeta,
      featureKey,
    },
    update: { featureKey },
  });
  count += 1;

  // Merged event
  if (pr.merged && pr.mergedAt) {
    const mergedKey = `github:${pr.owner}/${pr.repo}:pr:${pr.number}:merged`;
    await prisma.activity.upsert({
      where: { externalId: mergedKey },
      create: {
        personId: dbPerson.id,
        source: "github",
        type: "pr_merged",
        externalId: mergedKey,
        title: pr.title,
        url: pr.url,
        occurredAt: pr.mergedAt,
        metadata: baseMeta,
        featureKey,
      },
      update: { featureKey },
    });
    count += 1;
  }

  return count;
}

async function writeJiraActivity(
  people: PersonConfig[],
  j: RawJiraActivity,
): Promise<number> {
  let person = resolvePersonByJiraAccountId(people, j.accountId);
  if (!person) {
    if (!j.accountId) return 0;
    await recordUnmapped({
      jiraAccountId: j.accountId,
      sample: `${j.issueKey}: ${j.summary}`,
    });
    // accountId isn't readable, so fall back to "Jira <shortId>" until the
    // user edits sources.yaml.
    const short = j.accountId.split(":").pop()?.slice(0, 6) ?? j.accountId.slice(0, 6);
    person = { display_name: `Jira ${short}`, jira_account_id: j.accountId, github_aliases: [], external: true };
  }
  const dbPerson = await findPersonRecord(person);
  if (!dbPerson) return 0;

  const externalId = `jira:${j.issueKey}:${j.type}:${j.occurredAt.getTime()}`;
  await prisma.activity.upsert({
    where: { externalId },
    create: {
      personId: dbPerson.id,
      source: "jira",
      type: j.type,
      externalId,
      title: j.summary,
      url: j.url,
      occurredAt: j.occurredAt,
      metadata: JSON.stringify({
        projectKey: j.projectKey,
        labels: j.labels,
        status: j.status,
      }),
      featureKey: j.issueKey,
    },
    update: { featureKey: j.issueKey },
  });
  return 1;
}

async function findPersonRecord(p: PersonConfig) {
  if (p.github) {
    // Upsert so auto-registered commit authors get a Person row on the fly.
    // Existing rows (config-backed) keep their displayName — only create sets it.
    return prisma.person.upsert({
      where: { githubLogin: p.github },
      create: {
        displayName: p.display_name,
        githubLogin: p.github,
        jiraAccountId: p.jira_account_id ?? null,
        role: p.role ?? null,
      },
      update: {},
    });
  }
  if (p.jira_account_id) {
    return prisma.person.upsert({
      where: { jiraAccountId: p.jira_account_id },
      create: {
        displayName: p.display_name,
        githubLogin: p.github ?? null,
        jiraAccountId: p.jira_account_id,
        role: p.role ?? null,
      },
      update: {},
    });
  }
  return null;
}

async function recordUnmapped(input: {
  githubLogin?: string | null;
  jiraAccountId?: string | null;
  sample: string;
}) {
  const now = new Date();
  if (input.githubLogin) {
    await prisma.unmappedContributor.upsert({
      where: { githubLogin: input.githubLogin },
      create: {
        githubLogin: input.githubLogin,
        firstSeen: now,
        lastSeen: now,
        sampleActivity: input.sample,
      },
      update: { lastSeen: now, sampleActivity: input.sample },
    });
    return;
  }
  if (input.jiraAccountId) {
    await prisma.unmappedContributor.upsert({
      where: { jiraAccountId: input.jiraAccountId },
      create: {
        jiraAccountId: input.jiraAccountId,
        firstSeen: now,
        lastSeen: now,
        sampleActivity: input.sample,
      },
      update: { lastSeen: now, sampleActivity: input.sample },
    });
  }
}

async function upsertFeatures(cfg: ReturnType<typeof loadSources>): Promise<number> {
  // Pull all distinct featureKeys from activities.
  const rows = await prisma.activity.groupBy({
    by: ["featureKey"],
    where: { featureKey: { not: null } },
    _min: { occurredAt: true },
    _max: { occurredAt: true },
  });

  let count = 0;
  for (const row of rows) {
    const key = row.featureKey!;
    const src = featureSource(key);
    const existing = await prisma.feature.findUnique({ where: { featureKey: key } });
    let title: string | null = existing?.title ?? null;
    let summary: string | null = existing?.summary ?? null;

    if (src === "jira") {
      // Always refresh Jira summary (cheap lookup, handles renamed issues).
      const t = await fetchJiraIssueSummary(cfg, key);
      if (t) title = t;
    } else if (src === "pr") {
      // Find any activity on this PR for a good title.
      const act = await prisma.activity.findFirst({
        where: { featureKey: key, type: { in: ["pr_opened", "pr_merged"] } },
        orderBy: { occurredAt: "desc" },
      });
      if (act) title = act.title;
    } else if (src === "branch") {
      // Collect commits on this feature, call OpenAI if new commits arrived.
      const activities = await prisma.activity.findMany({
        where: { featureKey: key, type: "commit" },
        orderBy: { occurredAt: "asc" },
      });
      const needsSummary =
        !existing ||
        (existing.lastSeen && row._max.occurredAt &&
          existing.lastSeen < row._max.occurredAt);
      if (needsSummary && activities.length > 0) {
        const msgs = activities.map((a) => a.title);
        const generated = await summarizeBranch(msgs);
        if (generated) {
          title = generated;
          summary = generated;
        } else if (!title) {
          title = key.split(":").slice(2).join(":") || key;
        }
      }
      if (!title) title = key;
    }

    if (!title) title = key;

    await prisma.feature.upsert({
      where: { featureKey: key },
      create: {
        featureKey: key,
        title,
        summary,
        source: src,
        firstSeen: row._min.occurredAt ?? new Date(),
        lastSeen: row._max.occurredAt ?? new Date(),
      },
      update: {
        title,
        summary,
        source: src,
        lastSeen: row._max.occurredAt ?? new Date(),
      },
    });
    count += 1;
  }
  return count;
}
