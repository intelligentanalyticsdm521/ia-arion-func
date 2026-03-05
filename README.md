# ARION Functions

Azure Functions app for ARION background jobs.

This initial production-safe baseline focuses on internal reconciliation:
- ensure `site_presence` / `site_seo_status` / `site_health` companion rows exist
- derive SEO connection flags from `site_integrations`
- mark stale health records when no heartbeat has been seen recently

The jobs intentionally do **not** perform external provider API calls yet. That lets you push the stack safely for private launch testing without introducing unstable OAuth/API dependencies.
