import { app } from "@azure/functions";
import { getServicesPool } from "../shared/servicesPool.js";
import { markStaleHealth } from "../shared/reconciliation.js";

app.timer("arionMarkStaleHealth", {
  schedule: "0 45 * * * *",
  runOnStartup: false,
  handler: async (timer, context) => {
    context.log("[arionMarkStaleHealth] starting", { scheduleStatus: timer.scheduleStatus });
    const pool = await getServicesPool();
    await markStaleHealth(pool, (message) => context.log(`[arionMarkStaleHealth] ${message}`));
  },
});
