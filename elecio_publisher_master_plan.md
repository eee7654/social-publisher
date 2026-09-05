# ElecIO Publisher — Master Implementation Plan & Codex Prompts

> Scope: Backend-first, local development on Windows, later native Linux deployment without Docker.
>
> Current Core: existing Esima Core codebase (JavaScript ESM) using Ultimate Express, MySQL/mysql2, Knex, Objection.js, Better Auth, CASL/ABAC, multi-organization support, next-connect routers.
>
> Product targets: Instagram, YouTube, Aparat, Bale, LinkedIn Company Page, Telegram Channel.
>
> Messaging/job transport: NATS + JetStream.
>
> Asset storage: S3-compatible interface, MinIO AIStor first implementation.
>
> Media processing: ffprobe/FFmpeg.
>
> UI/panel: explicitly out of scope for these phases.

---

## 0. Locked Architecture Decisions

### Keep the current Core
Do not rewrite the existing auth/organization/ABAC stack.

Preserve:
- Ultimate Express
- `next-connect` routing
- Better Auth
- CASL/ABAC
- Organization hierarchy and memberships
- Objection.js models
- Knex migrations
- MySQL/mysql2
- ESM JavaScript style
- existing `/api/v1/...` convention where applicable

New publisher modules must be additive and modular.

### New components
- MySQL: durable source of truth
- NATS JetStream: job dispatch, worker delivery, domain events
- S3-compatible storage abstraction: MinIO AIStor locally and initially in production
- FFmpeg/ffprobe: media inspection and technical normalization
- Telegram Bot API: composer and channel source/target
- platform adapters:
  - Instagram
  - YouTube
  - Aparat
  - LinkedIn Company Page
  - Bale through the existing Python client
  - Telegram Channel

### No Redis / BullMQ
Do not add Redis unless a future measured requirement explicitly justifies it.

### No Docker
Local: native Windows binaries/processes.
Production: native Linux packages/binaries + systemd/PM2 as appropriate.

### No microservice explosion
One repository.
Processes may be split by responsibility, but modules stay in the same repository where possible.

Suggested runtime entries later:

```text
src/server.js                  # existing API
src/workers/publisher.js       # NATS publish worker(s)
src/workers/media.js           # ffprobe / FFmpeg jobs
src/workers/scheduler.js       # due retries / cleanup
src/bot/telegram.js            # Telegram update handler if run separately
```

Do not create separate services unless technically required.

---

# Critical Findings in the Existing Core

Before feature work, fix these without redesigning the Core.

## A. Secret hygiene

The supplied project archive contains a `.env`, and the sample environment file contains a real-looking database root password.

Actions:
- never commit `.env`
- scrub all real credentials from `env.sample`
- rotate any credential that has ever been committed/shared if it is live
- samples must use placeholders only

Do not print the actual secret in logs, commits, Codex output, or reports.

## B. Bootstrap admin password

`src/scripts/setup.js` currently contains a hard-coded weak default admin password.

Replace this with:
- `BOOTSTRAP_ADMIN_PASSWORD` from environment, or
- a cryptographically generated one-time password printed once only when explicitly requested

Never ship a known static default password.

## C. Multi-org environment mismatch

The current code checks:

```text
IS_MULTI_ORG
```

while the supplied `env.sample` contains:

```text
IS_MULTI_TENANT
```

Publisher development is multi-organization by design.

Canonicalize on:

```text
IS_MULTI_ORG=true
```

Do not maintain two flags for the same behavior.

## D. Existing `/storage`

`src/server.js` currently exposes a local static `/storage` directory.

Do not use this endpoint for Publisher assets.

Publisher media must use the S3-compatible storage abstraction.

Do not remove `/storage` yet unless usage is proven absent, to avoid breaking existing applications.

---

# Product Flow

## Private Telegram Bot composer

Primary user workflow:

```text
/newpost
   ↓
Upload video/media
   ↓
Upload cover (required for video campaigns)
   ↓
ffprobe analysis
   ↓
Automatic platform eligibility/recommendation
   ↓
Bot shows recommended targets
   ↓
User confirms/removes recommendations
   ↓
Bot asks only missing target-specific metadata
   ↓
Final review
   ↓
Publish
   ↓
Per-target status + permalink/result
```

The user does NOT initially choose targets manually.

The system detects recommended targets from:
- media type
- dimensions/aspect ratio
- duration
- codec/container
- currently connected platform accounts
- platform capability registry

User then confirms the recommendation.

## Telegram Channel as a source

A configured source channel is also supported.

When a post appears in a configured source channel:

```text
channel_post
   ↓
ingest media + caption
   ↓
create draft campaign
   ↓
analyze
   ↓
send review/target recommendation to authorized owner in private Bot chat
   ↓
owner confirms
   ↓
publish selected/recommended targets
```

Do not automatically blast a source-channel post to all platforms.

## Telegram Channel as a target

Telegram channels are also platform targets.

One organization may have:
- one or more Telegram source channels
- one or more Telegram target channels

Treat these as connections, not hard-coded IDs.

---

# Media Policy

## File size

MVP maximum upload asset size:

```text
300 MB hard limit
```

Default recommendation can be 250 MB, but reject anything over 300 MB.

This limit must be configuration-driven.

## Master asset

Store a single master asset once.

Multiple targets may reference the same `asset_id`.

Do not duplicate a 9:16 file just because it is sent to Instagram, YouTube Shorts, LinkedIn, etc.

## Variants

MVP does NOT perform intelligent reframing/cropping.

Allowed:
- container/codec normalization when technically required
- audio normalization if strictly necessary
- thumbnail metadata extraction

Not in MVP:
- smart crop
- AI reframing
- automatic 9:16 → 16:9 creative conversion
- background generation

If a target is incompatible with the master media, ask the user for a target-specific variant.

## Cover

For video campaigns, cover is required by the composer even if not every target consumes it.

Default:
- one campaign cover
- reused for compatible targets
- schema must allow future target-specific cover overrides

## Retention

- If all targets reach successful terminal states: delete campaign media objects after successful completion and required platform fetch/upload completion.
- If one or more targets failed/retry: retain media temporarily.
- Absolute maximum temporary media retention: 24 hours from campaign execution start.
- Cleanup worker must delete expired objects and local scratch files.
- Database metadata/result records remain.

The bot must warn before a retry is impossible because the source media has expired.

---

# Job Reliability Rules

MySQL is authoritative.

NATS is transport, not business state.

## Job states

```text
PENDING
VALIDATING
PREPARING_MEDIA
READY
QUEUED
UPLOADING
PROCESSING
PUBLISHING
PUBLISHED

RETRY_WAIT
AUTH_REQUIRED
RATE_LIMITED
MEDIA_INVALID
FAILED
CANCELLED
```

## Retry rules

- network timeout / transport error → retry
- platform 5xx → retry with exponential backoff
- 429 → respect Retry-After if supplied; otherwise platform-specific backoff
- 401/403 → AUTH_REQUIRED; no blind automatic retry
- deterministic validation 4xx → FAILED/MEDIA_INVALID
- ambiguous external publish response → resolve external state before retrying publish

Never blindly perform a second `publish` call after an ambiguous response.

## Retry implementation

For business retries:

1. Worker updates MySQL job:
   - `status=RETRY_WAIT`
   - `next_attempt_at`
   - `attempt_count`
   - sanitized error metadata
2. ACK the current NATS message.
3. Scheduler finds due retry jobs from MySQL.
4. Scheduler creates an outbox dispatch.
5. Outbox dispatcher sends to NATS.

Use JetStream redelivery primarily for worker/process crashes before ACK, not as the authoritative business retry clock.

## Idempotency

Use MySQL uniqueness + external IDs.

Each publish target needs an idempotency key such as:

```text
campaign:{campaign_id}:connection:{platform_connection_id}
```

Persist external identifiers early:
- Instagram container ID
- Instagram media ID
- YouTube video ID/upload session data where applicable
- LinkedIn upload/video/post URNs
- Aparat UID
- Telegram/Bale message IDs

---

# Suggested Database Domain

Exact migration details should be finalized by Codex after inspecting the existing model conventions.

## `platform_connections`

Fields conceptually:

```text
id
organization_id
platform
label
status
external_account_id
external_account_name
credential_payload_encrypted
credential_version
metadata_json
expires_at
last_verified_at
created_at
updated_at
```

Platforms:
- instagram
- youtube
- aparat
- linkedin
- bale
- telegram

## `telegram_channels`

```text
id
organization_id
platform_connection_id
chat_id
username
title
mode                # source | target | both
owner_user_id
is_active
created_at
updated_at
```

## `campaigns`

```text
id
organization_id
created_by
source_type          # telegram_private | telegram_channel | api
source_ref
status               # draft | ready | publishing | partial | published | failed
base_title
base_caption
cover_asset_id
created_at
updated_at
published_at
```

## `assets`

```text
id
organization_id
campaign_id
parent_asset_id
kind                 # video | image | cover | variant
object_key
original_filename
mime_type
size_bytes
sha256
width
height
duration_ms
fps
video_codec
audio_codec
aspect_ratio
probe_json
expires_at
created_at
updated_at
```

## `campaign_targets`

```text
id
campaign_id
platform_connection_id
platform
status
suggested_by_system
confirmed_by_user
asset_id
cover_asset_id
title_override
caption_override
settings_json
published_url
external_post_id
created_at
updated_at
```

## `publish_jobs`

```text
id
organization_id
campaign_target_id
idempotency_key
status
attempt_count
max_attempts
next_attempt_at
locked_at
last_error_code
last_error_message
external_stage
external_container_id
external_media_id
created_at
updated_at
completed_at
```

Unique:
```text
idempotency_key
```

## `publish_attempts`

Append-only sanitized attempt history.

## `outbox_events`

```text
id
organization_id
event_type
aggregate_type
aggregate_id
payload_json
status
attempt_count
available_at
dispatched_at
created_at
```

---

# NATS Subject Topology

## Job subjects

```text
jobs.media.probe
jobs.media.normalize

jobs.publish.instagram
jobs.publish.youtube
jobs.publish.aparat
jobs.publish.linkedin
jobs.publish.bale
jobs.publish.telegram

jobs.cleanup.assets
```

## Domain events

```text
events.campaign.created
events.campaign.ready

events.asset.ready

events.publish.started
events.publish.succeeded
events.publish.failed

events.connection.auth_required
```

Payloads must contain IDs/references only, not large full entities.

Example:

```json
{
  "jobId": 1291,
  "organizationId": 7,
  "campaignTargetId": 930
}
```

Workers fetch authoritative data from MySQL.

---

# Storage Interface

Use AWS S3-compatible SDK, not MinIO-specific business logic.

Recommended dependencies:

```text
@aws-sdk/client-s3
@aws-sdk/s3-request-presigner
```

Interface concept:

```js
putObject(...)
getObjectStream(...)
headObject(...)
deleteObject(...)
createSignedReadUrl(...)
createSignedUploadUrl(...)
```

MinIO-specific options (endpoint / forcePathStyle) belong only to the storage adapter configuration.

Object key format:

```text
org/{organizationId}/campaign/{campaignId}/master/{assetId}-{safeFilename}

org/{organizationId}/campaign/{campaignId}/cover/{assetId}-{safeFilename}

org/{organizationId}/campaign/{campaignId}/variant/{target}/{assetId}-{safeFilename}
```

Bucket must remain private.

---

# External Platform Preparation Checklist

These tasks can be done in parallel with backend development.

## Instagram — READY

For initial ElecIO development:
- keep current Meta System User approach
- `META_SYSTEM_USER_TOKEN`
- Facebook Page ID
- Instagram Professional Account ID
- Instagram username
- required permissions already verified

Do not implement public Instagram Login/OAuth onboarding yet.

Before general product launch:
- separate Meta public-app onboarding phase
- App Review / Advanced Access
- switch customer connections to official user authorization flow

## YouTube — prepare before YouTube adapter phase

Create/confirm:
1. Google Cloud Project owned by ElecIO/product
2. Enable YouTube Data API v3
3. OAuth consent screen
4. Web OAuth Client
5. Development redirect URI for local testing, e.g.
   `http://localhost:4000/api/v1/integrations/youtube/callback`
6. Production redirect URI later
7. Authorize ElecIO YouTube channel
8. Scope initially:
   `https://www.googleapis.com/auth/youtube.upload`

Store client ID/secret through integration credential mechanism, not hard-coded env if connections will eventually be multi-user.

Public product later requires Google verification as applicable, and YouTube upload projects may require compliance/audit to remove upload restrictions.

## Aparat — prepare before Aparat adapter phase

Have ready:
- ElecIO Aparat username
- ElecIO Aparat password/credential required by official API
- target category ID(s)
- default tags/description policy

Do not put credentials in prompt text or Git.

Codex must store them through encrypted `platform_connections`.

For the eventual SaaS product, treat Aparat user/password-equivalent onboarding as a separate product/security decision.

## Bale — prepare before Bale bridge phase

Provide Codex:
- existing Python Bale client source
- its current configuration/credentials
- intended ElecIO channel/chat ID
- a sample successful send flow if one exists

Codex must inspect the client before building the bridge.

Do not port it to Node in MVP.

## LinkedIn Company Page — start preparation NOW

Target:
`https://www.linkedin.com/company/elecio`

You are the Page admin, but Company Page publishing uses LinkedIn Community Management access.

Prepare:
1. LinkedIn Developer app owned/verified by the ElecIO legal organization
2. Associate/verify the ElecIO LinkedIn Page
3. Business email/domain and privacy policy/website ready
4. Apply for Community Management Development Tier
5. Request/obtain organization publishing permissions such as `w_organization_social` according to the current LinkedIn API product/version
6. OAuth redirect URI
7. verify your admin access using LinkedIn organization access APIs once access is granted

This adapter can be coded behind an interface earlier, but do not spend time debugging permissions until LinkedIn grants the required product access.

## Telegram — prepare before Telegram phase

From BotFather:
- bot token

From `my.telegram.org`:
- `api_id`
- `api_hash`

These are needed for Local Telegram Bot API Server.

Also:
- add Bot as admin to any configured source channel
- add Bot as admin with posting rights to target channel(s)
- record source and target channel IDs/usernames only after the bot can verify them

Do not hard-code channel IDs globally; persist as organization-owned connections.

---

# Windows Local Development Setup

## 1. NATS + JetStream

Current NATS server releases provide Windows binaries.

Create directories:

```powershell
New-Item -ItemType Directory -Force C:\dev\nats
New-Item -ItemType Directory -Force C:\dev\nats\data
```

Download the current Windows amd64 ZIP from the official `nats-io/nats-server` GitHub Releases page and extract `nats-server.exe` into:

```text
C:\dev\nats\nats-server.exe
```

For the simplest local development start:

```powershell
C:\dev\nats\nats-server.exe -js -sd C:\dev\nats\data
```

Expected default client URL:

```text
nats://127.0.0.1:4222
```

JetStream data survives server restarts in `C:\dev\nats\data`.

Recommended project local env:

```env
NATS_URL=nats://127.0.0.1:4222
NATS_STREAM_PREFIX=elecio_dev
```

For MVP local development, do not add NATS authentication/TLS yet if it binds only to localhost.

Production must use proper auth and must not expose port 4222 publicly.

### Optional NATS CLI

Download the current Windows amd64 `nats` CLI from official `nats-io/natscli` releases.

Test:

```powershell
nats server check --server nats://127.0.0.1:4222
```

If the CLI version differs in command syntax, use:

```powershell
nats --server nats://127.0.0.1:4222 server info
```

or simply rely on the Node integration health check.

## 2. MinIO AIStor local Windows

Current maintained MinIO AIStor supports Windows for local development/evaluation and requires a license; obtain the Free Tier license from MinIO.

Create:

```powershell
New-Item -ItemType Directory -Force C:\dev\minio
New-Item -ItemType Directory -Force C:\dev\minio\data
```

Download:

```powershell
Invoke-WebRequest `
  https://dl.min.io/aistor/minio/release/windows-amd64/minio `
  -OutFile C:\dev\minio\minio.exe
```

Obtain a MinIO AIStor Free Tier license and save it to:

```text
C:\dev\minio\minio.license
```

Start:

```powershell
C:\dev\minio\minio.exe server C:\dev\minio\data `
  --license C:\dev\minio\minio.license
```

Default local S3 endpoint:

```text
http://127.0.0.1:9000
```

For a local-only development instance, create a private bucket:

```text
elecio-publisher-dev
```

Install client:

```powershell
Invoke-WebRequest `
  https://dl.min.io/aistor/mc/release/windows-amd64/mc.exe `
  -OutFile C:\dev\minio\mc.exe
```

Then:

```powershell
C:\dev\minio\mc.exe alias set local http://127.0.0.1:9000
C:\dev\minio\mc.exe mb local/elecio-publisher-dev
```

For local dev only, use the local credentials in `.env`.

Example:

```env
S3_ENDPOINT=http://127.0.0.1:9000
S3_REGION=us-east-1
S3_BUCKET=elecio-publisher-dev
S3_ACCESS_KEY=LOCAL_ONLY
S3_SECRET_KEY=LOCAL_ONLY
S3_FORCE_PATH_STYLE=true
```

Use actual local credentials, not the literal placeholder above.

Do not commit them.

## 3. FFmpeg

Ensure:

```powershell
ffmpeg -version
ffprobe -version
```

both resolve from PATH.

## 4. MySQL

Use the existing project MySQL setup.

For publisher development:
- create a dedicated local development DB
- apply existing Better Auth schema and Knex migrations
- do not point local Codex development at the production database

## 5. Local Telegram

Do NOT spend development time building Telegram Local Bot API Server on Windows in the first iteration.

For local feature development:
- standard Telegram Bot API is sufficient for small test media
- use small fixtures under the cloud download limit
- media domain logic can also be tested through a local development ingest endpoint

Install Local Telegram Bot API Server natively on the Linux production host during deployment, using `api_id` and `api_hash`, so production can handle large Telegram files.

This intentionally avoids a Windows build/dependency detour.

---

# Phase 0 — Baseline Stabilization

## Goal

Make the existing Core safe and deterministic for Publisher development without redesigning it.

## Codex Prompt — Phase 0

```text
You are working inside the existing Esima Core repository I provided.

This is NOT a greenfield project.

The current stack is:
- JavaScript ESM
- Ultimate Express
- next-connect routing
- MySQL/mysql2
- Knex
- Objection.js
- Better Auth
- CASL ABAC
- multi-organization model
- tsx/tsup tooling

Do not migrate the project to TypeScript.
Do not replace Ultimate Express.
Do not replace Better Auth.
Do not rewrite routes/controllers/models that are unrelated to the task.
Do not touch the frontend/panel.

TASK:
Perform a narrowly scoped baseline stabilization before the new ElecIO Publisher modules are added.

First inspect:
- package.json
- src/server.js
- src/config/database.js
- src/config/auth.js
- src/config/base-router.js
- src/middlewares/requireAuth.js
- src/middlewares/checkPermission.js
- src/db/models/core/*
- src/db/migrations/*
- src/scripts/setup.js
- env.sample / .env.example
- .gitignore

Required changes:

1. Secret hygiene
- Ensure .env remains ignored.
- Remove every real-looking credential/password/token from environment sample files and replace with placeholders.
- Do NOT print or copy any secret in your report.
- If repository history is available, only report that a secret appears to have been committed; do not attempt destructive git-history rewriting unless I explicitly ask.

2. Fix the bootstrap admin password
- Remove the static hard-coded default password from setup.js.
- Require BOOTSTRAP_ADMIN_PASSWORD or generate a cryptographically strong bootstrap password only if explicitly supported by the script.
- Never use a known default such as 123456.
- Do not print an existing password.

3. Canonicalize multi-org config
- Existing runtime code uses IS_MULTI_ORG.
- Environment samples currently have inconsistent naming.
- Canonical value is IS_MULTI_ORG=true for this product.
- Do not create another parallel flag.

4. Add a minimal health/readiness capability if one does not already exist:
GET /api/v1/health

It should return only safe status data:
- app ok
- database ok/not-ok
- timestamp

Do not expose environment values.

5. Preserve the existing /storage static route for backward compatibility, but add a clear code comment that new Publisher media MUST NOT use local /storage.

6. Add or update npm scripts only if useful for:
- migration
- safe local verification
Do not introduce large tooling.

7. Use Node's built-in test runner where practical rather than adding a test framework just for Phase 0.

Validation:
- npm install
- existing build succeeds
- existing auth/panel routes still initialize
- database configuration remains compatible
- health endpoint works
- no secret values appear in tracked sample config

Do not create Publisher tables in this phase.
Do not add NATS.
Do not add S3/MinIO.
Do not add Telegram.
Do not add platform APIs.

At completion provide:
- files changed
- exact behavior changed
- tests/commands run
- any backward compatibility risk

STOP after Phase 0.
```

### Phase 0 Done

- build passes
- no new features
- no known default admin password
- env naming deterministic
- safe health endpoint

---

# Phase 1 — NATS + S3 Storage Infrastructure Adapters

## Goal

Connect the existing Core to local NATS JetStream and MinIO without creating business domain logic yet.

## Dependencies to add

```text
nats
@aws-sdk/client-s3
@aws-sdk/s3-request-presigner
```

Do not add BullMQ or Redis.

## Codex Prompt — Phase 1

```text
Continue from the stabilized existing Esima Core.

Do NOT redesign the existing Core.

Implement two infrastructure adapters:

A) NATS/JetStream
B) S3-compatible object storage

Use JavaScript ESM and existing project conventions.

A. NATS

Add a small module under a sensible path such as:

src/services/messaging/
  nats.js
  jetstream.js

Requirements:
- connect using NATS_URL
- safe singleton connection lifecycle
- reconnect-friendly
- no credentials logged
- JetStream context available
- graceful drain/close support
- application startup should not crash-loop with an unreadable stack trace; produce a concise safe error

Add a bootstrap function that idempotently ensures required development streams exist.

Initial streams:

1. ELECIO_JOBS
subjects:
- jobs.media.>
- jobs.publish.>
- jobs.cleanup.>

file-backed JetStream storage.

2. ELECIO_EVENTS
subjects:
- events.>

Use sensible retention and limits, but do NOT create huge defaults.
For local development, replicas=1.

Do not implement production clustering.

B. S3 storage

Use:
- @aws-sdk/client-s3
- @aws-sdk/s3-request-presigner

Do NOT import a MinIO-specific SDK.

Implement an S3-compatible storage service with methods conceptually equivalent to:
- putObject
- getObjectStream
- headObject
- deleteObject
- createSignedReadUrl
- createSignedUploadUrl

Configuration:
S3_ENDPOINT
S3_REGION
S3_BUCKET
S3_ACCESS_KEY
S3_SECRET_KEY
S3_FORCE_PATH_STYLE

Never expose bucket credentials.

Add an idempotent bucket connectivity check.
Do not automatically make the bucket public.

C. Health

Extend /api/v1/health safely to include:
- mysql
- nats
- objectStorage

Only boolean/status values; no hosts, usernames, access keys or secrets.

D. Tests

Add small integration scripts/tests that can run against:
- local MySQL
- local NATS
- local MinIO

Storage test:
- upload a small generated text object
- head it
- read it
- delete it

NATS test:
- ensure streams
- publish a small test message
- consume/ack it in a test-only subject or isolated test stream

Do not create Campaign/Asset domain tables yet.
Do not add Telegram.
Do not add platform publishing.

At completion report:
- dependencies added
- files added
- required env vars
- local test commands
- verification results

STOP after Phase 1.
```

---

# Phase 2 — Publisher Domain Schema + Objection Models + Credential Integration

## Prerequisite

Before running this phase, provide Codex the existing Esima Ecommerce integration/credential-encryption module you want reused.

Codex must inspect it first.

If the integration code is unavailable, it may create DB/model contracts but MUST STOP before inventing a competing credential crypto design.

## Codex Prompt — Phase 2

```text
Implement the Publisher domain in the existing Core.

Before coding:
1. inspect the current Objection/Knex model conventions
2. inspect Organization/User/ABAC implementation
3. inspect the Esima Ecommerce integration credential module I provide
4. REUSE its credential encryption/storage pattern where compatible
5. do not create an unrelated second encryption framework

Publisher is multi-organization from day one.

Every organization-owned publisher entity must be scoped by organization_id either directly or transitively.

Create Knex migrations and Objection models for:

- platform_connections
- telegram_channels
- campaigns
- assets
- campaign_targets
- publish_jobs
- publish_attempts
- outbox_events

Use the domain requirements supplied in the project brief.

Important constraints:
- platform_connections credentials encrypted
- do not put platform tokens in global environment variables except temporary ElecIO bootstrap/import tooling
- publish_jobs.idempotency_key unique
- useful indexes for organization_id, status, next_attempt_at, campaign_id
- foreign keys with intentional delete behavior
- JSON columns only where target-specific extensibility is needed
- do not turn every field into JSON

Asset metadata must support:
- object_key
- filename
- MIME
- size
- sha256
- width/height
- duration
- fps
- codecs
- aspect ratio
- probe data
- expires_at

Campaign targets must support:
- system-suggested target
- user-confirmed target
- per-target title/caption/settings override
- shared master asset
- shared campaign cover
- future target-specific asset/cover override

Add Objection relationMappings following existing DefaultModel conventions.

ABAC:
Add minimal Publisher permissions to the existing role/permission system, e.g.:
- Campaign read/create/update/publish
- PlatformConnection read/create/update/delete
- TelegramChannel read/create/update/delete
Do not redesign CASL.

Add only minimal API routes needed to inspect/create these entities for development.
No UI.

Do not implement NATS workers yet.
Do not implement platform publishers yet.

Add tests for:
- org isolation
- unique idempotency key
- campaign/target relations
- encrypted connection secret is not returned by normal serializers/API responses
- deletion behavior

Run migrations from a clean development DB and from the existing DB state.

STOP after Phase 2.
```

---

# Phase 3 — Outbox + JetStream Job Runtime

## Goal

Build reliable background dispatch before adding social network code.

## Codex Prompt — Phase 3

```text
Implement the durable job runtime for ElecIO Publisher.

Architecture:
- MySQL is source of truth
- outbox_events makes DB→NATS dispatch reliable
- NATS JetStream delivers work
- worker ACK means transport completion, not business-history deletion
- business retry schedule is stored in MySQL

Implement:

1. Outbox service
Within the same DB transaction that creates a publish/media job, create the corresponding outbox event.

2. Outbox dispatcher
- select available undispatched outbox events
- publish to NATS JetStream
- use deterministic Nats-Msg-Id where useful
- mark dispatched only after successful publish acknowledgement
- safe multi-process locking using MySQL
- no duplicate business jobs

3. Worker framework
A shared worker runner supporting:
- durable consumer
- explicit ACK
- safe NAK/redelivery on process-level failure
- structured context: jobId, organizationId, targetId
- graceful shutdown/drain

4. Business retries
On known transient platform/media failure:
- update publish_job RETRY_WAIT
- set next_attempt_at
- ACK current broker message
- scheduler later requeues through outbox

Scheduler:
- polls due RETRY_WAIT jobs
- transitions safely
- enqueues via outbox
- multiple scheduler processes must not duplicate jobs

5. Retry classifier utility
Categories:
- TRANSIENT_NETWORK
- PLATFORM_5XX
- RATE_LIMIT
- AUTH_REQUIRED
- VALIDATION
- PERMANENT
- AMBIGUOUS_EXTERNAL_STATE

No platform-specific implementation yet, but allow platform adapters to return a normalized error result.

6. Attempt history
Write sanitized publish_attempts records.
Never write tokens, passwords, signed URLs or full HTTP Authorization headers.

7. Test worker
Create a development-only fake publisher job handler that can simulate:
- success
- transient failure then success
- auth failure
- worker crash/redelivery

Validate no duplicate final success.

Do not add social platform APIs.
Do not add Telegram composer yet.

STOP after Phase 3.
```

---

# Phase 4 — Media Ingest, ffprobe, Compatibility Engine, Cleanup

## Goal

Make one media asset a first-class reusable object.

## Codex Prompt — Phase 4

```text
Implement the Publisher media pipeline.

Use the existing S3-compatible storage adapter.

Requirements:

1. Development ingest endpoint
Create an authenticated development/API endpoint under existing /api/v1 conventions that accepts a file for a campaign.

Do not build frontend UI.

Hard maximum media size:
300 MB
configurable with env.

Avoid buffering the entire file in memory.

If Ultimate Express/middleware compatibility makes streaming multipart upload unsafe, do not force a fragile middleware.
Use a controlled temp-file streaming strategy, then stream to S3, and document why.

2. S3 object storage
Upload the source into the private bucket using organization/campaign namespacing.

3. SHA-256
Calculate checksum streaming where practical.

4. ffprobe
After upload enqueue jobs.media.probe.

Media worker:
- downloads/streams to scratch if ffprobe needs local file access
- extracts:
  - media type
  - width
  - height
  - duration
  - FPS
  - video codec
  - audio codec
  - aspect ratio
- persists sanitized probe metadata
- deletes scratch data

5. Cover
Video campaign cannot reach READY without a cover asset.
Support upload of one campaign cover.
Store it as an Asset.
Do not auto-generate the creative cover in MVP.

6. Platform capability registry
Implement a data-driven registry, not scattered if-statements.

Each target adapter/capability exposes evaluation conceptually:
evaluateMedia(asset) -> {
  eligible,
  recommended,
  mode,
  reasons,
  missingRequirements
}

Implement initial technical capability definitions for:
- Instagram video/Reel
- YouTube Short/video
- Aparat video
- LinkedIn video
- Bale video
- Telegram video

Do not pretend a platform is supported if its actual adapter has not been connected; distinguish:
- technically compatible
- connection available
- publisher implemented

7. No creative reframing
If technically incompatible, report "variant required".
Do not crop/reframe.

8. Cleanup
Implement cleanup job:
- after all selected targets successfully finish, assets can be deleted immediately after confirming external platforms no longer need signed URLs/uploads
- otherwise delete no later than 24h according to retention policy
- delete scratch files too
- preserve DB post/result metadata

9. Signed URLs
Provide short-lived signed read URL method for platform fetchers such as Meta.
Never make the bucket public.

Tests:
- vertical Reel-like fixture
- horizontal fixture
- oversized rejection
- video without cover cannot become READY
- cleanup after success
- cleanup after expiry

STOP after Phase 4.
```

---

# Phase 5 — Telegram Composer + Source Channel Ingest

## Prerequisites

Have:
- BOT_TOKEN
- private chat with bot initialized
- development test source channel if desired
- bot added as admin to source channel
- authorized owner Telegram user ID can be established through a one-time development binding

For local development use cloud Bot API and small media.
Do not build Local Bot API Server on Windows now.

## Codex Prompt — Phase 5

```text
Implement Telegram as the Publisher composer and a source connector.

Do NOT publish to external platforms yet.

Do not use an in-memory conversational session as source of truth.
Conversation state must be resumable from MySQL.

Use the Telegram Bot API over HTTP through a small internal client.
The base API URL must be configurable so production can switch from api.telegram.org to a Local Telegram Bot API Server.

A. Development user binding
For the first development iteration:
- whitelist/bind only my Telegram user to an existing Core user/organization
- store the binding in database
- do not hard-code my Telegram user ID in application code
- schema must be multi-user capable

B. Private composer flow

Command:
/newpost

Flow:
1. create DRAFT campaign
2. ask user to send video/media
3. ingest media into S3
4. ask for cover; cover is required for video
5. run/provide ffprobe analysis
6. automatically calculate recommended target platforms based on:
   - technical compatibility
   - active platform connections
   - implemented publisher capability
7. present recommendation with inline buttons
8. user CONFIRMS recommendations or removes targets
9. ask only target-specific missing metadata
10. present final review
11. final Publish action creates target jobs later

Do not make the user manually choose targets from zero.

Base metadata:
- common title
- common caption
Then ask overrides only when required.

C. Source channel

Support configured Telegram source channels.

On channel_post:
- verify channel belongs to active organization connection
- ingest post/media
- create DRAFT campaign
- parse caption safely
- if a media group/album is involved, aggregate the Telegram media group correctly
- infer video + cover when both are supplied
- if cover missing, campaign remains incomplete
- do NOT publish immediately
- send the authorized owner a private review/recommendation message

Prevent duplicate ingestion using:
chat_id + message_id/media_group identity.

D. Target recommendation display

Example semantics:

Instagram Reel ✅ recommended
YouTube Short ✅ recommended
LinkedIn Video ✅ recommended
Aparat Video ✅ recommended
Bale ✅ recommended
Telegram Channel ✅ recommended

Only if both technically compatible and corresponding connection exists.

If publisher adapter is not implemented yet, mark it clearly as unavailable rather than creating a doomed target.

E. Publish button

For this phase, the final button should only create target rows / fake queued test jobs or stop before external publication.
Do not call Instagram/YouTube/etc yet.

F. Security
- verify Telegram identity
- never accept organization ID from Telegram text
- resolve organization from stored binding
- sanitize filenames
- media size max 300 MB
- no secrets in bot messages

Tests:
- private flow state resume
- source channel duplicate update
- media-group aggregation
- recommendation engine
- missing cover
- user confirmation

STOP after Phase 5.
```

---

# Phase 6 — Instagram Publisher (Real ElecIO System User)

## Prerequisites

Already available:
- Meta System User token
- Page ID
- IG Professional User ID
- username
- content publish permission

Before Codex starts:
- place credentials into the encrypted PlatformConnection mechanism
- do not paste the token into source code

## Codex Prompt — Phase 6

```text
Implement the first real social publisher: Instagram for the ElecIO organization.

Initial authentication is NOT general SaaS OAuth.
Use the existing Meta System User credentials for ElecIO only, stored via platform_connections encrypted credential mechanism.

Do not implement Meta App Review/public onboarding yet.

Create a platform adapter under a consistent interface.

Instagram adapter responsibilities:
- validate connection
- evaluateMedia
- create Reel container
- support caption
- support cover_url
- share_to_feed=true by default for ElecIO
- poll container status safely
- publish media container
- resolve permalink/media ID
- persist external container/media IDs as early as possible
- use short-lived signed S3 URLs for video and cover
- signed URLs must remain valid through Meta fetch/processing
- never log signed URLs/tokens

Integrate with publish job runtime.

State mapping:
UPLOADING/PREPARING
PROCESSING
PUBLISHING
PUBLISHED

Failure:
- 429 → normalized RATE_LIMIT
- 401/403 → AUTH_REQUIRED
- Meta 5xx/network → transient retry
- media error → permanent MEDIA_INVALID where appropriate

Ambiguous media_publish:
DO NOT call publish a second time until external state has been reconciled using stored container/media data.

Real test:
Use a disposable/approved ElecIO Reel test asset and explicitly publish one real test when I authorize it.

Compare the Node result with the existing successful Python implementation:
- cover
- share_to_feed
- caption
- processing
- permalink

Once the Node implementation has successfully published and its result is verified:
- disable the old Python Instagram publishing service
- do not delete it immediately; mark/archive it for rollback
- ensure no two services can publish the same target

Do not modify other platform adapters.

STOP after Instagram parity is proven.
```

---

# Phase 7 — YouTube Publisher

## User preparation before Phase 7

Provide:
- Google OAuth client ID/secret through secure integration setup
- authorized ElecIO channel
- redirect URI
- refresh token obtained by the application flow
- YouTube API enabled

## Codex Prompt — Phase 7

```text
Implement YouTube publishing as a Platform Adapter.

Use official Google/YouTube APIs and current documentation.

Authentication:
- OAuth 2.0
- youtube.upload scope initially
- encrypted refresh token in platform_connections
- access token refreshed server-side
- never log tokens

Media behavior:
- if vertical/square and duration qualifies for YouTube Shorts under current YouTube rules, capability engine may recommend it as Short
- do not invent a separate unsupported "Shorts upload API"; upload through the normal video API and let YouTube classify according to current rules
- preserve shared master asset when compatible

Metadata:
- title required
- description
- privacy/status setting
- tags optional
- target settings stored in campaign_target settings_json

Upload:
- use resumable upload
- persist external upload/video ID/state to survive process restarts where possible
- do not restart huge uploads blindly

Job error normalization:
- OAuth invalid/revoked → AUTH_REQUIRED
- quota/rate → RATE_LIMITED or appropriate permanent state
- 5xx/network → retry
- invalid media/metadata → permanent

After success:
- save YouTube video ID and public/watch URL when available

Testing:
- first integration can use a private/unlisted test
- only switch to actual public campaign behavior after account/project limitations are confirmed

Do not touch other adapters.

STOP after one successful ElecIO upload and stored result.
```

---

# Phase 8 — Aparat Publisher

## Prerequisites

Provide credential securely, plus default/valid category.

## Codex Prompt — Phase 8

```text
Implement Aparat as a Platform Adapter using the CURRENT OFFICIAL Aparat API.

Do not use browser automation/Selenium.

Inspect current official API documentation before coding.

Authentication:
- use the official Aparat login/token flow required today
- store credential/token encrypted in platform_connections
- do not log username/password-equivalent/ltoken

Publishing flow must follow the current official uploadform/upload endpoint contract.

Support:
- title
- category
- tags
- description
- comments setting if needed
- public/private semantics according to the official API

The bot/composer must request Aparat category if no organization default exists.

Use the master asset when technically compatible.
Do not generate arbitrary 16:9 variants in MVP.

Persist:
- returned Aparat UID
- resulting URL if derivable/confirmed

Normalize errors into the shared retry model.

Security:
Treat Aparat transformed password/login material as credential-equivalent.

Test one ElecIO video.

STOP after successful Aparat integration.
```

---

# Phase 9 — Bale Python Bridge

## Prerequisite

Provide Codex the existing Python Bale client.

## Codex Prompt — Phase 9

```text
Integrate the EXISTING Bale Python client without rewriting it in Node.

First inspect all provided Bale Python source and its successful usage.

Goal:
Create a very thin Bale publishing worker/bridge.

Preferred communication:
- NATS subject jobs.publish.bale
- Python worker consumes Bale jobs
- authoritative campaign/job/platform data remains in MySQL or is fetched through a safe minimal interface
- Python must ACK only after durable job state update semantics are satisfied

Do not duplicate the full Node domain layer in Python.

The Python bridge should:
- receive only IDs
- resolve required media/caption safely
- obtain media through S3-compatible MinIO access or a controlled signed URL/local stream
- call the existing Bale client
- return/store external message ID/result
- normalize errors to shared states as much as possible

Credentials:
- do not embed in Python source
- use the existing encrypted integration mechanism where practical
- if the existing client requires env configuration, isolate it and document migration path

Do not port the client to Node in this phase.

Test one Bale channel publication.

STOP after the existing client is successfully integrated through the job system.
```

---

# Phase 10 — Telegram Channel Publisher

## Prerequisites

Bot is admin with posting permission in the target channel.

## Codex Prompt — Phase 10

```text
Implement Telegram Channel as a real Platform Adapter.

This is separate from Telegram being the composer/source.

Target channels are organization-owned connection records.

Publishing:
- video + caption
- image where supported
- preserve target channel identity
- store resulting chat/message ID
- do not publish to source channel unless it is also explicitly configured as a target

Use Telegram Bot API base URL abstraction so production can use Local Bot API.

If the media object exists in MinIO:
- use the most efficient supported transfer method
- do not load a 300 MB object into Node memory
- production Local Bot API may use local path after controlled download/scratch if appropriate

Error mapping:
- bot removed/not admin → AUTH_REQUIRED/connection invalid
- chat not found/permission → permanent/auth
- network/5xx → retry

Test one ElecIO target channel post.

STOP after successful channel publication.
```

---

# Phase 11 — LinkedIn Company Page Publisher

## Hard external prerequisite

Do not waste development time trying to bypass LinkedIn product access.

You need the appropriate Community Management Development Tier access/permissions for the ElecIO organization Page.

## Codex Prompt — Phase 11

```text
Implement LinkedIn Company Page video publishing only after the LinkedIn Developer app has the required current Community Management API access.

Target:
ElecIO organization/company Page, not my personal member feed.

Before coding, inspect current LinkedIn official documentation and the permissions actually granted to the app.

Authentication:
- 3-legged OAuth member authorization
- authenticated member is an admin of ElecIO Page
- encrypted refresh/access credential material according to current LinkedIn token model
- validate organization access through official organization access APIs

Publishing:
- initialize/register video upload using current LinkedIn Videos API
- upload video using returned upload instructions
- finalize where required
- create organization post using current Posts API
- author must be ElecIO organization URN
- caption/commentary from campaign target
- persist video URN and post ID/URN
- obtain resulting URL if reliably available

Version headers:
Use the current supported LinkedIn Marketing API version.
Do not hard-code an already sunset version.

Errors:
- missing product permission/admin role → AUTH_REQUIRED/PERMISSION_REQUIRED
- rate limit → RATE_LIMITED
- transport/5xx → retry
- validation → permanent

Do not silently fall back to personal profile posting.

Test one ElecIO Company Page post only after authorization is verified.

STOP after successful Company Page publication.
```

---

# Phase 12 — Full Orchestration, Target Recommendation, Partial Success

## Goal

Turn separate adapters into one product workflow.

## Codex Prompt — Phase 12

```text
Now integrate all implemented adapters into the Campaign orchestrator.

Do not add new platform features.

Required workflow:

1. campaign draft contains master asset + required cover
2. compatibility engine evaluates every ACTIVE organization connection
3. system creates target recommendations
4. user confirms/removes recommendations in Telegram composer
5. target-specific missing metadata is collected
6. final review
7. Publish command atomically:
   - locks campaign
   - creates/updates campaign_targets
   - creates publish_jobs idempotently
   - creates outbox dispatch events
8. workers publish independently

Partial success semantics:
- successful targets remain published
- failed targets do not rollback successful ones
- only failed retryable targets retry
- campaign status:
  - published when all successful
  - partial when mix of success/final failure
  - failed when none succeeded and all terminal failed

Bot status message:
show one line per target:
- queued
- uploading
- processing
- published with link
- retrying
- auth required
- failed

Do not spam a new Telegram message for every low-level transition.
Prefer editing/updating one status message where practical.

Recommendation:
The system chooses recommended targets automatically.
The user then confirms/removes recommendations.
Do not revert to a blank manual platform picker.

Connection absence:
If no active connection exists, do not recommend that platform.

Cover:
One cover reused by default.

Cleanup:
- all target success → schedule immediate safe asset cleanup
- partial/retry → retain until no longer needed, max 24h
- after 24h, no automatic retry requiring missing media

Recovery:
Add a recovery command/task that scans MySQL for non-terminal jobs missing queue dispatch and safely restores dispatch.

Test:
- 3 fake targets, one transient failure
- one auth failure
- no duplicate publish jobs
- process restart between queue and external completion simulation
- real multi-target test using available ElecIO connections

STOP after orchestration is stable.
```

---

# Phase 13 — Local Acceptance Gate

## Definition of Done

Before Linux deployment, the local codebase must demonstrate:

1. `/newpost`
2. video sent
3. cover sent
4. media probe completed
5. system automatically recommends targets
6. user confirms/adjusts
7. missing metadata requested
8. final review
9. publish creates independent jobs
10. implemented real platforms succeed where local/public callback/storage allows
11. status shown per target
12. no duplicate jobs on repeat button/update
13. 300 MB limit enforced
14. media cleanup policy tested
15. org isolation tested

## Codex Prompt — Phase 13

```text
Perform a release-candidate acceptance pass for the ElecIO Publisher backend.

Do not add features.

Run:
- clean install
- clean local DB migration
- existing Core auth tests/smoke checks
- publisher model tests
- NATS integration
- S3/MinIO integration
- media probe
- Telegram composer tests
- worker retry/recovery tests
- connector tests available with current credentials

Audit:
- no secrets in Git-tracked files
- no platform token in logs
- no signed URL persisted in logs
- no global hard-coded ElecIO IDs except bootstrap/import data
- organization_id boundaries enforced
- no file >300 MB accepted
- no publisher reads media from legacy /storage
- NATS payloads contain IDs, not media blobs
- bucket remains private
- failure retry rules match requirements

Produce a concise RC report with:
- passed checks
- blocked checks due to external approval
- known technical debt
- exact env variables required in production
- migrations included

Do not deploy.

STOP after RC report.
```

---

# Phase 14 — Linux Deployment Preflight and Native Deployment

## Important: Current Hetzner Server Capacity

Current server shown:
- 2 vCPU
- 2 GB RAM
- 40 GB local disk
- Ubuntu
- already running:
  - Nginx
  - ElecIO website under PM2
  - XUI
  - server-management panel
  - Telegram downloader bot
  - other services

This server is NOT a comfortable production host for the full publisher stack:
- Node Core/workers
- MySQL
- NATS JetStream
- MinIO
- Local Telegram Bot API
- FFmpeg
- existing services

Before production deployment, strongly prefer one of:

### Option A — rescale this server
Recommended practical floor:
- 4 vCPU
- 8 GB RAM
- >= 80 GB disk

### Option B — preferred isolation
Keep current server as-is and create a separate Publisher VPS:
- 4 vCPU
- 8 GB RAM
- 80–160 GB disk

The second option reduces risk to the ElecIO website/XUI.

Do NOT deploy MinIO + FFmpeg + Telegram Local Bot API on the current 2 GB machine merely because they technically start.

## Codex Prompt — Phase 14

```text
Deploy the locally accepted ElecIO Publisher to the Linux server natively.

NO Docker/containers.

FIRST perform a non-destructive server audit:
- OS/version
- RAM/swap
- CPU
- disk/free space
- Nginx sites
- PM2 processes
- systemd services
- ports
- MySQL
- existing Node versions
- XUI ports/services
- existing Telegram bot
- firewall
- SSL/certbot
- current website domains

Do not stop/replace unrelated services.

If available RAM/disk is unsafe for the target stack, STOP and report instead of forcing deployment.

Components:
- existing Node backend
- MySQL (reuse safe existing install or install if absent)
- NATS JetStream native binary + systemd
- MinIO AIStor native Linux binary/package + systemd, Free/appropriate license
- FFmpeg
- Telegram Local Bot API native service
- Publisher workers
- existing Nginx reverse proxy integration

NATS:
- bind client port to localhost/private interface
- file-backed JetStream
- production credentials/auth
- no public 4222
- systemd
- persistent data directory

MinIO:
- private S3 bucket
- data directory on appropriate disk
- S3 API not exposed unnecessarily
- if external signed URLs are needed by Meta, expose only through controlled HTTPS hostname/reverse proxy
- console must not be publicly open without protection
- unique credentials
- systemd
- do not use local web root as storage

Telegram Local Bot API:
- use TELEGRAM_API_ID / TELEGRAM_API_HASH
- migrate bot from cloud endpoint to local Bot API carefully according to official procedure
- do not create duplicate webhook consumers
- confirm large-file getFile/local path behavior

Node:
- do not run nested cluster managers unnecessarily
- inspect existing server.js cluster strategy before deciding PM2/systemd
- avoid PM2 cluster + Node cluster simultaneously
- on a small server start with conservative worker count
- graceful shutdown drains NATS

Nginx:
- preserve existing configs
- nginx -t before reload
- add only required publisher API/media hosts
- HTTPS
- request body settings consistent with architecture

Secrets:
- create production env/root-readable or app-user-readable secure configuration
- mode 600
- no secrets in PM2 ecosystem file if it is tracked
- no secrets in logs

Migration:
- backup DB before migration
- run Knex/Better Auth migrations
- never run destructive reset

Smoke tests:
- health
- DB
- NATS
- MinIO
- Telegram bot
- platform connection verification
- no actual social publish until I explicitly approve a production test

After approval, perform one controlled multi-target publication.

Return deployment report without secrets.

STOP after successful deployment and smoke test.
```

---

# Development Order to Minimize Cycle Time

Use this exact order:

```text
0 Baseline
1 NATS + S3
2 Domain + credentials
3 Reliable jobs/outbox
4 Media
5 Telegram composer/source
6 Instagram
7 YouTube
8 Aparat
9 Bale
10 Telegram target
11 LinkedIn (when external access is ready)
12 Orchestration
13 local RC
14 deploy
```

Important parallel track:
- start LinkedIn API approval now
- prepare Google/YouTube credentials before Phase 7
- prepare Telegram BotFather/api_id/api_hash before Phase 5
- provide the Esima Ecommerce integration core before Phase 2
- provide Bale Python client before Phase 9

---

# Anti-Scope-Creep Rules for Every Codex Phase

Append this block to any prompt if Codex starts overbuilding:

```text
SCOPE CONTROL

This phase must remain a vertical, testable increment.

Do not:
- rewrite unrelated Core modules
- migrate the entire repository to TypeScript
- build frontend/admin UI
- add Redis
- add BullMQ
- add Kafka
- add Temporal
- add Docker
- split into microservices
- add Grafana/Prometheus/Sentry
- build scheduling UI
- build AI captioning
- build automatic video reframing
- implement platform onboarding for future public SaaS unless this phase explicitly asks
- add speculative abstractions that have no current caller

If a future requirement is obvious, leave a small interface or TODO and continue the current phase.

Before adding a dependency, justify why built-in/current dependencies are insufficient.

At completion:
- run tests
- report exactly what changed
- stop
- do not start the next phase automatically
```

---

# First Files Codex Should Respect in the Existing Core

The supplied backend already establishes conventions in:

```text
src/server.js
src/config/database.js
src/config/auth.js
src/config/base-router.js

src/db/models/core/Default.js
src/db/models/core/Organization.js
src/db/models/core/User.js
src/db/models/core/UserOrganizationRole.js
src/db/models/core/Role.js
src/db/models/core/Permission.js

src/middlewares/requireAuth.js
src/middlewares/checkPermission.js
src/lib/CaslQueryBuilder.js

src/routes/index.js
src/routes/panel/index.js

src/db/migrations/20260324_setup_abac.js
src/scripts/setup.js
```

New Publisher code should follow these patterns rather than introducing another application architecture beside them.

---

# Immediate Next Action

1. Rotate/remove any live secret that appeared in the uploaded project samples.
2. Set up local NATS JetStream.
3. Set up local MinIO AIStor.
4. Ensure local MySQL development DB exists.
5. Ensure FFmpeg/ffprobe are on PATH.
6. Give Codex the Phase 0 prompt.
7. Send/provide the Esima Ecommerce integration core before starting Phase 2.
8. Start LinkedIn Community Management access request in parallel.
