# MASTER IMPLEMENTATION PROMPT — BOT NDI

**Project:** Bot NDI — Nusa Data Indonesia Threads Content Automation  
**Role:** Senior software architect, full-stack engineer, database engineer, DevOps/SRE, and QA lead  
**Language for implementation reports and collaboration:** Bahasa Indonesia  
**Status:** Approved requirements, **NOT approval to deploy/merge/activate posting**  
**Purpose:** This document is the single source of truth for Codex's business migration and implementation phases A, B, and C.

> **CRITICAL: READ THE ENTIRE DOCUMENT BEFORE CHANGING CODE.** Do not truncate the scope to the first/last sections. Treat ALL sections (including tables, edge cases, and test cases) as binding. Do not infer that a proposed implementation is approved for production just because this prompt is provided.

---

## 0. EXECUTION CONTRACT — PREVENT MISSING-IN-THE-MIDDLE

1. Read this file **from beginning to end**, then inspect the actual repository and production-facing documentation. Do not start implementation until a complete requirement inventory exists.
2. Create and maintain `docs/ndi-requirements-traceability.md` with a row **for every requirement ID** in this prompt. Columns: ID, requirement summary, existing implementation/evidence, target files/modules, phase, implementation state (`TODO / IN_PROGRESS / DONE / BLOCKED / NOT_APPLICABLE`), automated tests, verification evidence. No omitted IDs; mark not-applicable with an explicit rationale.
3. Create `docs/ndi-codebase-audit.md`: inventory every BotMerzz/Kedai Merzz/game/top-up/product-price/stock/tracking field, label, DB column, API schema, validation, prompt, service fact, content hook, fixture, UI screen, README/docs, migration, and test; classify **replace / remove / retain for compatibility / historical only** with justification. Include case-insensitive searches and semantic searches (synonyms), not just `rg BotMerzz`.
4. Create `docs/ndi-implementation-plan.md` listing phases A/B/C, file-level impacts, migrations, compatibility risks, deployment hazards, test strategy, staging/rollback criteria, and specific go/no-go gates.
5. Work **phase by phase**, each as a separate reviewable PR, unless the operator explicitly approves another arrangement. No phase may silently depend on undeployed future features. Preserve auditability and backwards-compatible schema transitions. Do not automatically begin the next phase without operator approval.
6. Before concluding **each phase**, re-read this whole prompt and re-check every ID for that phase and all cross-phase invariants; explicitly identify unimplemented/blocked requirements. Include a coverage summary in final report. Test results must never be fabricated.
7. If repository code conflicts with this specification, preserve existing security/automation behavior by default; record the conflict, propose a safe resolution, implement only when safe, and report uncertainties. Do not silently weaken production guards.
8. If any business detail is unspecified, choose the least risky default, document it, and avoid asserting invented company facts. Ask only about decisions that materially block safe implementation.
9. **No production merge, deploy, scheduler activation, external Threads posts, credential rotation, destructive migration, database reset, or changes to BotMerzz infrastructure** without separate explicit approval. A PR and local tests are allowed.
10. Do not expose `.env` contents, tokens, passwords, session secrets, or database credentials in commits, output, errors, or screenshots. `.env.example` is only a template, never a credential source.

### Mandatory checkpoints for long context

- Keep a compact `docs/ndi-progress-checkpoint.md` updated after each substantial task: current phase, completed IDs, remaining IDs, decisions, test results, next safe operation; reference the traceability matrix.
- At each checkpoint, inspect **early, middle, and late** requirement sections, including R-030–R-073. Do not summarize away middle requirements.
- If context is insufficient, stop with a precise checkpoint and continue from the files; do not drop requirements or falsely claim completion.

---

## 1. CONFIRMED PROJECT CONTEXT (VERIFY AGAINST REPO)

- **Repository:** `Nusa-Data-Indonesia/bot-ndi`, production branch `main`.
- **Production app:** Debian 13 LXC VMID `10030`, hostname `ndi-bot`, LAN `192.168.0.30`.
- **Gateway:** separate LXC VMID `10080`, Traefik and Cloudflare Tunnel, gateway address `192.168.0.80`.
- **Public URL:** `https://botndi.sequein.my.id` (dashboard and `/health/ready` previously returned 200).
- **Official NDI marketing URL / initial CTA:** `https://nusadataindonesia.com` (distinct from bot dashboard hostname).
- **Application:** Node.js, Docker Compose, MySQL 8.4; project `bot-ndi`, DB `bot_ndi`, persistent volume `bot-ndi_mysql_data`; app container `bot-ndi-app-1`.
- **Runtime env:** `/opt/bot-ndi/.env` (protected, never commit), `TRUST_PROXY=192.168.0.80` already confirmed inside container.
- **Runner:** self-hosted `ndi-bot-runner`, labels `self-hosted,linux,x64,bot-ndi`, Docker local builds without GHCR. Existing CI/auto-deploy, production environment, preflight, health check, release state and rollback must remain functional.
- **Initial admin:** already created; login works. No reseeding users or changing identities.
- **Existing providers:** OpenRouter (generation), Tebar (Threads posting), Telegram (notifications).
- **Existing safeguards:** scheduler, monitoring, retry, strict content checks, publishing slot states including `unknown`, manual acceptance/recovery, audit and logging.
- **Operator backup policy:** database backups are **manual, controlled by operator**. Do not implement scheduled backups or delete backup artifacts. Never reset/drop production database or remove its Docker volume.
- **Scheduler and posting:** do not enable automatically during implementation or deployment; preserve actual runtime flags and DB configuration, not just `.env` defaults.
- **Important:** These are known contextual facts, not proof that every code path remains unchanged. Audit actual deployed and repository implementation before editing.

### R-001–R-009: Infrastructure and change scope

- **R-001:** Do not modify the separate BotMerzz application, repository, LXC, database, account, secrets, or deployment. Bot NDI remains completely independent.
- **R-002:** Preserve existing Docker Compose topology, persistent MySQL data, release/rollback model, CI and auto-deploy, environment protections, and health endpoints.
- **R-003:** Preserve existing app authentication and administrator, sessions, account audit, and access control.
- **R-004:** Preserve existing operational scheduler intervals/configuration, provider integrations, notification channels, retry counts, failure/unknown behavior; only change NDI-related business/content logic where specified.
- **R-005:** No dashboard visual redesign in this project. Retain layout/navigation structure wherever possible; update functionality, labels, controls, errors, empty states, and business vocabulary.
- **R-006:** No new container registry, GHCR dependency, external deployment host, or mandatory infrastructure service.
- **R-007:** Schema changes must be additive/backwards-compatible where practical; never treat rollback of application image as rollback of DB schema. Destructive migration requires a separately approved plan.
- **R-008:** Keep `TRUST_PROXY` narrowly scoped to actual trusted gateway; do not change to blanket `true`. Preserve current protections, input validation, cookie/session behavior, and TLS usage.
- **R-009:** Production posting remains disabled/unchanged until separately approved, including any new periodic category proposal mechanism. Tests must use fakes/mocks, not real Tebar posting.

---

## 2. BUSINESS IDENTITY — OFFICIAL FACTS AND CLAIM LIMITS

**Company:** Nusa Data Indonesia (NDI).  
**Positioning (source supplied by owner):** “A data technology company. Built around useful decisions.”  
**Description:** “Nusa Data Indonesia is a company focused on developing data technologies and its own software products. We work from the information people have toward the decisions they need to make. NDI Ticketing, our invitation-only pilot MVP for customer support triage, is one application of this broader focus.”

**Vision:** Help people and organizations turn information into understanding and better decisions.

**Mission:** Develop data technologies and software products by understanding real problems, organizing information in context, and evaluating how well the results support the people using them.

**Services the owner has explicitly stated NDI offers:** custom software development, information systems, data analytics, dashboards, API development/integration, technology consulting, tailored systems/solutions based on client requirements. Explain business value accurately; do not present unsupported certifications, case studies or performance claims.

**Product boundary:** **NDI Ticketing** is a product **in development**, shown as development portfolio, with an **invitation-only pilot MVP for customer support triage** according to company copy. Do **not** rebrand it as a mature, publicly available event-ticketing SaaS or claim it is ready for open purchase. Avoid confusion with other unrelated event-ticketing projects.

**Primary audience:** B2B: startup founders, companies and organizations. **Secondary audience:** B2C/SMEs (UMKM), students, developers and the wider technology community.

**Priority outcomes:** brand awareness first; qualified leads/client acquisition also high priority. Tone must be useful, authentic and trust-building, not spammy or misleading.

### R-010–R-019: Company content truth

- **R-010:** Replace all current business-facing Kedai Merzz/BotMerzz/top-up/game framing with NDI's positioning, mission, services and products.
- **R-011:** Keep NDI service offerings configurable as admin-approved business knowledge, not unchangeable hallucinated source-code constants.
- **R-012:** Treat NDI Ticketing only as the in-development/pilot portfolio case described above; no invented availability, onboarding, integrations, results, pricing or clientele.
- **R-013:** Never invent client names, testimonials, measurable results, company experience/years, prices, case-study outcomes, completed projects, service guarantees, or unavailable product features.
- **R-014:** Hypothetical business scenarios are allowed **only when explicitly labeled as illustration/example**, never framed as a real customer engagement.
- **R-015:** Content in **Bahasa Indonesia** by default, aimed mainly at B2B readers but understandable to other relevant audiences.
- **R-016:** Content should explain what NDI offers, which problems it can help address, and potential value, while distinguishing possibility from proven results; maintain accuracy and credibility.
- **R-017:** The dashboard's **admin-approved database knowledge** is authoritative; website data or AI suggestions do not override it automatically.
- **R-018:** Keep NDI identity/terminology consistent across generation prompts, UI copy, notifications, content validations, historical-context display, fixtures and documentation; handle historical records truthfully (do not rewrite past audit events).
- **R-019:** Do not use website scraping as permission to adopt unverified claims or unsupported service statements. Website is secondary reference only after admin review.

---

## 3. CONTENT CATEGORIES, STYLE TEMPLATES AND MANAGEMENT

### Eight initial content categories (editable)

1. Edukasi Data & Teknologi
2. Solusi Masalah Bisnis
3. Pengenalan NDI
4. Produk NDI
5. Insight Startup
6. Studi Kasus Hipotetis
7. Soft-selling
8. Engagement

### Seven initial style templates (editable)

1. Korporat profesional
2. Edukatif sederhana
3. Teknis informatif
4. Storytelling masalah bisnis
5. Soft-selling konsultatif
6. Conversational
7. Problem solving

**Definition:** A *category/topic* for rotation is a **high-level content category**, not a fine-grained hook or individual microtopic. The model can generate different detailed subjects under a category; existing hook-similarity guardrails still apply.

### R-020–R-034: Management and randomization

- **R-020:** Provide these eight initial categories as safe, idempotent defaults. Do not blindly reinsert on each startup or overwrite admin edits.
- **R-021:** Admin can create, view, edit, activate/deactivate, and archive categories. Archived/inactive categories are excluded from selection, but references and audit history remain intact.
- **R-022:** Provide seven initial language-style templates, with clearly editable guidance/instructions that shape generation, not just decorative labels.
- **R-023:** Admin can create, view, edit, activate/deactivate and archive style templates. Preserve historical references and audit records.
- **R-024:** Select categories **uniformly at random** among eligible active categories; no admin-configured weighting is required. Select styles uniformly and **independently** among active style templates.
- **R-025:** Exclude the category of the **last provider-confirmed successfully published Threads post** from the next category selection when at least two active categories can be selected.
- **R-026:** If only one category is active, repetition of that category is explicitly permitted.
- **R-027:** If zero categories are active, **do not publish**; record actionable cause and notify admin via existing notification/monitoring path. Do not self-enable inactive categories.
- **R-028:** Neither draft generation nor attempted submission nor failed/pending/unknown slot is a successful publication for category rotation. A `success` event must correspond to genuinely confirmed provider publication, with correct deduplication.
- **R-029:** For late provider confirmations, determine the last category using authoritative publication ordering from provider if available, **not merely draft creation/reservation order**. If reliable provider publication time/order is unavailable, explicitly mark ordering as uncertain and preserve existing blocking/reconciliation safeguards; do not silently treat webhook arrival order as publication order, invent evidence, or publish additional posts to repair rotation. Document a conservative fallback and prove it in tests before enabling posting.
- **R-030:** Maintain category selection consistency across process restarts, retries, concurrent workers, delayed webhooks and manual recovery; use DB transactional/atomic state where needed. Associate selected category/style with a stable logical slot ID, and make confirmed-result updates idempotent against duplicate/out-of-order provider events. Never create duplicate publication to satisfy rotation.
- **R-031:** If zero style templates are active, fail closed for generation/publication with actionable admin notification. Do not silently use an archived style or invent a new one.
- **R-032:** AI **may propose new categories periodically**, but proposals remain separate from approved categories and **cannot be selected or activated until an admin explicitly approves**. Include review, reject and audit paths.
- **R-033:** Periodic proposal generation must be administratively configurable, with a safe **disabled-by-default initial state** (and a documented configurable interval). It is a separate proposal job, not a Threads publishing slot; enabling it must not toggle the publishing scheduler or trigger posting. Never silently activate it during migration. No additional automatic website synchronization.
- **R-034:** Category proposal failures must not disrupt ordinary posting if normal posting remains otherwise valid; observe existing rate limits, budgets, scheduling and provider restrictions. Do not use proposals to publish content or change approved business facts.

---

## 4. REQUIRED CTA, URL SETTINGS, CONTENT VALIDATION

The existing setting labeled **“Tautan top-up berpelacak”** must become **“Website Resmi / CTA URL”** (or equally clear Bahasa Indonesia), defaulting to `https://nusadataindonesia.com`. The field must remain admin-editable and must be actually used in generation and publication, not only renamed in UI.

### R-035–R-044: CTA and safeguards

- **R-035:** **Every newly submitted post** must include both (a) a relevant, contextual, varied invitation to use/consider NDI services and (b) the complete configured CTA URL captured at the logical slot's generation/submission boundary; validate the finalized payload before Tebar submission. A later admin edit to CTA must not silently mutate or duplicate an already in-flight/unknown slot. Document and test the precise config-snapshot boundary.
- **R-036:** CTA phrasing varies naturally according to topic and tone; do not force one repeated sales line for every post. The URL itself must match configured value exactly after safe normalization.
- **R-037:** Default URL is `https://nusadataindonesia.com`; admin **may change it to any valid HTTPS URL**, not just an NDI domain. Do not impose an undisclosed hostname allowlist on this *CTA field*.
- **R-038:** Validate CTA URL: HTTPS scheme, legitimate hostname, syntactically valid URL, no control characters, unsafe encoding, credentials or obvious injection; reject invalid values with useful errors. Consider dangerous destinations if server-side URL fetching is ever introduced. **CTA validation does not require or authorize fetching the configured destination.**
- **R-039:** Ensure final-post validation verifies presence of the correct slot-snapshot CTA URL **after all formatting, shortening, token limits and retries**; if invalid or missing, do not send to Tebar. Do not replace, shorten, or alter the required URL unless the exact submitted payload still satisfies the configured URL rule. Preserve existing retry count and failure semantics.
- **R-040:** Ensure external platform length and link rules are respected. If mandatory CTA does not fit, safely regenerate/fail; never silently strip the URL.
- **R-041:** Enforce claim rules (R-012–R-014) via prompt plus deterministic checks where possible. Do not claim a heuristic validator can perfectly prove factual accuracy.
- **R-042:** Preserve all existing general guardrails: content length/character validation, hooks similarity/anti-duplication, prohibited links/claims, rate limits, provider safety and user-facing errors as appropriate.
- **R-043:** Preserve **existing retry counts**, backoff and failure handling; do not invent new retries or auto-resubmit unknown posts.
- **R-044:** When a historical 'approved game top-up' allowlist or product stock/price validator is inapplicable, remove/replace its influence from new NDI generation/publishing while retaining relevant general security validation and migration-safe historical data.

---

## 5. PRODUCTION POSTING FLOW — PRESERVE EXISTING AUTOMATION

### R-045–R-054: Execution and unknown safety

- **R-045:** Normal flow: scheduled slot → select eligible category + style → obtain approved business context → OpenRouter draft generation → existing validation/retry → Tebar publication → confirm final provider outcome → record category/style/result → monitoring/notification.
- **R-046:** **No routine manual acceptance of each content draft** is required; automatic publication remains the intended mode once operator explicitly enables the existing scheduler in production.
- **R-047:** Preserve scheduling interval, scheduler control semantics, toggles, delivery cadence, existing state transitions and provider integrations. Do not unintentionally start schedulers at boot, after migration, or when activating proposal generation.
- **R-048:** Preserve the strict `unknown` slot behavior: no blind retry; stop/cancel/block subsequent schedules as currently implemented until authorized operator review/recovery determines safe action. Do not reinterpret timeout as failure.
- **R-049:** Improve clarity of existing `unknown` review/recovery UI **without changing the fundamental recovery model**: status, reason, timestamp and the existing safe operator actions should be understandable and accessible.
- **R-050:** Preserve manual acceptance/reconciliation semantics of uncertain provider outcomes, audit trail, operator accountability and any provider confirmation/identity checks.
- **R-051:** Preserve Telegram notifications and bot monitoring with NDI-specific language; errors should distinguish invalid configuration, zero active categories, unknown external outcome and other failures.
- **R-052:** Preserve OpenRouter and Tebar integration settings, webhook protections, idempotency, concurrency controls, payload validation, and post-result accounting.
- **R-053:** On failures and retries, do not allow category selection, style selection or CTA state to cause double posting or loss of unknown-state protection; associate choices with the logical slot/draft as needed.
- **R-054:** All real integrations are disabled/mocked during tests; never publish a live Threads post in an automated test or demo.

---

## 6. BUSINESS KNOWLEDGE AND WEBSITE SYNC

### R-055–R-063: Knowledge authority and admin-initiated synchronization

- **R-055:** Maintain a structured, admin-editable knowledge source in the database for company identity, services, products/status, supported claims, constraints, CTA and content guidance; preserve data already relevant to NDI. Audit the current authoritative DB-backed runtime configuration and its initialization markers before migration: code defaults and `.env` must not be mistaken for effective admin-approved settings. Do not overwrite existing production integration credentials, flags, or configuration history during business data conversion.
- **R-056:** Admin-approved DB facts outrank website suggestions and AI-generated proposals. New facts cannot become authoritative merely because website or AI said so.
- **R-057:** **Website synchronization is manual ONLY:** start network retrieval solely after an authenticated, authorized admin presses **“Sinkronkan Website NDI”**. No cron, periodic fetch, hidden autonomous crawler, or automatic activation via scheduler.
- **R-058:** Sync targets the official NDI website `https://nusadataindonesia.com` (and only clearly approved same-site pages/redirects); preserve a distinct distinction between this source URL and the editable publishing CTA URL (which may point anywhere HTTPS).
- **R-059:** Sync flow: admin click → fetch & parse safely → extract possible changes → compute per-item diff → present proposed additions/edits/removals with origin/source URLs and timestamps → admin independently approves or rejects **each** change → only approved entries update knowledge. Every proposal must be tied to a knowledge version; an outdated approval must show a conflict rather than overwrite a newer admin edit. No website fetch runs in background except the bounded job directly initiated by that admin action.
- **R-060:** Content from website is **untrusted**. Defend against SSRF, DNS rebinding, redirects to private IP space, huge downloads, HTML/script injection, prompt injection and unintended credential transmission; use strict timeouts, size limits, bounded crawl scope and safe rendering; do not follow arbitrary external links. Do not grant website text system-level instructions.
- **R-061:** Keep knowledge versioning/audit for requested sync, proposal, approved/rejected changes, who approved, and source provenance; do not destroy historical audit entries.
- **R-062:** Failure to fetch/parse the website must not modify authoritative knowledge or unexpectedly affect normal publication; show safe, actionable diagnostics.
- **R-063:** Support admin modification of knowledge independently of website syncing; if approved web suggestions conflict with newer manual facts, surface explicit conflict rather than silently overwriting them.

---

## 7. DASHBOARD, LEGACY CLEANUP AND MIGRATIONS

### R-064–R-073: Scope and user experience

- **R-064:** Preserve the present dashboard overall layout and navigation rather than designing a new interface; focus on coherent NDI behavior, text, forms and functional workflows.
- **R-065:** Eliminate live Kedai Merzz/BotMerzz and top-up-specific wording in active UI and business logic, including **“Tautan top-up berpelacak”**, **“Game top-up yang disetujui”**, price/stock-related controls and other irrelevant defaults. Verify visible labels, API responses, notifications and generated text.
- **R-066:** Do not merely rename irrelevant game/top-up settings; remove obsolete special-purpose fields/pipelines where safe and replace with appropriate NDI knowledge/content controls. Retain generic guardrails and historical schemas only where needed for compatibility.
- **R-067:** Retain relevant data (admin account, audit records, useful settings/history, release state, external credentials) without overwriting secrets or blindly resetting the DB. Legacy historical data may remain readable as historical facts, not be used as current NDI source knowledge.
- **R-068:** Include safe migrations for legacy production data. Migrations must be idempotent, tested on a sanitized representative copy/disposable DB, rollback-aware and compatible with production auto-deploy. Never use production credentials in test fixtures. Do not drop old tables/columns as a shortcut. For incompatible DDL or irreversible conversion, produce an operator-reviewed manual deployment plan and stop; passing app tests alone is not authorization to merge.
- **R-069:** Ensure old data cannot contaminate AI prompts or active output after migration. Explicitly test startup with legacy DB content and with fresh NDI DB content.
- **R-070:** Use user-friendly Bahasa Indonesia labels, descriptions, validation errors, confirmation dialogs and empty states. Names should accurately reflect semantics, not simply replace a few strings.
- **R-071:** New category/style CRUD, proposal approval, sync changes and unknown-slot operator actions must require authentication, appropriate authorization and CSRF/session protections consistent with existing architecture; log state changes.
- **R-072:** The bot dashboard domain `botndi.sequein.my.id` is NOT automatically the marketing CTA domain `nusadataindonesia.com`; keep them independently configured.
- **R-073:** Keep existing production credentials working, do not rotate them as part of a terminology migration, and do not leak them through debug panels or new content-management endpoints.

---

## 8. PHASED IMPLEMENTATION AND RELEASE GATES

### PHASE A — Business identity and business-logic cleanup (first PR)

**In scope:**

- Audit and inventory all legacy BotMerzz/top-up business assumptions and files.
- Update NDI company facts, services, product status, generator prompts, service knowledge, brand-language defaults, CLI/docs, UI labels and errors, notifications and content-validation logic.
- Convert tracking top-up URL field into editable **Website Resmi / CTA URL** with NDI default and HTTPS policy.
- Remove inappropriate game/top-up-specific generation and validation safely while retaining generic protections.
- Preserve all runtime infrastructure, admin login, DB data, CI/CD, unknown/monitoring/scheduler/retry.
- Build compatibility/migration tests; prevent historical top-up facts from leaking into future content.

**Boundary:** Fase A must ship independently in a safe, coherent state without assuming B/C have been deployed. Do not remove any functioning pipeline dependency before a tested replacement exists. If publishing needs the future category/style engine, fail closed with an explicit admin-visible readiness reason and keep publishing disabled; do not fall back to Kedai Merzz content or silently invent category/style behavior. In any state, new NDI publication must obey mandatory CTA and factual constraints. A new release must not reset a previously operator-enabled scheduler flag or permit unexpected live posting; verify effective DB/runtime state before recommending merge.

**Gate A:** UI contains no active obsolete top-up labels or live special-purpose controls; generation of NDI content has no TopUp/KedaiMerzz contamination; data remains intact; health and basic admin operations pass; no live external posts. Test against both a fresh NDI DB and a DB seeded with realistic legacy business configuration; prove the effective (DB-sourced) generator context is clean, not just `.env` or UI labels. Any B/C-dependent publishing path must fail closed with a clear reason.

### PHASE B — Content strategy engine (second PR)

**In scope:**

- Eight default categories and seven editable style templates, CRUD/state/archive/audit, schema/API/dashboard integration.
- Uniform independent random selection, exclusion of last confirmed published category, one-category exception, zero-category/zero-style fail closed.
- Provider confirmation ordering safety, delayed/unknown/failed cases and concurrency/retry behavior.
- Admin-reviewable AI category proposal feature that may be generated periodically with safe, disabled-by-default trigger and configurable cadence; no auto-approval.
- Strict CTA inclusion, variation and final-post validation across category/style prompts.

**Gate B:** End-to-end test coverage for randomization, state transitions, category/style management, provider ambiguity, mandatory CTA and scheduler compatibility. No unapproved proposals in active selection. Explicitly test a CTA edit while a slot is pending/unknown; repeated/out-of-order confirmations; only one active category; zero active categories/styles; and restart/retry determinism.

### PHASE C — Admin-triggered knowledge sync (third PR)

**In scope:**

- Admin-only **Sinkronkan Website NDI** button, bounded and secure fetch of official website, per-change diff and approval/reject UI, audit/versioning, knowledge update only after approval.
- Explicit conflict policy with newer manual facts, parsing/scraping failures and untrusted content.
- Maintain separation between official sync origin and freely admin-editable HTTPS CTA.

**Gate C:** No autonomous website fetching, no approval bypass, no silent updates, no SSRF/prompt-injection trust transfer; all failure states verified.

### Cross-phase gates

- Open a separately reviewable PR per phase, do not merge; observe GitHub CI before release recommendation. Complete A and obtain operator review before beginning B; repeat for C. Never treat passing local tests as a substitute for GitHub CI.
- Production auto-deploy can occur automatically on merge; explicitly warn owner before every proposed merge. An approved PR/implementation is **not** approval to merge: require a separate explicit operator authorization for each merge, especially when a migration is included. No manual production deploy or CI workflow change unless approved.
- For any migration that could break rollback, document expand/contract deployment plan and hold for operator approval; keep operator-managed manual backups outside tool scope.
- Do not remove old APIs/columns while a previous release may need them for rollback.
- If safe independent phase delivery is impossible, document blocking dependencies rather than shipping a partially broken scheduler.

---

## 9. TEST MATRIX — MUST IMPLEMENT/VERIFY

Each test should map to requirement IDs in `docs/ndi-requirements-traceability.md`. Favor deterministic fixtures, fake provider webhooks, mocked OpenRouter/Tebar/Telegram, disposable MySQL, and explicit provenance; no real live posts. Evaluate tests by phase: run all tests applicable to the current phase and the legacy regression suite, mark B/C-only tests as NOT_YET_IMPLEMENTED until their phase (never falsely PASS or FAIL them during A); require all T-01–T-30 to be addressed by final C completion.

| Test ID | Scenario and expected behavior |
|---|---|
| T-01 | Existing admin authentication, authorization, session, audit and health endpoints remain functional. |
| T-02 | Existing production-relevant MySQL data survives migrations; no volume wipe, no new DB replacement, no secrets overwritten. |
| T-03 | Search active UI and generation paths: no old game/top-up/Kedai Merzz wording, defaults, guardrails contaminating NDI posts. Historical audit remains truthful. |
| T-04 | NDI Ticketing described as in-development invitation-only customer-support triage pilot/portfolio; never as generally available event-ticketing product. |
| T-05 | Unsupported customer names, testimonials, pricing, growth claims and fabricated project outcomes are refused or rejected appropriately. |
| T-06 | Hypothetical case-study output clearly identifies scenario as illustrative. |
| T-07 | CTA URL defaults to exact official NDI URL; admin may set arbitrary valid HTTPS URL; insecure/malformed values rejected. |
| T-08 | Every post contains relevant variable NDI CTA **and** the configured complete URL, after final text processing; missing URL causes no publish with existing retries. |
| T-09 | Eight categories seeded once idempotently; admin CRUD/archive/toggle controls work; active selection excludes inactive and archived. |
| T-10 | Seven style templates seeded once, editable instructions materially affect prompt; admin CRUD/archive/toggle controls work. |
| T-11 | Uniform selection behavior for eligible active categories and styles (statistical sanity test without flaky assumptions); independent selection. |
| T-12 | Sequence A → C → A allowed; A → A disallowed when ≥2 active categories; one active category can repeat. |
| T-13 | No categories active: stop publication, actionable admin notification; no automatic reactivation. |
| T-14 | No styles active: fail closed and notify admin; no hidden archived fallback. |
| T-15 | Failed, pending, draft-only, timeout and unknown do not count as confirmed publications. |
| T-16 | Late confirmation/reordered provider outcomes preserve category exclusion according to verifiable publication order or documented conservative fallback. |
| T-17 | Concurrent scheduler/worker/retry/restart paths neither violate rotation nor double-post. |
| T-18 | AI category proposals never appear as selectable until admin approval; approve/reject/archive has audit trail. |
| T-19 | Periodic proposals are disabled initially; when enabled, they do not modify official knowledge or bypass posting controls, and failures do not unnecessarily block regular posting. |
| T-20 | Scheduler, intervals, OpenRouter/Tebar/Telegram interfaces, retry counts and monitoring behavior remain unchanged unless specifically required and justified. |
| T-21 | Unknown provider result stops/cancels/blocks future slots exactly as previous safety invariant; manual review cannot trigger blind duplicate retry. |
| T-22 | Unknown review UI communicates reason, timestamp, state and safe recovery; all actions authenticated/audited. |
| T-23 | Website sync cannot occur until authenticated admin clicks button; no periodic/scheduled website calls. |
| T-24 | Sync proposes per-item differences with provenance; each rejection changes nothing; each approval updates only that fact. |
| T-25 | Manual admin facts take precedence; conflicts and stale sync proposals do not overwrite facts silently. |
| T-26 | SSRF, off-domain redirects, DNS rebinding/private targets, huge responses, malicious HTML, website prompt injections are rejected or contained. |
| T-27 | Website down/parse error does not mutate approved knowledge or cause unintended publication stop. |
| T-28 | CTA URL may be HTTPS external while official website sync origin remains fixed to approved NDI site. |
| T-29 | Production config respects `TRUST_PROXY=192.168.0.80`; no blanket trust or exposure of private credentials. |
| T-30 | CI, deploy scripts, local Docker build, release identity, health, migration guard and manual rollback regressions still pass. |

**Additional mandatory checks:** `npm test`, integration suite, lint, typecheck, syntax checks, DB migration tests, Compose validation, local Docker image build, workflow syntax/actionlint where available, API/role/CSRF tests, and UI E2E if test environment supports them. If any test cannot run, report BLOCKED with specific reason; never report a suite as passed by inference.

---

## 10. BUSINESS COPY AND CONTENT PATTERNS

The content should adapt category and style, be natural Bahasa Indonesia, and not invent achievements. Examples below convey **direction**, not text to repeat verbatim:

- **Data/technology education:** explain how organizing scattered customer-support requests can help a team decide what to tackle first; avoid claiming NDI produced measurable client results.
- **Business problem solving:** discuss the friction of disconnected systems and invite exploration of custom integrations/software development.
- **Product NDI:** clearly identify NDI Ticketing as a still-developing invitation-only customer-support triage pilot/portfolio, with no unsupported release dates.
- **Hypothetical case:** start with “Ilustrasi:” and explain possible design choices, explicitly not a verified customer implementation.
- **Soft-selling:** offer a conversation about custom software, data analytics, dashboards or APIs, using a varied contextual CTA.

Every published post must end up with the **configured CTA URL** and an appropriate invitation such as “Kenali solusi yang dapat kami kembangkan untuk kebutuhan bisnis Anda: https://nusadataindonesia.com”, adjusted naturally per post. Do not assume user will always keep this default URL.

**Avoid:** game credit/top-up, game SKU, tracked game top-up links, stock, game account fields, claims of prior successful clients/results, unsupported commercial availability, repetitive sales spam, and forced false precision.

---

## 11. REQUIRED OUTPUT/DELIVERABLES

At minimum:

1. `docs/ndi-requirements-traceability.md` (every R-001–R-073, no gaps).
2. `docs/ndi-codebase-audit.md` (legacy inventory with treatment decisions).
3. `docs/ndi-implementation-plan.md` (A/B/C plan and deployment/rollback safety).
4. `docs/ndi-progress-checkpoint.md` (resumable state to avoid lost requirements).
5. Functional code, database migrations and tests per phase with no unauthorized production actions.
6. Updated README, operation instructions, configuration/default docs, recovery notes and API/UI labels.
7. PR per phase with change summary, affected schema/behavior, data retention risks, explicit test results, screenshots only if safe, and requirements coverage summary.
8. Final report in Bahasa Indonesia, including **coverage counts** (DONE/BLOCKED/NOT_APPLICABLE), unresolved assumptions, migration safety, CI status, remaining activation steps and **clear GO/NO-GO**; explicitly mention if no PR or external GitHub verification occurred.

**Implementation completion ≠ permission to merge or activate publishing.** The operator reviews PR and manually controls business activation. Keep existing auto-deploy behavior in mind when recommending a merge.

---

## 12. FINAL SELF-AUDIT — READ BEFORE COMPLETING EACH PHASE

Check and explicitly answer:

- Have we preserved ALL automation components (scheduler, unknown/manual review, OpenRouter, Tebar, Telegram, retries, monitoring, CI/CD and rollback)?
- Have we eliminated obsolete BotMerzz top-up/game business assumptions beyond cosmetic labels?
- Are business services and NDI Ticketing status truthful, approved and auditable?
- Does **every** published post have the active HTTPS CTA URL plus an appropriate contextual NDI invitation?
- Can admin manage categories and styles, and are initial eight/seven defaults idempotent?
- Is randomization **uniform**, independent, based on last **confirmed published category**, with zero/one category exceptions?
- Are AI category suggestions **approval-only** and periodic proposal scheduling initially disabled?
- Is website sync **only on admin button click**, reviewed per change, and protected from untrusted input?
- Are manual/admin-approved DB facts authoritative over website/AI proposals?
- Are historical data, admin credentials, production volume and image rollback compatibility safe?
- Were all test IDs evaluated and each requirement ID mapped to evidence, including the middle sections?
- Were there NO unapproved merges, deployments, real posts, scheduler activations or destructive actions?

**If any answer is no/unknown, state so and do not claim production-ready completion.**

---

## 13. IMPLEMENTATION INTERPRETATION GUARDS — MANDATORY BEFORE EACH PR

The following clarifiers do not change the owner's business choices. They prevent ambiguous technical shortcuts and map to existing R-IDs above.

1. **Source-of-truth audit (R-011, R-017, R-055, R-067–R-069):** Identify current DB schema, runtime settings precedence, configuration initialization, existing migrations, exact services/prompt context consumed by dispatch, and inactive/legacy business data. Prepare an explicit mapping of old configuration key → retain/replace/deprecate/migrate. Do not seed NDI facts only in `.env.example` or code while stale DB data continues to win. Preserve audit history as history and never feed it into current prompts.
2. **Compatibility and activation (R-004, R-007, R-009, R-045–R-053):** Distinguish 'scheduler currently OFF' from 'scheduler always OFF'; verify effective status through runtime DB, environment and operator controls. No migration may trigger an OFF→ON transition, posting on startup, or re-publication of uncertain slots. An existing ON state cannot be changed silently by a default/migration; stop for operator approval where behavior cannot be preserved safely.
3. **Two different HTTP destinations (R-035–R-040, R-057–R-060, R-072):** The CTA is an admin-editable HTTPS link and must never be used as the arbitrary crawl target. The website synchronization origin is fixed to approved `nusadataindonesia.com` pages, with redirect/DNS/SSRF restrictions. CTA changes do not trigger sync or outbound backend HTTP requests.
4. **Provider evidence (R-025, R-028–R-030, R-048–R-053):** Document whether Tebar supplies an authoritative publication timestamp, ordering sequence, or merely an outcome confirmation. If it cannot establish publication order, DO NOT manufacture one or bypass UNKNOWN reconciliation; demonstrate a conservative policy in deterministic tests and flag the unresolved capability for operator review prior to activation.
5. **No accidental feature creep (R-005, R-020–R-034, R-064–R-071):** No dashboard visual redesign, no new inference provider or external infrastructure, no changes to posting cadence, no auto-approval of AI category proposals, no autonomous web scraping, and no new retry policy. Additional DB tables/API/UI may be introduced only as necessary for agreed function.
6. **Data retention versus no legacy leakage (R-018, R-044, R-065–R-069):** Historical audit text may truthfully contain Kedai Merzz/top-up terminology. Do not rewrite immutable history to make a global string search pass. Instead prove old data is not in active UI business controls, generator prompts, current facts, CTA or new output. Include UI and backend tests.
7. **Proposal timer versus posting scheduler (R-032–R-034, R-047):** Category proposal generation may be periodic only after explicit admin enablement, runs independently of Threads publication cadence, and can never auto-approve or change published facts. Its frequency, cost/budget bounds, notification behavior, and failure isolation must be visible and testable; choose safe defaults documented for review.
8. **Review criteria and reporting (R-001–R-073):** Track all 73 requirement IDs across A/B/C; at each phase report status of applicable IDs, cross-phase invariants, and later-phase IDs as PLANNED (not DONE). Distinguish local tests, GitHub CI results, and actual production checks. The operator must explicitly authorize each merge; auto-deploy then follows existing GitHub settings.

### Explicitly unresolved implementation details — discover, do not guess

- Tebar's actual provider-confirmation evidence and its ability to order delayed publications.
- Effective database-backed production configuration that currently wins over `.env`/defaults.
- The migration-safe representation of archived business facts and any current provider references.
- The current system's exact restart/rollback migration compatibility envelope.
- The operational rate limit and interval supported for AI category proposals (admin-configurable, default OFF).

Record each discovery, supported evidence, chosen implementation, and blocker in the audit/traceability deliverables before declaring a phase ready.
