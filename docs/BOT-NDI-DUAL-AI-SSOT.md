# BOT NDI — Dual AI Conditional Revision & Unknown Continuation

**Status:** Approved product requirements; NOT an authorization to deploy.
**Version:** 1.0 — 2026-11-20 (Asia/Jakarta)
**Repository:** `Nusa-Data-Indonesia/bot-ndi`
**Owner:** Nusa Data Indonesia
**Scope:** Content validation/revision, configuration, scheduler behavior for `unknown`, monitoring, minimal mock-only tests.
**Out of scope:** UI redesign, Learning activation, changing providers, real external API tests, production edits/merge/deployment.

> **Instruction for implementers:** Read this entire document, including the IDs, examples, test matrix and reconciliation rules. It is the single source of truth (SSOT) **for this feature**. Existing production code and architecture documents remain authoritative for behaviors this document does not explicitly change. A requirement tagged `REPLACES` overrides the older decision cited. Do not silently infer missing business rules.

## 0. Reading map / anti-missing-in-the-middle

Read in order: (1) precedence and invariants; (2) explicit supersessions; (3) process state machines; (4) numbered requirements; (5) acceptance tests; (6) rollout gates. Before coding, produce a complete coverage matrix `DA-001`–`DA-054` and `DT-01`–`DT-25`, with implementation file, test/evidence, and status per ID. After every implementation checkpoint, re-read **all** IDs and update the matrix. No feature is DONE merely because files exist. Do not omit the middle sections or replace this SSOT with a condensed summary.

### 0.1 Priority and conflicts

1. This document governs **new Dual AI functionality and the explicitly changed `unknown` policy**.
2. Existing application guarantees for authentication, provider idempotency, slot claiming, migrations, rollback, CI/CD, CTA, brand claims, admin-approved knowledge, and emergency pause remain in force unless this SSOT clearly overrides them.
3. Deterministic guardrails, database invariants, and publication safety always supersede model output. AI cannot authorize posting or bypass a guardrail.
4. If this document conflicts with an existing test or schema, document the conflict and make the smallest safe update. If the resolution would permit duplicate external publication, bypass emergency pause, lose data, or require external authority, stop that portion and request operator direction.
5. Never assume that production credentials, deployment authorization, or live provider access are available.

### 0.2 Explicitly superseded interview decisions

| Earlier decision | New binding decision |
|---|---|
| Every generated post must be reviewed by AI 2 | **REPLACES:** Invoke AI Reviewer **only** when deterministic content validation fails and the failure is repairable. Valid content never invokes Reviewer. |
| Any `unknown` publishing outcome blocks all future slots until manual resolution | **REPLACES:** Keep ambiguous slot immutable/non-retried while permitting **new distinct scheduled slots** at the normal admin-defined interval. Existing emergency pause and other safety locks remain authoritative. |
| No tests of Dual AI; operator tests directly | **REPLACES:** Minimal **mock-only** automated regression tests are required. Operator alone performs optional real-world provider and content-quality verification after explicit activation. |
| Review result as publication status | **CLARIFICATION:** `reviewed` is an independent process label, **never** a replacement for `published`, `failed`, or `unknown`. |

## 1. Production baseline and non-negotiable invariants

- Current topology: Proxmox `mamay`, LXC `10030` (`ndi-bot`), Debian 13, `192.168.0.30`; Docker Compose app + MySQL 8.4; app `/opt/bot-ndi`; gateway LXC `10080` Traefik + Cloudflare Tunnel; public domain `https://botndi.sequein.my.id`.
- GitHub Actions self-hosted runner resides inside LXC 10030; CI and automatic deployment from `main`; build local Docker images **without GHCR**. **Never merge to `main` during this task.**
- `EXTERNAL_INTEGRATIONS_ENABLED` and `SCHEDULER_ENABLED` must not be switched by this implementation or tests. Do not touch production `.env`, secrets, Docker volumes, Cloudflare, runner, or gateway.
- Existing service knowledge remains sourced from admin-approved NDI database information. NDI website sync only by admin button and per-change approval; never poll the website automatically. CTA URL remains admin-editable valid HTTPS and is independent of the fixed official website sync target.
- NDI branding: Indonesian-language B2B-oriented educational, consultative content; no fabricated clients, testimonials, pricing, metrics, project outcomes, or unverified services. NDI Ticketing remains an in-development portfolio/pilot, not a launched product. Illustrative scenarios must be labeled.
- Keep eight admin-managed content categories, seven admin-managed styles, independent balanced random selection, exclusion of most recent **provider-confirmed successful** category when 2+ categories are active, one-category exception, and stop-and-notify when no active category. Also stop and notify when zero active styles.
- Keep existing CTA requirement on **every** post and the exact configured official/marketing HTTPS URL; never modify CTA or content silently after final validation.
- Keep deterministic validators, current provider publishing retry/idempotency model, admin controls, event history, scheduler/slot ownership and transactional locking, Telegram notification mechanism, and emergency pause.
- `SCHEDULER_INTERVAL_SECONDS` is poll frequency, **not** the admin's interval between posts. New slot scheduling must use the persisted admin-defined timetable; an `unknown` at 12:00 with hourly cadence means next eligible slot 13:00, not 15:00 or immediately.
- Existing Learning feature flags remain untouched and disabled unless separately authorized. Backup is manual by operator; do not introduce automatic backups.

## 2. Process and state models

### 2.1 Generation and repair (pre-provider only)

1. Scheduler/dispatcher atomically selects an eligible **new** slot, category, style and immutable effective configuration snapshot.
2. AI Generator makes **one normal content-generation attempt** as defined by existing logic. Do not alter existing general/provider retry counts without evidence and explicit approval.
3. Run existing deterministic content guardrails. Return structured machine-readable violations with stable codes, paths and safe descriptions. Classify into `repairable_content` vs `nonrepairable_configuration/system` (never let the model decide this classification).
4. **PASS:** skip AI Reviewer entirely; continue existing pre-publication checks and provider dispatch.
5. **FAIL repairable:** invoke AI Reviewer with original draft, all safe validation failures in one batch, chosen category/style, exact approved knowledge snapshot, contextual CTA, and explicit non-fabrication constraints.
6. AI Reviewer returns structured `{decision: PASS|REVISE|REJECT, revised_content?, rationale_code?}`. Treat decisions as *advisory*. `REJECT` is terminal for the content slot. For `PASS` or `REVISE`, a revised draft may be used **only after deterministic full revalidation**; `PASS` without valid content is a failure. Never publish unchecked output.
7. **Maximum two content-revision calls** to Reviewer for a single slot. Each result must be validated again. First successfully valid candidate proceeds to provider; exhausted/rejected candidates fail the slot and send a Telegram notification (notification failure cannot turn a failed slot into a successful one).
8. A malformed/empty/timeout Reviewer response gets **at most one technical retry for that failing call**; it must not introduce unlimited revision loops. Technical retry is distinguishable in telemetry from a substantive revision and is bounded independently. If still unavailable, fail closed and notify.
9. **Nonrepairable failure** (missing category/style, missing required approved facts, database failure, credentials/config error, unavailable provider, invalid config snapshot) must not be repaired by inventing data, and does not invoke Reviewer.
10. Reviewer may refine wording, hooks, CTA language and factual compliance but must preserve chosen category, style, theme and verified facts. If impossible, REJECT. System does not modify finalized text mechanically; all required edits go through Reviewer then full revalidation.
11. A provider-side publishing failure, timeout or `unknown` is **not** a validation failure and **must never** call Reviewer or regenerate that already-submitted slot.

### 2.2 Separate AI models and configuration

- AI Generator and Reviewer are **different model identifiers**, both served through the existing OpenRouter integration and API key. No extra provider/API key. Dashboard offers **two separate model selectors** and validates each against allowed model configuration (do not assume any particular model name exists).
- Reviewer configuration is **mandatory** before automation activation; Reviewer is not an admin-toggle feature. No silent fallback to Generator model. Treat missing/invalid/reused model identifiers as a configuration error before claiming/publishing work. Preserve existing dynamic configuration history, audit, optimistic concurrency, and reconciliation protections.
- Snapshot both models, category, style, approved knowledge version, CTA URL, and relevant generation rules at slot start. Mid-flight admin changes affect **subsequent** slots only. Do not expose secrets or model prompts in logs.
- Existing OpenRouter budget is controlled by operator externally; **do not add local per-post or daily cost caps**. Capture cost/token metadata only when provider exposes it safely; do not invent measurements or assume it is always provided.

### 2.3 Publishing `unknown` policy (explicit behavior change)

An `unknown` means a submission **may already have been published**. Its outcome is unresolved; it must not be treated as a definite failure or as success.

- Preserve the original slot and provider request identity, provider account/profile binding, dedupe/idempotency references, timestamps, and audit trail. **Never automatically re-submit, regenerate, or replace that same slot.**
- Immediately attempt a **short Telegram notification** with slot/time/status and safe dashboard reference. No tokens/secrets. Notification failure is logged safely and **does not pause the scheduler**.
- Reconcile automatically **only when existing provider APIs yield definitive verifiable evidence** of published or failed. If ambiguous, keep `unknown` and provide existing admin manual reconciliation (no guessing). Never close as `failed` merely due to timeout or age.
- Permit the **next distinct eligible scheduled slot** at the unchanged admin cadence despite previous `unknown`, including multiple unresolved unknowns. Do not launch an immediate replacement slot. Do not let this exception bypass emergency pause, account-switch fence, invalid configuration, active lease/transaction lock, or system-level shutdown.
- **Three unresolved/recorded `unknown` occurrences in a rolling 24-hour window** trigger a higher-priority Telegram warning. Scheduler keeps running. Deduplicate/throttle threshold alert per threshold crossing/window to avoid notification storms; record delivery attempts without exposing secrets. Define window boundaries in UTC in persistence, present Asia/Jakarta in UI.
- New slot selection may not accidentally reuse IDs, publish the same payload as an auto-retry, or overlap a running slot. Publish attempts remain once-per-slot under the proven existing atomic claim model.
- Keep account switch blocked while any related `unknown` awaits resolution, preserving the correct original provider identity for eventual reconciliation.
- For category anti-repeat, use the most recent *provider-confirmed published* category in actual provider publication order where determinable. `unknown` is not confirmed and should not advance the success pointer. Late confirmation may update this pointer in a transaction; if provider order is ambiguous, use documented stable fallback and do not fabricate ordering.
- Treat other statuses (definitively failed, canceled, emergency paused, external integrations disabled) with their existing policy; this feature **does not** authorize bypassing those rules.

### 2.4 Slot duration and concurrency

- Allow at most one active processing/publishing operation per logical slot; prevent duplicate concurrent claims across scheduler ticks, restarts and manual invocation.
- If the next scheduled time arrives while an earlier slot is still running, do not process the same slot twice. Preserve/extend existing lease and missed-slot semantics; if an unavoidable policy choice arises (skip vs delay vs catch-up), **do not invent** it—document existing behavior and request operator decision before altering it.
- A content-validation failure consumes its current slot and normally allows the **next scheduled slot**, not an immediate compensating publication. Telegram notification failure must not block future schedules.

## 3. Requirement register (all IDs mandatory)

### 3.1 Generation / validation

| ID | Acceptance requirement |
|---|---|
| DA-001 | All content begins with the existing category/style selection and Generator pipeline. |
| DA-002 | Deterministic validation occurs before any content is sent to Tebar. |
| DA-003 | A valid Generator draft **never** calls Reviewer. |
| DA-004 | A repairable validation failure invokes Reviewer with the entire structured error set. |
| DA-005 | Nonrepairable system/configuration/provider errors never invoke Reviewer. |
| DA-006 | Reviewer uses same authoritative approved knowledge snapshot as Generator. |
| DA-007 | Reviewer preserves original category, style, theme and verified NDI facts. |
| DA-008 | Reviewer corrects unverified claims or returns REJECT, never inventing facts. |
| DA-009 | Reviewer supports PASS, REVISE, REJECT with strict schema validation. |
| DA-010 | Any Reviewer candidate must pass **all** deterministic guards again; AI verdict cannot override them. |
| DA-011 | Maximum two substantive Reviewer calls/revisions per slot. |
| DA-012 | Maximum one technical retry per invalid/failed Reviewer call, with overall bound. |
| DA-013 | Exhausted/REJECT/reviewer unavailable produces failed content slot and safe notification. |
| DA-014 | Existing publishing, generator and provider retry counts are not silently changed. |
| DA-015 | Provider fail/timeout/unknown never invokes Reviewer or a new generation for same slot. |
| DA-016 | Final content includes required admin-configured HTTPS CTA and brand/claim compliance. |
| DA-017 | System cannot mechanically rewrite final content to force passage of checks. |

### 3.2 Configuration / dashboard

| ID | Acceptance requirement |
|---|---|
| DA-018 | Admin has separate Generator model and Reviewer model selectors. |
| DA-019 | Generator and Reviewer model IDs must differ; both use OpenRouter integration. |
| DA-020 | Missing/invalid Reviewer model blocks automation activation, with actionable admin message. |
| DA-021 | Reviewer is mandatory on validation failure and has no toggle. |
| DA-022 | Config writes retain effective DB authority, audit/version/history, and existing reconciliation protections. |
| DA-023 | Each slot snapshots models, category, style, CTA, knowledge and relevant settings. |
| DA-024 | Admin edits during processing apply only to future slots. |
| DA-025 | Existing dashboard layout is retained; no standalone Reviewer page or UI redesign. |
| DA-026 | Existing Riwayat & Catatan shows `reviewed` as a badge/flag separate from publication status. |
| DA-027 | Only a successful validation-fixing Reviewer revision receives `reviewed`, even if later Tebar status is failed/unknown; invalid/exhausted attempts are not mislabeled as successful revisions. |
| DA-028 | Successful posts keep minimal final content/review metadata; failures preserve sanitized full draft/attempt/validation history. |
| DA-029 | Zero active categories **or** zero active styles halts generation safely and notifies admin. |
| DA-030 | Provider usage/cost shown only if available; no invented values or local spend threshold. |

### 3.3 `unknown`, timing, reliability

| ID | Acceptance requirement |
|---|---|
| DA-031 | Unknown remains unresolved and does not represent confirmed published or failed. |
| DA-032 | An unknown original slot cannot be automatically retried, regenerated, republished or replaced. |
| DA-033 | A distinct next scheduled slot may proceed despite unrelated unknowns. |
| DA-034 | Admin-defined posting interval is unchanged; poll interval is not posting interval. |
| DA-035 | No immediate compensating post is created for unknown or failed content validation. |
| DA-036 | Short Telegram alert attempted for each newly unknown slot. |
| DA-037 | Telegram failure is logged but does not stop scheduler. |
| DA-038 | Definitive provider evidence permits automatic reconciliation; ambiguous status remains unknown for manual review. |
| DA-039 | Threshold of 3 unknown occurrences in rolling 24h triggers deduplicated extra Telegram alert, not pause. |
| DA-040 | Unknown state cannot bypass emergency pause, permissions, provider account switch fence, configuration checks or transaction locks. |
| DA-041 | Account changes stay blocked while related unknown slots are open. |
| DA-042 | Most recently provider-confirmed successful publication drives category exclusion; unknown never counts as confirmed. |
| DA-043 | Late provider confirmations update ordering consistently without violating uniqueness/fences. |
| DA-044 | A slot is claimed/processed at most once concurrently, including across restart. |
| DA-045 | Existing missed-slot/lease policy preserved unless operator resolves an explicit conflict. |

### 3.4 Security, tests, deployment

| ID | Acceptance requirement |
|---|---|
| DA-046 | All new DB schema changes additive, idempotent, safe with existing data and existing app rollback constraints documented. |
| DA-047 | No real OpenRouter key/request ever used for automated tests, including via inherited env. |
| DA-048 | All Tebar/Telegram/provider tests are mocked and deny network by default. |
| DA-049 | Test DB is disposable and never points to production; no reset/truncation of production DB/volume. |
| DA-050 | Minimal regression matrix DT-01–DT-25 executed with true PASS/FAIL/SKIP reporting. |
| DA-051 | Existing lint/typecheck/build/CI/Compose/migration tests remain passing (report pre-existing failures honestly). |
| DA-052 | Feature branch + PR; merge to main/deploy/scheduler changes require separate explicit operator authorization. |
| DA-053 | No secrets, raw tokens, full sensitive provider payloads or real API credentials in logs, history or CI. |
| DA-054 | Implementation tracker maps every DA and DT ID to files, tests and evidence; no unverified claim of completeness. |

## 4. Required tests — completely local/mock-only

**Hard constraint:** Do not use `OPENROUTER_API_KEY`, Tebar tokens or Telegram production secrets. Never source production `.env`. A mock must be injected explicitly. Reject accidental outbound provider requests using denied network adapters/test instrumentation. CI should only use synthetic fixtures and disposable MySQL. User will personally test live model quality/Threads after production rollout.

| Test | Scenario / expected outcome |
|---|---|
| DT-01 | Valid Generator draft: guardrail PASS, Reviewer invocation count = 0. |
| DT-02 | Invalid CTA/length: all violations batched to Reviewer, valid revision accepted only after final recheck. |
| DT-03 | Unverified claim: Reviewer removes unsupported statement, doesn't invent claims. |
| DT-04 | Category/style cannot be altered by Reviewer. |
| DT-05 | Reviewer returns PASS with invalid draft: validator still rejects. |
| DT-06 | Two consecutive invalid revisions: max two Reviewer calls, slot fails, never calls Tebar. |
| DT-07 | Reviewer explicit REJECT: immediate content failure, no publish. |
| DT-08 | Malformed/empty response: at most one technical retry and fail closed. |
| DT-09 | Reviewer timeout/API exception: bounded technical retry, no infinite loop. |
| DT-10 | Nonrepairable config/DB/provider failure never invokes Reviewer. |
| DT-11 | Provider failed/unknown after valid content never invokes Reviewer/re-generation. |
| DT-12 | Two independent configured models used correctly; same/missing Reviewer model blocks activation. |
| DT-13 | Mid-flight model update cannot mutate current slot snapshot. |
| DT-14 | `reviewed` badge appears only after successful revision; status published/failed/unknown remains independent. |
| DT-15 | Successful slot minimal metadata; failed slot retains sanitized full attempt history. |
| DT-16 | Zero active category/style fail closed and notify via mocked Telegram. |
| DT-17 | Unknown at 12:00, hourly admin interval: new slot at 13:00, not immediate or 15:00. |
| DT-18 | Unknown original slot never retried/submitted twice even across scheduler ticks/restarts. |
| DT-19 | Multiple unknowns don't pause future distinct slots; emergency pause still blocks. |
| DT-20 | Provider definitive confirmation reconciles; ambiguous response remains unknown. |
| DT-21 | 3 unknowns rolling 24h triggers one throttled extra alert and scheduler stays enabled. |
| DT-22 | Telegram send failure doesn't block new slots or trigger resubmission. |
| DT-23 | Unknown binds to original Tebar account; account switch fence enforced. |
| DT-24 | Category nonrepeat considers confirmed published order, including late confirmations, not unknown slot. |
| DT-25 | Concurrent scheduler/dispatcher claims cannot process same slot twice; no live external HTTP calls and no prod DB. |

Where test quality depends on probabilistic AI, use deterministic synthetic outputs. Preserve existing browser, migration, CI, deployment and integration tests in addition to this minimal matrix. Do not label mocked provider tests as production provider verification.

## 5. Implementation constraints and staged checkpoints

### Checkpoint 0 — Preflight

Read `AGENTS.md` if present; read current `src/config.js`, `src/cli.js`, dispatch/scheduler/provider/validation/repository/server code, DB migrations, relevant frontend, docs and tests. Report existing baseline and current main/branch state. Investigate precise old `unknown` global-block mechanism and all entry points (scheduler, manual dispatch, reconcile, account switch). Do not assume documentation perfectly matches runtime. Inspect dirty worktree and preserve all user changes.

### Checkpoint 1 — State/data model and migration plan

Design minimal additive schema for model selection, immutable slot snapshot, review metadata and sanitized failure history, threshold-notification state if necessary. Do not replace effective DB config with `.env` after initialization. Demonstrate backward compatibility with existing production rows, rollback caveat, migration rerun safety and no credential exposure. Do not apply to production.

### Checkpoint 2 — Conditional Reviewer

Implement repairable error classification, model selection, structured Reviewer contract, bounded attempts, deterministic revalidation and labeling. Keep legacy retry semantics for Generator/provider, and no Reviewer after provider submission. Re-read `DA-001`–`DA-030` and `DT-01`–`DT-16` before marking done.

### Checkpoint 3 — `unknown` continuation

Implement safe separation between unresolved **old** slot and **new** future slot. Preserve idempotency, account fences, emergency pause and category confirmation ordering. Add immediate and threshold Telegram alerts with deduplication. Re-read `DA-031`–`DA-045` and `DT-17`–`DT-25`. Document any unsolved lease/missed-slot ambiguity as BLOCKED.

### Checkpoint 4 — Dashboard and evidence

Add two admin model dropdowns, separate `reviewed` marker to Riwayat & Catatan, safe error details and no redesign. Run test matrix with network denied; verify DB disposable only; CI and migration tests; update docs and traceability. Do not generate screenshots containing sensitive data.

### Checkpoint 5 — Review handoff, no deploy

Commit logical changes on a fresh feature branch; push/create PR only if normal repo authority and access are available. **Do not merge or deploy.** Summarize which settings operator must provide after merge (two different models), how to verify flags, suggested controlled live validation steps for operator, and failure/recovery limitations.

## 6. Mandatory reporting and handoff format

Maintain `docs/ndi-dual-ai-traceability.md` with **every** `DA-001`–`DA-054` and `DT-01`–`DT-25` (status `NOT_STARTED`, `IN_PROGRESS`, `VERIFIED`, `BLOCKED`, `WAIVED`), implementation reference, test output, and residual risk. State `VERIFIED` only for observed evidence; skipped tests remain `SKIPPED` in logs. At each checkpoint output brief progress and next checkpoint; keep this file persistent so context compaction does not lose work.

Final report must include: commit/PR; full coverage totals; phase-by-phase summary; actual PASS/FAIL/SKIP/NOT_RUN counts; migrations and rerun evidence; explicit *no live OpenRouter/Tebar/Telegram calls* attestation supported by test isolation evidence; unknown behavior, category ordering and fences; stale or pre-existing issues; required admin configuration; remaining production verification; and unambiguous GO/NO-GO for **PR review only**. Do not mark production as deployed/tested.

## 7. Rollout gate (operator-only, outside Codex task)

1. Operator reviews PR and CI, migration compatibility, credential/log safety and traceability.
2. Operator separately authorizes merge; `main` may auto-deploy into LXC 10030.
3. Operator separately verifies app/MySQL health, dashboard, both model configs, `reviewed` history, and status guards.
4. **No scheduler toggling and no live Threads post without explicit operator action.**
5. Operator performs optional real OpenRouter/Tebar/Telegram test using their own budget and approval; these tests are not to be performed by Codex.

### Final absolute stop conditions

**STOP and ask operator** if implementation requires: production data deletion/restore, `.env` access or real credentials, outbound provider testing, publication of a real post, disabling guardrails, bypassing admin approval, a changed model-provider contract, new paid services, ambiguous duplicate-post behavior, force push, merge, CI workflow deployment, or alteration of production infrastructure. Safe local coding, mocks, additive migrations on disposable DB and feature-branch PR preparation remain authorized *only when the user sends the separate execution prompt*.
