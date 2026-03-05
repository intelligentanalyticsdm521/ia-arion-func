import { app } from "@azure/functions";
import { getServicesPool } from "../shared/servicesPool.js";
import { markStaleHealth, reconcileArtifacts } from "../shared/reconciliation.js";

app.http("arionRunReconcile", {
  methods: ["POST"],
  authLevel: "function",
  route: "admin/reconcile",
  handler: async (request, context) => {
    const pool = await getServicesPool();
    const artifacts = await reconcileArtifacts(pool, (message) => context.log(`[arionRunReconcile] ${message}`));
    const stale = await markStaleHealth(pool, (message) => context.log(`[arionRunReconcile] ${message}`));

    return {
      status: 200,
      jsonBody: {
        ok: true,
        artifacts,
        stale,
        triggeredAtUtc: new Date().toISOString(),
      },
    };
  },
});
