# Architecture

## Runtime shape

The application is a small Node.js web service with an optional in-process poller that invokes the finite dispatcher. The dashboard, dispatcher and poller share MySQL state. Docker Compose runs the app and MySQL; `SCHEDULER_ENABLED` explicitly controls whether the app polls. The default is disabled so a fresh deployment cannot publish until an operator enables it.

Admin browser -> Node.js HTTP server -> session/CSRF checks -> application services -> MySQL repository and provider adapters.

The dispatcher calls the same application services. OpenRouter generates content; Tebar publishes and reports status; Telegram sends operational notifications. Tebar webhooks return through a signed endpoint and update the same durable state.

## Boundaries

- Domain policy validates schedule settings, a one-minute minimum cadence, and hashtags. Legacy game, price, product-fact, and active-window policy is not part of the active NDI path.
- The repository loads NDI business knowledge from a dedicated MySQL column. New generation requires an explicitly approved knowledge record. The context contains NDI identity, services, ticketing status, approved/forbidden claims, CTA, configured hashtags, and up to five recent published NDI captions. Legacy product facts, old templates, and non-NDI captions are excluded.
- The content service always generates for the `ndi` pillar in Indonesian. Deterministic checks require one configured HTTPS URL at the end, configured hashtags, an NDI-contextual invitation, factual-number and personal-information safeguards, legacy-content rejection, a 500-character limit, and repetition checks. An independent model audit must pass; malformed, rejected, or unavailable audits fail closed. Generation retries remain bounded at two attempts.
- The CTA defaults to `https://nusadataindonesia.com` and can be any syntactically valid HTTPS URL configured by an admin. The application does not fetch the CTA. The marketing destination is independent from the dashboard origin. CTA validation does not fetch the configured URL.
- Semantic review is probabilistic and cannot guarantee factual accuracy. Admins should review knowledge and representative output before enabling automation. NDI Ticketing must remain described as an in-development invitation-only customer-support triage pilot, not an event-ticketing product available for general purchase.
- Category and style selection is persisted with each logical slot in the same transaction as claim. Only an authoritative Tebar Threads target `published` timestamp advances category rotation. Missing or tied provider times block new publication rather than using observation time. The category-proposal job is optional, defaults OFF, and uses a scheduler independent of publishing; AI suggestions remain pending until admin review.
- Tebar adapter owns API URLs, Bearer authentication, account/status/list/cancel/insights requests, idempotency headers, and response normalization. Other modules use provider-neutral methods.
- Telegram adapter sends bounded notifications and daily summaries. It redacts secrets and never exposes provider response bodies.
- Repository owns SQL, migrations, transactions, durable slot state, sessions, NDI knowledge, settings, audit events, and webhook deduplication. Legacy `service_facts` and `templates` rows remain stored for history but have no active route or generation path.
- Dispatcher claims one due slot at a time, generates and validates content, persists the exact request and idempotency key, submits the post, then reconciles status. It never blindly creates a new publish request after an uncertain outcome.
- Telegram delivery uses a MySQL outbox with deduplication, retry backoff, and claim leases. Webhook state and its notification enqueue commit together; dispatcher runs retry pending notifications.
- HTTP application serves static dashboard assets, authenticated JSON routes, login/session/logout, provider webhooks, health status, and safe error responses.
- The integration configuration service persists a versioned Tebar profile/account pair and OpenRouter model in MySQL after one-time bootstrap. Each slot snapshots its publishing identity and the generation model; account switching is fenced through database state and leaves automation paused. See [Dynamic integration configuration](DYNAMIC-CONFIGURATION.md) for precedence, recovery, and provider limits.

## Scheduling model

New schedule settings default to 60 minutes and use `schedule.intervalMinutes` as the canonical MySQL JSON value. The UI accepts whole hours and minutes down to one minute. Legacy `schedule.intervalHours` values are converted during validation/read, without a schema migration. The IANA timezone defaults to `Asia/Jakarta`; due instants are stored in UTC. Publishing is 24/7. Persisted legacy active weekdays and daily time-window settings are ignored. Evaluate provider quotas, rate limits, latency and API cost before enabling a short interval. Missed slots are skipped without catch-up.

The product schedule and scheduler poll interval are separate. The poller checks for due work every 60 seconds by default (configurable from 15 to 3,600 seconds). On automation enable, the app requests an immediate first dispatch; the next slot follows the newly configured interval. A slot already scheduled before an interval edit keeps its timestamp, and that updated interval is used afterward. The poller also runs immediately on startup and then polls; persisted slots survive restarts. The planner skips slots more than 15 minutes late instead of catching up. MySQL settings-row locks serialize claims across app processes, and claim/publish guards allow only one active generation or publish cycle per automation session. Unknown provider outcomes continue to block later slots until reconciled.

The daily Telegram summary is scheduled for 22:00 `Asia/Jakarta` regardless of a stored schedule timezone.

## NDI business content and migration

Migrations `021`–`022` are additive and restartable. Migration 021 adds structured NDI knowledge, approval, legacy-settings archives, and a per-slot CTA snapshot. It archives the old `settings_json` and `knowledge_json` before removing game, price, old-brand, and tracked-link keys from active settings, initializes NDI knowledge without approval, clears old active hashtags, and leaves `service_facts` rows/state unchanged. The NDI runtime does not read those rows. Migration 022 adds strategy categories/styles, proposals, strategy settings, per-slot snapshots and provider publication time. The migrations do not update `automation_enabled`, provider credentials, integration configuration, sessions, audit rows, or existing slot status. Strategy approval and proposal scheduling remain off after migration.

Onboarding is marked incomplete so an existing database cannot publish under old review state. Existing ready/pending slots without required CTA or strategy snapshots fail closed; `publishing` and `unknown` slots retain their provider identity and state for reconciliation. A dashboard admin must review NDI knowledge and explicitly enable the content strategy before automation can pass readiness. Image rollback does not undo MySQL DDL or restore archived business/strategy knowledge; assess compatibility and retain a verified backup before any production rollout.

## Publish and recovery states

Each slot has a unique scheduled instant and durable state: pending, generating, ready, publishing, published, failed, unknown, canceled, or skipped. The exact outbound body and Tebar idempotency key are stored before the request. Known provider IDs are reconciled through Tebar's status endpoint. A request with no known provider ID is never replayed automatically; unresolved slots block later publishing until an operator reconciles the outcome. Cancellation requests only target posts Tebar reports as still scheduled/draft; cancellation races are recorded distinctly.

## Authentication and secret boundaries

- The initial administrator is created by a local bootstrap command. Active admins have equal permissions; account changes are audited and password/email changes revoke sessions. Admin deactivation is soft and preserves references in audit history.
- Passwords use Node's scrypt with a random salt. Session tokens are random, stored as hashes in MySQL, expire server-side, and rotate on login.
- Mutating dashboard requests require same-origin validation and a per-session CSRF token. Cookies are secure in deployed HTTPS environments, HTTP-only, and SameSite strict.
- Tebar, OpenRouter, Telegram, and database credentials are environment-only. The dashboard never returns their values.
- The three non-secret integration identifiers are managed separately from environment-only credentials; configuration updates require authenticated sessions, Origin/CSRF checks, provider validation, and an expected version.
- Webhook signatures are verified using the raw request body, a timestamp freshness window, constant-time HMAC comparison, and event-ID deduplication.
- Provider errors are normalized to safe codes; raw response bodies and auth headers are not logged or sent through Telegram.

## Storage choice

MySQL is chosen because the dashboard and one-shot dispatcher need durable transactions and uniqueness constraints across separate HTTP and scheduled processes. Local Compose and the homelab deployment use MySQL 8.4. Production MySQL is private to the `bot-ndi_database` Docker network, has no host port, and persists in the dedicated `bot-ndi_mysql_data` volume. The database starts empty and receives ordered migrations. A tested encrypted backup is still required because a Docker volume is persistence, not a backup.

## Deployment constraints

GitHub-hosted CI handles pull requests and pushes to `main`. After a successful trusted push run, `workflow_run` validates its API provenance and current `main` head before selecting the production runner. Manual `workflow_dispatch` remains available for reviewed deployments and rollback. Both modes use the protected `production` Environment and dedicated repository self-hosted runner in the Bot NDI LXC. The runner checks out the validated SHA and builds the Docker image locally without publishing it to a registry. Each attempt uses a unique `<commit-sha>-<run-id>-<attempt>` release and image tag; the OCI revision label, release metadata, and health marker retain the full commit SHA. Shared concurrency serializes deployment, health verification gates promotion, and rollback starts the exact previously verified local image without deleting or recreating the database volume. A schema baseline and tracking marker record successful migrations independently of app promotion; an uncertain migration or missing managed baseline blocks automatic deployment. Migration changes still require manual review. A successful manual rollback stores its controlling main SHA so a queued automatic run cannot immediately undo it; app rollback does not reverse the database schema.

The app binds to the operator-verified Bot NDI LXC address and configured host port for the existing Traefik gateway on LXC 10080. The intended public hostname is `https://botndi.sequein.my.id` through the existing Cloudflare Tunnel and Traefik path; no gateway change or new tunnel is performed by deployment. Runtime secrets stay in `/opt/bot-ndi/.env` on the LXC and are not synchronized from Git. `TRUST_PROXY` remains false until the real ingress path is verified. The first bootstrap keeps the scheduler, publishing integrations, and Learning flags disabled. Operators have verified the initial LXC deployment, MySQL, admin authentication, and public readiness endpoint; provider activity still requires explicit runtime activation.

## Provider capabilities and MVP limits

Tebar documents immediate publishing and scheduled publishing, idempotency keys, per-target status, scheduled-post cancellation, and Threads insights. Threads profile visits are not among the documented insight metrics. MVP awareness measurement is tracked-link clicks; website and conversion analytics are deferred.

## HTTP route ownership

`src/cli.js` is the composition root for configuration, MySQL, repositories, provider clients, the scheduler, and the Express app. `src/server.js` configures HTTP middleware and mounts feature-focused route registrations from `src/http/routes/`. Route modules receive repository, auth, middleware, and services through dependency injection; they do not create pools or provider clients.

| Module | Method | Path |
| --- | --- | --- |
| `src/server.js` | GET | `/health/live` |
| `src/server.js` | GET | `/health/ready` |
| `src/http/routes/webhooks.js` | POST | `/webhooks/tebar` |
| `src/http/routes/session-admin.js` | GET | `/api/session` |
| `src/http/routes/session-admin.js` | POST | `/api/session/login` |
| `src/http/routes/session-admin.js` | POST | `/api/session/logout` |
| `src/http/routes/session-admin.js` | GET | `/api/admins` |
| `src/http/routes/session-admin.js` | POST | `/api/admins` |
| `src/http/routes/session-admin.js` | PATCH | `/api/admins/:id` |
| `src/http/routes/dashboard.js` | GET | `/api/dashboard` |
| `src/http/routes/content-strategy.js` | GET | `/api/content-strategy` |
| `src/http/routes/content-strategy.js` | POST/PUT/PATCH | `/api/content-strategy/categories`, `/styles`, `/:id`, `/:id/active`, `/:id/archive` |
| `src/http/routes/content-strategy.js` | POST | `/api/content-strategy/enable`, `/api/content-strategy/disable` |
| `src/http/routes/content-strategy.js` | PUT / POST | `/api/content-strategy/proposals/config`, `/proposals/:id/:decision` |
||| `src/http/routes/dashboard.js` | PUT | `/api/settings` |
| `src/http/routes/dashboard.js` | PUT | `/api/knowledge` |
| `src/http/routes/dashboard.js` | PUT | `/api/facts/:service` |
| `src/http/routes/integrations.js` | GET | `/api/integrations` |
| `src/http/routes/integrations.js` | GET | `/api/integrations/models` |
| `src/http/routes/integrations.js` | POST | `/api/integrations/validate-account` |
| `src/http/routes/integrations.js` | POST | `/api/integrations/validate-model` |
| `src/http/routes/integrations.js` | PUT | `/api/integrations/account` |
| `src/http/routes/integrations.js` | PUT | `/api/integrations/model` |
| `src/http/routes/integrations.js` | POST | `/api/integrations/reconcile` |
| `src/http/routes/integrations.js` | POST | `/api/integrations/rollback` |
| `src/http/routes/automation.js` | POST | `/api/automation/enable` |
| `src/http/routes/automation.js` | POST | `/api/automation/pause` |

`test/routes.contract.test.js` compares dashboard API calls with registered Express method/path pairs and verifies the route set and ordering.

`PUT /api/knowledge` and `PUT /api/settings` require authenticated sessions, same-origin validation, CSRF protection, and audit logging. `PUT /api/facts/:service` is retained as a compatibility response that returns `410 LEGACY_FACTS_ARCHIVED`; template and legacy Learning endpoints are not registered. The dashboard has no active game, top-up, template, or Learning controls. Category/style controls use existing dashboard navigation and do not redesign the main layout. Website-knowledge sync is deferred to Phase C. Website knowledge sync is deferred to Phase C.

Webhook body parsing and fallback ordering are intentional: `/webhooks/tebar` uses raw-body parsing before `express.json()` so signature verification sees the signed bytes. The `/api` not-found handler stays after API routes and before static assets and the SPA fallback.
