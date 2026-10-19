# Filtarr

Filtarr is a self-hosted media rule engine. It reads movies from Radarr and series from Sonarr, evaluates ordered rules, and asks those applications to change root folders and move their managed files. The app includes Plex sign-in, scoped access, previews, runs, schedules, activity history, API tokens, and an interactive Swagger page.

## Start with Docker

1. Optionally create `.env` in this directory to set `FILTARR_PUBLIC_URL`. Filtarr uses whatever address the browser used (localhost, a LAN IP, or a hostname), so this is only needed behind a TLS-terminating reverse proxy; set it to the public `https://` origin there and enable `FILTARR_TRUST_PROXY=true`. On first start, Filtarr generates a random encryption key and stores it next to the SQLite database in the persistent config volume.
2. Run `docker compose up --build -d`.
3. Read the one-time setup token with `docker compose logs filtarr`. Open the configured public URL, enter that token, and sign in with Plex. The first verified Plex account becomes the owner.
4. In Settings, connect Radarr and Sonarr with their API keys. Configure their existing root folders as Filtarr destinations. Create Kids and Regular destinations, then generate the editable starter rules.
5. Preview before publishing and enabling rules. Schedules start paused.

### Prebuilt image

GitHub Actions tests every push, boots the image as a smoke test, and publishes `ghcr.io/kyleboyer/filtarr` for `linux/amd64` and `linux/arm64` (`latest` from `main`, plus `sha-…` and version tags). To use it instead of building, replace `build: .` in `compose.yaml` with `image: ghcr.io/kyleboyer/filtarr:latest`.

### Unraid

`unraid/filtarr.xml` is a Community Applications template. Until Filtarr is listed in Apps, add it by hand: in Unraid, go to Docker → Add Container, paste `https://raw.githubusercontent.com/KyleBoyer/filtarr/main/unraid/filtarr.xml` into Template, and apply. It stores everything in `/mnt/user/appdata/filtarr` and runs as `nobody:users` (PUID 99, PGID 100). The container takes ownership of the config folder on start, so an existing `filtarr.db` and `filtarr.db.key` can be copied in as-is. Find the first-run setup token in the container's log.

Every image also accepts `PUID`, `PGID` and `UMASK` (default 1000:1000).

### Reusing an existing database

Everything Filtarr stores lives in `/config`: `filtarr.db` and `filtarr.db.key`, the key that decrypts saved API keys and tokens. To move a `pnpm dev` install (`packages/server/data/`) into Docker, stop it, then copy both files into the config volume or a bind-mounted folder. The container fixes the folder's ownership for its `PUID`/`PGID` on start. Keep the `.key` file with the database: without it, saved Sonarr, Radarr, Plex and TMDB credentials can't be read. Only run one Filtarr against a database at a time, or enabled schedules run twice.

The Plex account sign-in leaves Filtarr for Plex's hosted authentication page. HTTPS is recommended when accessing Filtarr outside a trusted local network. Configure a reverse proxy and set `FILTARR_PUBLIC_URL` to its public origin.

## Exposing Filtarr to the internet

- Run the production build (Docker image, or `pnpm build` then `FILTARR_WEB_DIST=packages/web/dist pnpm start`). Never expose `pnpm dev`: the Vite dev server is not hardened.
- Put it behind a reverse proxy that terminates HTTPS, set `FILTARR_PUBLIC_URL=https://your.host`, and set `FILTARR_TRUST_PROXY=true` so rate limits see real client IPs. Do not set `FILTARR_TRUST_PROXY` when clients can reach Filtarr directly, or they can spoof their IP.
- Only expose the proxy. Keep port 3000/3001 and your Sonarr, Radarr, and Plex APIs off the internet.
- Anyone with a Plex account can sign in and request access; they see nothing until you approve them. Approve only people you know.
- Plex sign-in uses Plex's PIN flow: only approve a Plex "Filtarr" sign-in prompt that you started yourself from your Filtarr page. Each sign-in is recorded in Activity with its IP address.

## Local development

Use Node.js 24+ and pnpm 10. Run `pnpm install` and then `pnpm dev`; no `.env` file is needed for the default local setup. The browser app is at `http://localhost:3000`, and Fastify listens on port 3001. Both use the same Plex callback origin through Vite's local proxy.

`FILTARR_SECRET_KEY` is an optional 64-character hexadecimal override. Filtarr uses it to encrypt saved Sonarr/Radarr API keys and the optional TMDB token. Without the override, it creates `<FILTARR_DB>.key` with file permissions `0600` and reuses it on later starts. Back up the key file together with the database. If the key is missing while encrypted credentials exist, startup stops with a recovery message; Filtarr will not generate a replacement that cannot decrypt them. You can set `FILTARR_SECRET_FILE` to choose another persistent key-file path. If you supply an environment key while a key file exists, they must match.

Run `pnpm typecheck`, `pnpm test`, and `pnpm build` before a release. The SQLite database defaults to `./data/filtarr.db` relative to the server working directory for local development.

## Rules and runs

Rules have drafts and published revisions. Editing a draft never changes what a schedule runs. The owner or a user with publishing rights must publish and enable it. Rules are evaluated in order, with an optional “stop processing” switch per rule. A preview reads metadata and proposes changes without calling Arr mutation endpoints. Live runs submit moves through Sonarr/Radarr and record verification separately from submission. After a restart, interrupted actions are marked uncertain for inspection instead of being blindly resubmitted.

The starter template sends G/PG movies and TV-Y/TV-Y7/TV-Y7-FV/TV-G series to Kids; the following fallback routes other known ratings to Regular. When required metadata lookup fails, affected items are blocked from moving. TV series move as a whole.

## API

The versioned API is under `/api/v1`. Interactive documentation is at `/api/docs`; the machine-readable specification is at `/api/openapi.json`. An admitted Plex user can open the Swagger page. Programmatic clients use a Filtarr API token in `Authorization: Bearer filtarr_<id>_<secret>`. Create, replace, and revoke tokens in Settings. A replacement leaves the old token active until you revoke it after updating your integration. The raw secret appears only once.

Example after creating a token:

```sh
curl -H "Authorization: Bearer $FILTARR_API_TOKEN" http://localhost:3000/api/v1/rules
```

Use `Idempotency-Key` when submitting previews or runs. A run submission returns a status URL. Swagger's “Try it out” uses the token entered with Authorize.

## Operational notes

- Filtarr never copies media itself. Sonarr/Radarr must see and be able to write both source and destination root folders.
- Movie and TV destinations are separate root-folder mappings because Plex treats movies and TV as separate library types.
- Optional TMDB enrichment can be configured under Settings → Connections with a TMDB API read access token.
- A submitted move can be accepted by Arr and still take time or fail later. Inspect Activity for uncertain operations. There is no automatic rollback.
- Keep one running Filtarr replica per SQLite database. Store the config volume on a filesystem suitable for SQLite and back it up consistently.
- This initial release does not create Plex libraries, scan Plex automatically, transfer titles between Arr instances, or delete media files.

See [PLAN.md](PLAN.md) for the full product design and proposed future extensions.
