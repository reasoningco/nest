import { randomUUID } from "node:crypto";
import type { DB } from "./db.ts";

export type RunStatus =
  | "queued"
  | "running"
  | "pr_open"
  | "merged"
  | "conflict"
  | "failed";

export const TERMINAL_STATUSES: RunStatus[] = ["merged", "conflict", "failed"];

export interface Run {
  id: string;
  jira_issue_key: string;
  jira_delivery_id: string;
  cursor_agent_id: string | null;
  pr_url: string | null;
  pr_node_id: string | null;
  status: RunStatus;
  prompt: string;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface InsertRunInput {
  jira_issue_key: string;
  jira_delivery_id: string;
  prompt: string;
}

export interface AdoptRunInput {
  jira_delivery_id: string;
  cursor_agent_id: string;
  pr_url: string;
  pr_node_id: string;
  prompt: string;
}

export interface RunsRepo {
  insert(input: InsertRunInput): Run | null;
  adopt(input: AdoptRunInput): Run | null;
  get(id: string): Run | null;
  getByDeliveryId(id: string): Run | null;
  listNonTerminal(): Run[];
  update(id: string, patch: Partial<Run>): void;
}

export function createRunsRepo(db: DB): RunsRepo {
  const insertStmt = db.prepare(`
    INSERT INTO runs (
      id, jira_issue_key, jira_delivery_id, cursor_agent_id, pr_url, pr_node_id,
      status, prompt, error, created_at, updated_at
    ) VALUES (
      @id, @jira_issue_key, @jira_delivery_id, NULL, NULL, NULL,
      'queued', @prompt, NULL, @now, @now
    )
  `);
  const getById = db.prepare("SELECT * FROM runs WHERE id = ?");
  const getByDelivery = db.prepare(
    "SELECT * FROM runs WHERE jira_delivery_id = ?",
  );
  const listOpen = db.prepare(
    `SELECT * FROM runs WHERE status NOT IN ('merged','conflict','failed') ORDER BY created_at ASC`,
  );

  return {
    insert(input) {
      const row = {
        id: randomUUID(),
        jira_issue_key: input.jira_issue_key,
        jira_delivery_id: input.jira_delivery_id,
        prompt: input.prompt,
        now: new Date().toISOString(),
      };
      try {
        insertStmt.run(row);
      } catch (e: any) {
        if (
          typeof e?.code === "string" &&
          e.code === "SQLITE_CONSTRAINT_UNIQUE"
        ) {
          return null;
        }
        throw e;
      }
      return getById.get(row.id) as Run;
    },

    adopt(input) {
      const id = randomUUID();
      const now = new Date().toISOString();
      try {
        db.prepare(
          `INSERT INTO runs (
             id, jira_issue_key, jira_delivery_id, cursor_agent_id, pr_url, pr_node_id,
             status, prompt, error, created_at, updated_at
           ) VALUES (
             @id, 'KANBAN', @did, @cid, @url, @nid, 'pr_open', @prompt, NULL, @now, @now
           )`,
        ).run({
          id,
          did: input.jira_delivery_id,
          cid: input.cursor_agent_id,
          url: input.pr_url,
          nid: input.pr_node_id,
          prompt: input.prompt,
          now,
        });
      } catch (e: any) {
        if (e?.code === "SQLITE_CONSTRAINT_UNIQUE") return null;
        throw e;
      }
      return getById.get(id) as Run;
    },
    get(id) {
      return (getById.get(id) as Run | undefined) ?? null;
    },
    getByDeliveryId(id) {
      return (getByDelivery.get(id) as Run | undefined) ?? null;
    },
    listNonTerminal() {
      return listOpen.all() as Run[];
    },
    update(id, patch) {
      const allowed: (keyof Run)[] = [
        "cursor_agent_id",
        "pr_url",
        "pr_node_id",
        "status",
        "error",
      ];
      const sets: string[] = [];
      const params: Record<string, unknown> = { id };
      for (const k of allowed) {
        if (k in patch) {
          sets.push(`${k} = @${k}`);
          params[k] = (patch as any)[k];
        }
      }
      if (sets.length === 0) return;
      sets.push("updated_at = @updated_at");
      params.updated_at = new Date().toISOString();
      db.prepare(`UPDATE runs SET ${sets.join(", ")} WHERE id = @id`).run(
        params,
      );
    },
  };
}
