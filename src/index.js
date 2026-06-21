import "dotenv/config";
import "./functions/health.js";
import "./functions/reconcileArtifacts.js";
import "./functions/markStaleHealth.js";
import "./functions/manualReconcile.js";
// Market Monitor timers — Authority-tier data capture
import "./functions/marketMonitorMoves.js";
import "./functions/marketMonitorBacklinks.js";
import "./functions/marketMonitorPageChanges.js";
// IA Plugin snapshot — nightly pull of site health/security/performance data
import "./functions/pluginSnapshot.js";
// Monthly PageSpeed — 1st of month, captures CrUX + Lighthouse opportunities
import "./functions/monthlyPageSpeed.js";
// ARGUS Auto-Topoff — every 15 min, auto-refills credits via Stripe
import "./functions/argusAutotopoffCharger.js";
