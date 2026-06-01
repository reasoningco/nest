// Thin wrapper around @cursor/sdk. Isolates SDK shape so installed-version
// differences only ripple through this file.

export interface CursorAgentSummary {
  id: string;
  name?: string;
  repos: string[];
}

export interface CursorClient {
  createAgent(input: {
    issueKey: string;
    summary: string;
    prompt: string;
    repoUrl: string;
    model?: string;
  }): Promise<{ id: string }>;
  getAgent(id: string): Promise<{ id: string; prUrl?: string }>;
  listAgents(): Promise<CursorAgentSummary[]>;
  agentUrl(id: string): string;
}

interface CursorClientOpts {
  apiKey: string;
}

export function createCursorClient(opts: CursorClientOpts): CursorClient {
  return {
    async createAgent(input) {
      const { Agent } = (await import("@cursor/sdk")) as any;
      const agent = await Agent.create({
        apiKey: opts.apiKey,
        name: `${input.issueKey}: ${input.summary.slice(0, 80)}`,
        ...(input.model ? { model: { id: input.model } } : {}),
        cloud: {
          repos: [{ url: input.repoUrl }],
          autoCreatePR: true,
        },
      });
      if (typeof agent.send === "function") {
        await agent.send(input.prompt);
      }
      const id = agent.agentId ?? agent.id ?? agent.options?.agentId;
      if (!id) {
        throw new Error("cursor SDK: created agent has no agentId");
      }
      return { id };
    },

    async getAgent(id) {
      const sdk = (await import("@cursor/sdk")) as any;
      const Agent = sdk.Agent;

      let runs: any[] = [];
      try {
        const r = await Agent.listRuns(id, { apiKey: opts.apiKey });
        runs = r?.items ?? r?.data ?? (Array.isArray(r) ? r : []);
      } catch {
        /* ignore */
      }

      const findPr = (obj: any): string | undefined => {
        if (!obj || typeof obj !== "object") return undefined;
        return (
          obj.pullRequestUrl ??
          obj.prUrl ??
          obj.pullRequest?.url ??
          obj.pr?.url ??
          obj.target?.pullRequestUrl ??
          obj.target?.prUrl ??
          obj.source?.pullRequestUrl ??
          undefined
        );
      };

      for (const run of runs) {
        const u = findPr(run);
        if (u) return { id, prUrl: u };
      }

      try {
        const meta = await Agent.get(id, { apiKey: opts.apiKey });
        const u = findPr(meta);
        if (u) return { id, prUrl: u };
      } catch {
        /* ignore */
      }

      return { id };
    },

    async listAgents() {
      const sdk = (await import("@cursor/sdk")) as any;
      const Agent = sdk.Agent;
      try {
        const list = await Agent.list({
          apiKey: opts.apiKey,
          runtime: "cloud",
        });
        const items: any[] =
          list?.items ?? list?.data ?? (Array.isArray(list) ? list : []);
        return items.map((a) => ({
          id: a.agentId ?? a.id,
          name: a.name,
          repos: Array.isArray(a.repos) ? a.repos : [],
        }));
      } catch {
        return [];
      }
    },

    agentUrl(id) {
      return `https://cursor.com/agents/${id}`;
    },
  };
}
