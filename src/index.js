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
// IA Insights monthly snapshot — 1st of month 05:31 UTC, aggregates captured
// data into arion.metric_monthly (the storage the Insights funnel reads).
import "./functions/insightsMonthlySnapshot.js";
// ARGUS Auto-Topoff — every 15 min, auto-refills credits via Stripe
import "./functions/argusAutotopoffCharger.js";
// F-LG.6 Lead Gen scheduled runs — every 30 min, dispatches scheduled search profiles
import "./functions/leadgenScheduledRuns.js";
// F-LG.6.4 Lead Gen weekly digest — Mondays 07:00 UTC, emails prior-week summary
import "./functions/leadgenWeeklyDigest.js";
// F-LG.15 followup — nightly TTL purge of lumen.domain_check_cache (04:23 UTC)
import "./functions/domainCheckCacheCleanup.js";
// AI Website Builder followup — nightly TTL purge of arion.site_block_draft (04:47 UTC)
import "./functions/siteBlockDraftCleanup.js";
// Wave 3 (2026-06-22) — My Brand Voice Monitor: nightly WP page brand-voice scan (05:55 UTC)
import "./functions/arionPageVoiceScore.js";
// My Brand > Social post dispatcher — every 5 min. Polls LUMEN-API for
// posts where status='scheduled' AND scheduled_for<=now, publishes to
// FB/IG/X/LinkedIn, PATCHes per-target results back.
import "./functions/socialPostDispatcher.js";
// My Brand > Social Analytics fetcher — daily 05:43 UTC. Pulls per-post +
// per-account metrics from FB/IG/X/LinkedIn into lumen.social_post_metric +
// lumen.social_account_metric via LUMEN-API internal endpoints.
import "./functions/socialAnalyticsFetcher.js";
// Onboarding Runner Worker — every 30s. Subscribes to stuck arion.site rows
// (status_phase in installing_plugins/creating_editor_user/configuring_seo/
// connecting_google/connecting_bing + pending_user_*_oauth) and advances
// them through the post-checkout phase machine the Portal-side
// OnboardingRunner polls. Without this, Portal sites stick on
// "Installing your tools" forever.
import "./functions/onboardingRunnerWorker.js";
// L16 Lead Gen monthly re-score — 03:29 UTC on the 1st. Rings LUMEN's
// /internal/leadgen/rescore/monthly; all the scoring lives there.
import "./functions/leadgenMonthlyRescore.js";
// ARGUS agent weekly cycles — both are thin bell-ringers, exactly like the
// two above: every piece of logic lives in the API that owns the data.
//   ARION Content & Social Agent — Mon 05:41 UTC → arion-api
//     POST /internal/content-agent-tick. Kill switch CONTENT_AGENT_DISABLED.
//     NOTE: that endpoint is not on the arion-api line yet (see the file).
//   SPARK Campaign & Automation Agent — Mon 12:40 UTC → LUMEN-API
//     POST /api/v1/internal/campaign-agent/tick. Kill switch
//     CAMPAIGN_AGENT_DISABLED. Drafts only; approving and sending stay human.
import "./functions/contentAgentWeekly.js";
import "./functions/sparkCampaignAgentWeekly.js";
