import cron from "node-cron";
import { runSync } from "@/lib/ingest";
import { watchConfig } from "@/lib/config";

let started = false;

export function startBackgroundJobs() {
  if (started) return;
  started = true;

  // 1) Kick off an initial sync at boot (non-blocking).
  setTimeout(() => {
    runSync()
      .then((r) =>
        console.log(
          `[chaos] initial sync — ${r.activitiesWritten} activities, ${r.featuresUpserted} features, ${r.errors.length} errors`,
        ),
      )
      .catch((err) => console.error("[chaos] initial sync failed:", err));
  }, 2000);

  // 2) Incremental sync every 4 hours. Manual refresh paths remain available
  // from the UI when fresh data is needed immediately.
  cron.schedule("0 */4 * * *", async () => {
    try {
      const r = await runSync();
      const errSuffix = r.errors.length > 0 ? `, ${r.errors.length} errors: ${r.errors[0]}` : "";
      console.log(
        `[chaos] cron sync — ${r.activitiesWritten} activities, ${r.featuresUpserted} features${errSuffix}`,
      );
    } catch (err) {
      console.error("[chaos] cron sync failed:", err);
    }
  });

  // 3) Dev-only: hot reload of sources.yaml.
  watchConfig(() => console.log("[chaos] config/sources.yaml reloaded"));
}
