import { app } from "@azure/functions";
import { getServicesPool } from "../shared/servicesPool.js";
import { reconcileArtifacts } from "../shared/reconciliation.js";

app.timer("arionReconcileArtifacts", {
  schedule: "0 15 * * * *",
  runOnStartup: false,
  handler: async (timer, context) => {
    context.log("[arionReconcileArtifacts] starting", { scheduleStatus: timer.scheduleStatus });
    const pool = await getServicesPool();
    await reconcileArtifacts(pool, (message) => context.log(`[arionReconcileArtifacts] ${message}`));
  },
});
