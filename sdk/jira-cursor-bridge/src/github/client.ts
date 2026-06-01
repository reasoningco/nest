import { Octokit } from "@octokit/rest";
import { graphql } from "@octokit/graphql";
import { retry } from "@octokit/plugin-retry";
import { throttling } from "@octokit/plugin-throttling";
import { parseRepoUrl } from "../config.ts";

export interface PullState {
  url: string;
  nodeId: string;
  merged: boolean;
  draft: boolean;
  mergeable: boolean | null;
  mergeableState: string | null;
}

export interface GitHubClient {
  parsePrUrl(url: string): { owner: string; repo: string; number: number };
  getPull(url: string): Promise<PullState>;
  enableAutoMerge(nodeId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  markReadyForReview(nodeId: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  squashMergeNow(prUrl: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  findOpenPrByBranchSuffix(
    repoUrl: string,
    suffix: string,
  ): Promise<{ url: string; nodeId: string } | null>;
  listCursorOpenPrs(
    repoUrl: string,
  ): Promise<
    Array<{ url: string; nodeId: string; branch: string; title: string }>
  >;
}

const OctokitWithPlugins = Octokit.plugin(retry, throttling);

interface GitHubClientOpts {
  token: string;
  onRateLimit?: (msg: string) => void;
}

export function createGitHubClient(opts: GitHubClientOpts): GitHubClient {
  const octokit = new OctokitWithPlugins({
    auth: opts.token,
    throttle: {
      onRateLimit: (retryAfter, _req, _o, retryCount) => {
        opts.onRateLimit?.(`primary rate limit, retryAfter=${retryAfter}s`);
        return retryCount < 3;
      },
      onSecondaryRateLimit: (retryAfter, _req) => {
        opts.onRateLimit?.(`secondary rate limit, retryAfter=${retryAfter}s`);
        return true;
      },
    },
  });

  const gql = graphql.defaults({
    headers: { authorization: `token ${opts.token}` },
  });

  return {
    parsePrUrl(url) {
      const m = url.match(
        /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/,
      );
      if (!m) throw new Error(`Cannot parse GitHub PR url: ${url}`);
      return { owner: m[1]!, repo: m[2]!, number: Number(m[3]!) };
    },

    async getPull(url) {
      const { owner, repo, number } = this.parsePrUrl(url);
      const { data } = await octokit.pulls.get({
        owner,
        repo,
        pull_number: number,
      });
      return {
        url: data.html_url,
        nodeId: data.node_id,
        merged: !!data.merged,
        draft: !!data.draft,
        mergeable: data.mergeable ?? null,
        mergeableState: (data.mergeable_state as string) ?? null,
      };
    },

    async findOpenPrByBranchSuffix(repoUrl, suffix) {
      const { owner, repo } = parseRepoUrl(repoUrl);
      const { data } = await octokit.pulls.list({
        owner,
        repo,
        state: "open",
        per_page: 50,
        sort: "created",
        direction: "desc",
      });
      const match = data.find((p) => p.head?.ref?.endsWith(suffix));
      if (!match) return null;
      return { url: match.html_url, nodeId: match.node_id };
    },

    async enableAutoMerge(nodeId) {
      try {
        await gql<{ enablePullRequestAutoMerge: unknown }>(
          `mutation($id: ID!) {
            enablePullRequestAutoMerge(input: {
              pullRequestId: $id,
              mergeMethod: SQUASH
            }) { clientMutationId }
          }`,
          { id: nodeId },
        );
        return { ok: true } as const;
      } catch (e: any) {
        return {
          ok: false,
          reason: e?.message ?? "unknown auto-merge error",
        } as const;
      }
    },

    async listCursorOpenPrs(repoUrl) {
      const { owner, repo } = parseRepoUrl(repoUrl);
      try {
        const { data } = await octokit.pulls.list({
          owner,
          repo,
          state: "open",
          per_page: 50,
        });
        return data
          .filter((p) => p.head?.ref?.startsWith("cursor/"))
          .map((p) => ({
            url: p.html_url,
            nodeId: p.node_id,
            branch: p.head.ref,
            title: p.title ?? "",
          }));
      } catch {
        return [];
      }
    },

    async markReadyForReview(nodeId) {
      try {
        await gql<{ markPullRequestReadyForReview: unknown }>(
          `mutation($id: ID!) {
            markPullRequestReadyForReview(input: { pullRequestId: $id }) {
              clientMutationId
            }
          }`,
          { id: nodeId },
        );
        return { ok: true } as const;
      } catch (e: any) {
        return {
          ok: false,
          reason: e?.message ?? "unknown markReady error",
        } as const;
      }
    },

    async squashMergeNow(prUrl) {
      const { owner, repo, number } = this.parsePrUrl(prUrl);
      try {
        await octokit.pulls.merge({
          owner,
          repo,
          pull_number: number,
          merge_method: "squash",
        });
        return { ok: true } as const;
      } catch (e: any) {
        return {
          ok: false,
          reason: e?.message ?? "unknown merge error",
        } as const;
      }
    },
  };
}

export { parseRepoUrl };
