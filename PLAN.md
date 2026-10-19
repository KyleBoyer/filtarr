# Filtarr project plan

Filtarr is a self-hosted TypeScript application that organizes media through simple, ordered rules. As confirmed by the user, moving to a library means changing the root folder in Sonarr/Radarr with associated file movement performed by that application. Filtarr supplies the rule engine, an approachable web dashboard, previews, scheduled and manual execution, and a durable explanation of every decision and change.

This is a design plan, not an implemented application. The project directory was empty when inspected on October 18, 2026.

## 1. Product behavior and first-release scope

The primary user is a media-server owner who should be able to build a rule without writing code, understanding JSON, or learning a workflow diagram editor.

Ship these capabilities in the first release:

- Sign in with Plex; the installation owner has full access, and approved friends receive scoped permissions.
- Connect one or more Sonarr and Radarr instances using their URLs and API keys.
- Name destinations such as Kids and Regular and map them to existing root folders in each applicable instance.
- Create, duplicate, enable, disable, reorder, import, and export rules.
- Combine conditions using All, Any, and Not, with nested groups available under Advanced.
- Move media to a destination, add/remove Arr tags, and set monitored/unmonitored status.
- Stop processing subsequent rules for an item after a matching rule.
- Preview or run the enabled rule list, or explicitly preview/run one selected rule.
- Run on a schedule using approachable presets or an advanced cron expression.
- Inspect searchable execution history, per-item explanations, errors, and before/after values.

For v1, a movie or an entire TV series is the unit of organization. A series moves together; this is not episode-by-episode parental classification. Multiple Arr instances are supported as independent sources, but transferring ownership between instances is outside v1. Plex-only media that is not managed by an Arr instance is outside v1.

Defer deletion, arbitrary scripts, downloadable plugins, outbound webhooks, quality-profile changes, and Plex collection/label actions. The engine contracts must accommodate future actions without making these features prerequisites for launch.

### Starter: organize Kids and Regular

Provide a template that creates two ordinary, editable rules scoped to the selected Arr connections:

1. **Kids:** Match movies with US certification G or PG, or TV series with TV-Y, TV-Y7, TV-Y7-FV, or TV-G. Move to Kids, then stop processing further rules for that item.
2. **Everything else:** Match every remaining item in scope. Move to Regular, then stop processing further rules for that item.

TV-PG is excluded by default. The setup screen shows the exact included ratings and allows changes before enabling the rules. Do not present movie and TV certifications as one universal numeric scale.

Resolved unrated, missing, foreign/unrecognized, or ambiguous certifications go to Regular and receive a visible “Rating needs review” explanation. A temporary metadata request failure is different: if classification depends on the failed request, defer that item's routing rather than change its destination because a provider is offline.

Users can add exceptions above the template, for example “If tagged family-approved, move to Kids and stop.” The UI explains that placing a rule below a matching stop rule prevents it from running for that item.

Plex movie and TV libraries have distinct media types. Model Kids and Regular as logical Filtarr destinations, each with separate movie/TV root mappings per Arr instance. Typical Plex configuration is Kids Movies, Kids TV, Movies, and TV. These are exclusive destinations by default. Users create the actual root folders and Plex libraries in their respective apps; Filtarr discovers roots and guides configuration rather than provisioning storage.

## 2. Simple dashboard and setup

Use four primary navigation entries: **Rules, Media, Activity, Settings**. Put connection health and the next scheduled run near the main run controls instead of requiring a separate operational dashboard.

### First-run setup

1. Claim the installation using a one-time setup token supplied through the container environment or generated in the local startup output, then authenticate with Plex. Atomically bind the installation owner to that Plex account ID and close setup.
2. Add Sonarr/Radarr connections. Test authentication, inspect version/capabilities, and discover roots and tags. Support reverse-proxy URL base paths.
3. Define Kids and Regular using root-folder dropdowns for each selected connection. Keep paths in the namespace seen by that Arr instance; Filtarr does not need media mounts.
4. Choose the US starter ratings, inspect a preview, and save the template. Saving does not run it.
5. Optionally enable a schedule. Default suggestion: daily at 03:00 in the explicitly displayed installation timezone. Automation remains disabled until enabled by the owner.

### Rule editor

Present a readable sentence: **When [conditions], then [actions]. Afterwards [continue / stop processing rules for this item].**

- Begin with one condition and one action. Use ordinary names such as Content rating, Genre, Release year, Destination, Tags, and Monitored.
- Offer “Match all” and “Match any” directly. Put nested groups, negation, and less common fields under Advanced.
- Include media type, source connection, title, certification, genre, year, current destination/root, tags, monitored status, file availability, date added, and series status in the initial field catalog.
- Only offer operators appropriate to the field. Distinguish content ratings from audience/critic scores; review-score filtering is a later extension.
- Update an explanation and sample matches from the current cached inventory. Label this as an estimate with its fetch time; a full Preview refreshes the required data.
- Provide Preview, Save, and an explicit Save and run now action. Do not execute merely because a rule is edited or enabled.
- New custom rules continue by default. The starter routing rules explicitly stop.
- Show rules in processing order with readable summaries, enabled switches, drag handles, and accessible Move up/Move down controls.

The main toolbar offers Preview all and Run now. A rule menu offers Preview this rule and Run only this rule; clearly explain that this bypasses the other rules. A schedule always runs the complete enabled ordered list, preserving stop behavior.

Preview groups items into Would change, Already correct, Needs review, and Blocked. Expand a title to see each condition result, matched rules, skipped rules, metadata provenance, and final planned changes. Display destination conflicts resolved by later rules rather than silently hiding them.

Build a responsive, keyboard-accessible interface with plain-language errors and persistent feedback for long-running jobs. Use a focused list-and-detail layout rather than a node graph.

## 3. Architecture and engine contracts

Use a pnpm workspace with strict TypeScript throughout:

| Component | Choice |
| --- | --- |
| Web application | React, Vite, React Router, TanStack Query, Tailwind CSS, accessible Radix primitives |
| API and background worker | Node.js 24 LTS, Fastify, Zod validation, Pino logging |
| Persistence | SQLite with Drizzle migrations; WAL mode on a local persistent config volume |
| Scheduling | Croner for timezone-aware five-field cron calculation; SQLite-backed durable job records |
| Testing | Vitest for engine/adapters, Playwright for browser workflows |
| Distribution | One Docker image serving the UI/API and an embedded worker; Docker Compose example |

Choose and pin compatible stable library versions when scaffolding. Deploy one Filtarr replica per database; Redis, PostgreSQL, and a separate queue service are unnecessary for the initial installation model.

Separate the workspace into web, server, engine, integrations, and shared contracts. The engine is a headless package with no React, database, network, clock, or credential dependency. API, worker, and future clients use the same evaluator.

### Core interfaces

- **MediaItem:** Composite identity `(connectionId, mediaType, upstreamId)`, external IDs, normalized rule fields, observed upstream state, and metadata provenance. Identical titles or external IDs across connections remain distinct managed items.
- **Condition:** Versioned, validated discriminated union of predicates and `all`, `any`, and `not` groups. Field definitions declare value type, operators, applicability, and UI labels.
- **Rule:** Stable ID, creator attribution, editable draft, immutable published revisions, enabled state, order, scope, condition tree, ordered action definitions, and `stopProcessing`.
- **Destination:** Friendly name and a root-folder mapping per connection/media type. Missing mappings block affected actions rather than choosing a fallback path.
- **ActionDefinition:** Versioned action type plus validated configuration. Built-ins are move-to-destination, add-tags, remove-tags, and set-monitored.
- **ActionHandler:** Configuration schema, capabilities, pure planning/projected-state behavior, execution, and reconciliation. Required metadata is declared so it can be fetched before evaluation.
- **MetadataProvider:** Supported fields, external-ID resolution, retrieval, normalization, provenance, and cache policy.
- **ExecutionPlan:** Frozen rule revisions and input fingerprints, per-item evaluation traces, proposed final changes, action prerequisites, and blocking issues.
- **Run / ActionAttempt:** Trigger, mode, actor, plan reference, progress, timestamps, before/after state, outcome, and retry/reconciliation history.

Maintain registries for fields, actions, and metadata providers. New integrations should register schemas and handlers without modifying the evaluator. Ship trusted, built-in implementations initially; do not execute user-supplied JavaScript. Rule sharing uses versioned JSON with named destination/connection references that must be rebound on import. Never export credentials or enable imported rules automatically.

Expose a versioned REST API with an OpenAPI description for connections/tests, destination mappings, rule drafts/revisions/reordering, media queries, previews, run creation/status/cancellation, schedules, people/access, tokens, activity, and metrics. Bundle Swagger UI at `/api/docs` and the specification at `/api/openapi.json`. Use server-sent events for live run progress. Run creation accepts mode, all-enabled versus selected-rule scope, and an optional preview reference; it returns a durable run ID. Browser mutations require the authenticated session and CSRF protection. Programmatic clients use scoped Filtarr bearer tokens.

### Deterministic rule semantics

- Capture the enabled ordered rule revisions and a normalized media snapshot at run start.
- Evaluate each item from top to bottom. Conditions operate on projected state: a tag added by an earlier matching rule is visible to later rules in the same evaluation.
- Condition results are true, false, or unknown. Missing data does not make a negated predicate true; provide explicit “is missing” predicates. Only true matches trigger actions. A required lookup failure blocks dependent routing; resolved absence can reach the starter Regular fallback.
- A matching stop rule stops evaluation for that item even if its desired state is already satisfied. It does not stop the entire run. Failure to apply that rule later does not activate fallback rules.
- For v1 state-setting actions, compile the projected result into net changes. The last matching assignment wins for destination and monitoring; tag operations apply in rule/action order. Keep provenance of superseded changes in the trace. Perform at most one physical move per item per run.
- Preflight an item's complete final change set before applying it. A missing destination or unsupported action blocks that item. Other valid items continue.
- Repeated runs against unchanged state produce no additional mutations. Show rule combinations that repeatedly disagree across runs in history; do not claim arbitrary user rules always converge.

## 4. Integrations, execution safety, and history

### Sonarr and Radarr

Use their v3 APIs with API keys held only on the server. At setup, inspect version and required capabilities. Establish the supported release matrix through contract tests against stable upstream versions before release; do not assume every version with a v3 route behaves identically.

List media, root folders, and tags; normalize certification separately from audience/critic ratings. Resolve current roots with path-boundary-aware matching when the resource does not provide a usable root. Respect Windows and POSIX path syntax independently of the Filtarr host OS.

Use editor/update operations supported by each tested adapter to request root-folder moves with file movement enabled. Send one item's operation at a time for accurate attribution. Use narrow changes that preserve unrelated settings. Tags use add/remove semantics rather than replacing the user's entire set. Series monitoring changes the series-level flag, not every episode/season flag.

Arr performs the actual file move. Filtarr must not rename or copy media itself. A successful HTTP response means submitted, not finished: reconcile command status when available, media paths, pending paths, and file records before marking a move verified. When upstream evidence is insufficient, show Unverified / needs reconciliation. Defer items with a known import or move in progress.

Titles without downloaded files can still have their destination updated for future imports; report “Destination updated; no files to move.” Preserve the source adapter's naming behavior. Validate roots and known collisions before submission, while reporting that a preview cannot prove future disk permissions or available space.

### Content-rating metadata

Start with native Arr certification, which both resource models expose. Store raw value, normalized value, rating system/region, source, and retrieval time. Configure the expected rating region for each connection; never infer a foreign certification's age equivalence from its text alone.

Support optional TMDB enrichment in v1 using the owner's API credential. Fetch movie release certifications and TV content ratings by external ID, using an ID lookup when necessary. Do not silently identify media by title alone.

Default precedence is an explicit local item override, then a usable native Arr certification, then TMDB fallback. Show the selected source. For fallback movie results, use the most restrictive recognized certification for the configured region when several releases differ; contradictory/unmappable results remain ambiguous. Allow provider order configuration without building a provider marketplace.

Cache successful metadata for seven days and missing results for one day, keyed by provider, external ID, field, and region. Provide Refresh metadata; honor rate limits and bounded retries. A failed lookup may use an unexpired successful cache entry, otherwise remains a lookup error. Additional providers implement the same contract.

### Plex authentication and library updates

Implement Plex's hosted PIN sign-in flow, preferring its documented JWT/device-key mechanism. Keep PIN state bound to a short-lived server-side login attempt, verify the returned account server-side, and issue a separate opaque Filtarr session cookie. Plex credentials and tokens never enter frontend storage or logs.

Use a fixed configured public callback origin, safe return paths, HttpOnly/SameSite cookies, Secure cookies on HTTPS deployments, CSRF protection, and login rate limits. Encrypt integration secrets and retained Plex credentials with an installation key supplied through a Docker secret or environment variable. Store sessions server-side, expire them after seven days, and support logout/revocation. Backups require both the database and installation key.

Friends can join through an owner-approved access request or an expiring invitation. Viewer, Editor, and Operator presets supply editable grants scoped to rules, source connections/root folders, and destinations. Editing a draft is distinct from publishing it for live automation. The owner remains the only account with unrestricted access and manages grants, integration credentials, schedules, and global rule order. Merely having a Plex account or access to a shared Plex server does not authorize Filtarr access; parental viewing restrictions remain managed in Plex.

API tokens are user-owned, shown once, stored only as hashes, scoped to a fixed ceiling, and checked against the user's current permissions on every request. Token creation requires a Plex session; tokens cannot create further tokens or administer access. Runs and audit records identify both the user and any token used.

Plex server access is optional beyond login. If enabled, allow selection of an owned server and existing library sections, with explicit Arr-to-Plex path mappings where container paths differ. After verified moves, debounce scans for affected sections. Record scan failures separately from successful moves. Do not empty Plex trash or alter sharing settings automatically. Filtarr can verify Arr movement and request a Plex scan; that is distinct from proving Plex has finished indexing.

### Preview, scheduling, and recovery

- Preview uses the same planner as live execution. It may perform reads, metadata lookups, and local history/cache writes, but must never invoke upstream mutation methods, scans, or tag creation.
- Applying a preview rechecks rule revisions and relevant live item state. If they changed, mark the affected work stale and require a refreshed preview; never apply a different plan under the old preview. Run now explicitly builds a fresh plan and executes it.
- Persist plans and action intents before sending mutations. Use one global apply worker, per-item reservations, and idempotency keys for Filtarr job submission. Read-only previews may run concurrently.
- Apply an item's move first, verify it, then apply its remaining net tag/monitoring changes. If an action fails or is uncertain, stop subsequent actions for that item and continue with independent items. Report partial outcomes without implying an atomic transaction or automatic rollback.
- After a timeout or restart, reconcile upstream state before retrying a write. Arr APIs do not provide a general exactly-once guarantee. Do not blindly repeat an uncertain move; unresolved items stay reserved for reconciliation.
- Retry transient read failures with bounded exponential backoff and honor Retry-After. Surface invalid keys, inaccessible roots, and persistent validation failures as actionable errors.
- Manual and cron triggers use the same queue and planner. While a full run is active, coalesce repeated scheduled triggers into at most one pending run. Manual requests remain visible as queued jobs.
- Store schedule timezone and the next UTC due time. Show the next five occurrences. For local daylight-saving transitions, skip nonexistent times and run repeated local times once. Test those semantics explicitly.
- After downtime, enqueue one catch-up run per enabled schedule rather than replaying every missed tick. Saving a rule never changes the schedule or starts a run.
- Cancellation stops new actions. An upstream move already submitted may finish; continue reconciliation and display its actual outcome.

### Logs and audit history

Keep operational logs separate from user-facing activity. Pino emits structured, rotated/redacted operational logs. SQLite keeps durable run/action records with actor, manual/cron trigger, preview/live mode, rule revisions, match explanations, metadata source, before/after values, upstream request correlation where available, timestamps, and outcome.

Use explicit statuses such as planned, submitted, verified, already-correct, blocked, failed, uncertain, and cancelled. Allow filtering by title, rule, connection, time, and outcome, plus JSON/CSV export. Never log API keys, Plex tokens, session cookies, or authorization headers.

Default retention: 365 days for security/configuration audit and daily metrics, 90 days for detailed completed run history, and 14 days for operational logs. Do not prune unresolved operations. Record rule/configuration changes with secrets omitted. Supply a supported consistent SQLite backup/restore procedure and apply schema migrations on startup after making a backup.

## 5. Delivery milestones and acceptance tests

### Milestone 1: foundation and read-only inventory

Scaffold the workspace, Docker distribution, database/migrations, Plex setup/login, Arr connection testing, inventory normalization, and destination configuration. Demonstrate authenticated browsing of movies and series from multiple instances with no media mutations.

### Milestone 2: engine and preview experience

Implement the headless evaluator, registry contracts, rule CRUD/order, starter template, advanced condition groups, metadata fallback, and explanations. Demonstrate that a saved rule can be exported/imported and produces a deterministic preview.

### Milestone 3: execution and operations

Add move/tag/monitoring handlers, persistent jobs, reconciliation, manual runs, cron presets, cancellation, activity, and optional Plex scans. Prove restart recovery before enabling automated live runs.

### Milestone 4: release validation and onboarding

Test supported upstream versions using disposable media fixtures and isolated Arr/Plex test libraries. Finish accessibility, errors, setup documentation, upgrades/backups, provider attribution requirements, and a Docker Compose example. CI runs type checking, linting, unit/contract tests, browser tests, and the production build.

### Required acceptance scenarios

- G/PG movies and the selected TV ratings route to Kids; PG-13/R/TV-PG/TV-14/TV-MA route to Regular. Unrated and ambiguous items have an explicit explanation. A failed required metadata lookup defers routing.
- TV/movie rating namespaces, region mismatch, native metadata, TMDB fallback, cache expiry, multiple certifications, and manual overrides behave as specified.
- All/Any/Not, unknown values, nested groups, scope, rule order, projected tags, stop-on-match, already-correct stop rules, and last-assignment resolution produce deterministic traces.
- Running all rules honors earlier exceptions. Running one rule intentionally ignores other rules and identifies that scope in its preview/history.
- Dry runs cause zero upstream mutation calls, including scans and tag creation. Their proposed net changes match live planning for identical inputs.
- Successful moves update Arr paths and retain managed media. A second run performs zero redundant changes. Missing files update future destinations without claiming a file move.
- Missing mappings, removed roots, path syntax differences, failed moves, target collisions, concurrent imports, invalid credentials, 429s, timeouts, and unreachable providers do not produce false success.
- Duplicate submissions, overlapping cron/manual runs, stale previews, crashes before/after upstream acceptance, and partial action failures preserve recoverable audit records without blindly repeating moves.
- Cron timezone/DST behavior, downtime catch-up, cancellation, and restart recovery match the documented rules.
- Plex callback tampering, expired PINs, unauthorized accounts, setup races, CSRF, and credential leakage are covered by authentication/security tests.
- Browser tests cover setup → template → preview → apply → history; custom grouped rules; ordering; single-rule runs; and keyboard interaction.

### Defaults and boundaries

Confirmed: moving to a library changes the root folder in Sonarr/Radarr and requests associated file movement through that application. Confirmed collaboration choices are rules-and-library scoping, separate publishing permission, both invitations and access requests, Filtarr API tokens, and bundled Swagger documentation. Other initial product choices remain defaults rather than confirmed user decisions: exclusive Kids/Regular library membership; US movie G/PG and TV-Y/TV-Y7/TV-Y7-FV/TV-G; moves, tags, and monitoring as initial actions; a single-instance self-hosted Docker deployment; and no automatic live execution during setup.

## Reference material checked during planning

- [Sonarr API](https://sonarr.tv/docs/api/), [series resource](https://github.com/Sonarr/Sonarr/blob/develop/src/Sonarr.Api.V3/Series/SeriesResource.cs), and [series editor](https://github.com/Sonarr/Sonarr/blob/develop/src/Sonarr.Api.V3/Series/SeriesEditorController.cs): native certification and root/tag/monitoring update behavior.
- [Radarr movie resource](https://github.com/Radarr/Radarr/blob/develop/src/Radarr.Api.V3/Movies/MovieResource.cs) and [movie editor](https://github.com/Radarr/Radarr/blob/develop/src/Radarr.Api.V3/Movies/MovieEditorController.cs): certification and queued file-move behavior.
- [Plex authentication documentation](https://developer.plex.tv/pms/) and [hosted PIN sign-in explanation](https://forums.plex.tv/t/authenticating-with-plex/609370): hosted authentication rather than collecting Plex passwords.
- [Plex library creation](https://support.plex.tv/articles/200288926-creating-libraries/): library types and folder mappings.
- [TMDB movie release dates](https://developer.themoviedb.org/reference/movie-release-dates) and [TV content ratings](https://developer.themoviedb.org/reference/tv-series-content-ratings): optional regional certification enrichment.

Upstream develop-branch source confirms current implementation direction; release compatibility must be established against pinned supported versions during implementation.
