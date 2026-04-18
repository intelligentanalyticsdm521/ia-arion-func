import "dotenv/config";
import "./functions/health.js";
import "./functions/reconcileArtifacts.js";
import "./functions/markStaleHealth.js";
import "./functions/manualReconcile.js";
// Market Monitor timers — Authority-tier data capture
import "./functions/marketMonitorMoves.js";
import "./functions/marketMonitorBacklinks.js";
import "./functions/marketMonitorPageChanges.js";
