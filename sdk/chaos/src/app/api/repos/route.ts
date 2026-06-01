import fs from "node:fs/promises";
import YAML from "yaml";
import { NextResponse } from "next/server";
import { configPath, loadSources } from "@/lib/config";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Read/update the GitHub repo list configured in chaos's sources.yaml.
 *
 * Repo names aren't sensitive (they're the same names you'd see on GitHub),
 * so GET is left open — letting downstream tools like NEST mirror chaos's
 * curated repo list without sharing credentials. Mutations require the
 * bearer token enforced in middleware.
 *
 * Each entry includes its derived `jiraProjectKey` if a Jira project in
 * sources.yaml claims this repo via `repos:`. That makes it cheap for callers
 * to do "Jira ticket → repo" lookups without re-implementing the join.
 */
type RepoInput = {
  url?: string;
  owner?: string;
  name?: string;
  jiraProjectKey?: string | null;
};

const PROJECT_LOC_CACHE_KEY = "project-loc-series-v4";

export async function GET() {
  const cfg = loadSources();
  return NextResponse.json({ repos: configuredRepos(cfg) });
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as RepoInput;
  const parsed = parseRepoInput(body);
  if (!parsed) {
    return NextResponse.json(
      { error: "Provide a GitHub repo URL or owner/name." },
      { status: 400 },
    );
  }

  const file = configPath();
  const raw = await fs.readFile(file, "utf8");
  const doc = (YAML.parse(raw) ?? {}) as {
    github?: {
      token_env?: string;
      repos?: { owner?: string; name?: string }[];
    };
    jira?: {
      projects?: {
        key?: string;
        repos?: string | string[];
      }[];
    };
  };
  doc.github ??= { token_env: "GITHUB_TOKEN", repos: [] };
  doc.github.token_env ??= "GITHUB_TOKEN";
  doc.github.repos ??= [];

  const exists = doc.github.repos.some(
    (repo) =>
      repo.owner?.toLowerCase() === parsed.owner.toLowerCase() &&
      repo.name?.toLowerCase() === parsed.name.toLowerCase(),
  );

  if (!exists) {
    doc.github.repos.push({ owner: parsed.owner, name: parsed.name });
  }

  const jiraProjectKey = normalizedJiraKey(body.jiraProjectKey);
  if (jiraProjectKey && doc.jira?.projects) {
    const project = doc.jira.projects.find(
      (item) => item.key?.toUpperCase() === jiraProjectKey,
    );
    if (project) {
      const repos = Array.isArray(project.repos)
        ? project.repos
        : project.repos
          ? [project.repos]
          : [];
      if (!repos.some((name) => name.toLowerCase() === parsed.name.toLowerCase())) {
        repos.push(parsed.name);
      }
      project.repos = repos;
    }
  }

  await fs.writeFile(file, YAML.stringify(doc), "utf8");
  await prisma.cache
    .delete({ where: { key: PROJECT_LOC_CACHE_KEY } })
    .catch(() => {});

  const cfg = loadSources();
  return NextResponse.json({
    repo: {
      owner: parsed.owner,
      name: parsed.name,
      url: `https://github.com/${parsed.owner}/${parsed.name}`,
      jiraProjectKey,
      existed: exists,
    },
    repos: configuredRepos(cfg),
  });
}

function configuredRepos(cfg: ReturnType<typeof loadSources>) {
  const repos = cfg.github?.repos ?? [];

  // Reverse-index: github repo name → jira project key (case-insensitive).
  const repoToProject = new Map<string, string>();
  for (const project of cfg.jira?.projects ?? []) {
    for (const repoName of project.repos ?? []) {
      repoToProject.set(repoName.toLowerCase(), project.key);
    }
  }

  return repos.map((r) => ({
    owner: r.owner,
    name: r.name,
    url: `https://github.com/${r.owner}/${r.name}`,
    jiraProjectKey: repoToProject.get(r.name.toLowerCase()) ?? null,
  }));
}

function parseRepoInput(input: RepoInput) {
  const fromUrl = input.url ? parseGitHubUrl(input.url) : null;
  const owner = fromUrl?.owner ?? input.owner?.trim();
  const name = fromUrl?.name ?? input.name?.trim();
  if (!owner || !name) return null;
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(name)) {
    return null;
  }
  return { owner, name };
}

function parseGitHubUrl(url: string) {
  const trimmed = url.trim();
  const match = trimmed.match(
    /^(?:https?:\/\/github\.com\/|git@github\.com:)([^/\s:]+)\/([^/\s#?]+?)(?:\.git)?(?:[/?#].*)?$/,
  );
  if (!match) return null;
  return { owner: match[1], name: match[2] };
}

function normalizedJiraKey(value: string | null | undefined) {
  const key = value?.trim().toUpperCase();
  return key || null;
}
