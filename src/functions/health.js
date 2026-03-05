import { app } from "@azure/functions";
import { getServicesPool } from "../shared/servicesPool.js";

app.http("arionHealth", {
  methods: ["GET"],
  authLevel: "function",
  route: "health",
  handler: async (request, context) => {
    try {
      const pool = await getServicesPool();
      await pool.request().query("SELECT 1 AS ok;");
      return {
        status: 200,
        jsonBody: {
          status: "ok",
          service: "arion-func",
          timestampUtc: new Date().toISOString(),
        },
      };
    } catch (err) {
      context.error("[arion-func.health]", err);
      return {
        status: 500,
        jsonBody: {
          status: "error",
          service: "arion-func",
          details: err.message,
          timestampUtc: new Date().toISOString(),
        },
      };
    }
  },
});
