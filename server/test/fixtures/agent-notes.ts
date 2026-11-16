// The sweep's corpus: notes written the way coding agents keep them (code,
// identifiers, paths, versions, error strings, tables, other languages), and
// labelled queries with the notes that answer them. With the prose set in
// relevance.ts, this is what MEANING_FLOOR is measured on.
export const AGENT_NOTES: Record<string, string> = {
  "shared/profile.md": `# Shared

What every agent should know: conventions, people, how-tos and tools that apply across all projects.

- Projects live under projects/<name>/; read that project's profile.md first.
- Ask Maria Keller about product priorities, Kenji Sato about infrastructure.
- Default branch is \`main\`; never push to it directly.
`,
  "shared/conventions/git-workflow.md": `# Git workflow

Branches are named \`feat/<ticket>-<slug>\` or \`fix/<ticket>-<slug>\`, and every pull request is squash merged into \`main\`.

## Why we squash merge

A squash merge keeps one commit per pull request on \`main\`, so \`git bisect\` and reverts work on whole changes. We do not rebase-merge or create merge commits.

## Commit messages

Conventional Commits: \`feat:\`, \`fix:\`, \`chore:\`, \`docs:\`, \`refactor:\`. The subject is imperative and under 72 characters.

\`\`\`
feat(checkout): add Apple Pay button
fix(billing): normalise ZIP+4 before calling the tax API
\`\`\`

## Protected branches

\`main\` and \`release/*\` need one approval and green CI. Force pushes are blocked.
`,
  "shared/conventions/code-review.md": `# Code review

Every pull request gets one reviewer; reviews are answered within one working day.

## What a reviewer checks

1. The change does what the ticket says, nothing more.
2. There is a test for every bug fix.
3. Names follow the language style guide.
4. No secrets, tokens or customer data in the diff.

## Size

Keep pull requests under 400 changed lines. Split larger work behind a feature flag.
`,
  "shared/conventions/typescript-style.md": `# TypeScript style

camelCase for variables and functions, PascalCase for types and components, named exports only, and \`strict\` mode everywhere.

## Compiler options

\`\`\`json
{
  "compilerOptions": {
    "strict": true,
    "strictNullChecks": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true
  }
}
\`\`\`

## Rules

- Prefer \`unknown\` over \`any\`; narrow with type guards.
- No default exports: \`export function getOrderTotal()\` not \`export default\`.
- Use \`satisfies\` for config objects.
- Errors: throw \`AppError\` subclasses, never strings.
`,
  "shared/conventions/python-style.md": `# Python style

snake_case names, ruff for lint and format, line length 100, and type hints on every public function.

## Tooling

Configured in \`pyproject.toml\`:

\`\`\`toml
[tool.ruff]
line-length = 100
target-version = "py312"

[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B"]
\`\`\`

Run \`uv run ruff check --fix .\` before committing. We moved from black and isort to ruff in 2025.

## Imports

Absolute imports only; \`from __future__ import annotations\` at the top of every module.
`,
  "shared/conventions/logging.md": `# Logging

Logs are structured JSON with an event name in snake_case and fields as keys; never log personal data.

\`\`\`python
log.info("order_created", order_id=order.id, total_cents=order.total_cents)
\`\`\`

\`\`\`ts
logger.info({ event: "order_created", orderId, totalCents });
\`\`\`

## Levels

| Level | When |
|---|---|
| debug | local only, never in production |
| info | business events: order_created, refund_issued |
| warn | retried or degraded: tax_api_retry |
| error | needs a human: payment_capture_failed |

## Personal data

Never log email addresses, names, card numbers or IP addresses. Use the customer id.
`,
  "shared/people/maria-keller.md": `# Maria Keller

Product owner for the shop and billing; decides priorities and scope, prefers written async updates over meetings.

- Timezone Europe/Berlin, works 08:00 to 16:30.
- Wants a short weekly summary on Fridays: what shipped, what slipped, why.
- Speaks German and English; product copy in German goes to her for review.
- Do not ping on weekends unless production is down.
`,
  "shared/people/kenji-sato.md": `# Kenji Sato

Infrastructure lead: owns Kubernetes, Terraform, DNS and on-call; ask him before changing anything in projects/infra.

## メモ

佐藤さんはインフラ担当です。 本番環境の変更は 必ず 事前に 連絡して ください。

- Timezone Asia/Tokyo.
- Prefers Slack threads in #infra over DMs.
- Reviews every Terraform plan before apply.
`,
  "shared/people/sam-okafor.md": `# Sam Okafor

Senior reviewer for billing and the shop backend; expects a test for every bug fix and small pull requests.

- Rejects pull requests over 400 lines without discussion.
- Likes a "How to test" section in every PR description.
- Prefers table-driven tests in Go.
- Strong opinion: no mocks of the database; use testcontainers.
`,
  "shared/how-to/run-tests-locally.md": `# Run the tests locally

Start the databases with docker compose, then run each project's test command; CI runs the same commands.

\`\`\`bash
docker compose up -d db redis
# shop
pnpm test
# billing
go test ./... -race
# data
uv run pytest -q
\`\`\`

Tests that need Postgres read \`TEST_DATABASE_URL\`, which defaults to \`postgres://postgres@localhost:5433/test\`.
`,
  "shared/how-to/rotate-secrets.md": `# Rotate secrets

Secrets live in Vault under \`kv/<project>/<env>\`; rotate a database password by writing a new one and restarting the pods.

## Database password

\`\`\`bash
export VAULT_ADDR=https://vault.internal.example.com
vault kv put kv/shop/prod DATABASE_PASSWORD="$(openssl rand -base64 32)"
kubectl -n shop rollout restart deploy/shop-web
\`\`\`

Then change the password in Postgres with \`ALTER ROLE shop WITH PASSWORD '...'\` inside the same maintenance window.

## API keys

Stripe and TaxJar keys are rolled in their dashboards first, then written to Vault. Keep the old key active for 24 hours.
`,
  "shared/how-to/release.md": `# Release a service

Services are versioned with semver; tag the commit on main, and CI builds and deploys the tag.

\`\`\`bash
git tag -a v2.14.0 -m "v2.14.0"
git push origin v2.14.0
\`\`\`

## Changelog

Update \`CHANGELOG.md\` under \`## [Unreleased]\` in the same pull request as the change; the release moves it under the version.

## Hotfix

Branch \`release/2.14\` from the tag, cherry-pick the fix, tag \`v2.14.1\`.
`,
  "shared/tools/docker-compose.md": `# Docker compose for local development

The root \`docker-compose.yml\` runs Postgres on port 5433 and Redis on port 6380, so they do not clash with local installs.

| Service | Image | Host port |
|---|---|---|
| db | postgres:16-alpine | 5433 |
| redis | redis:7.4 | 6380 |
| mailpit | axllent/mailpit | 8025 |

Reset everything with \`docker compose down -v\`.
`,
  "shared/glossary.md": `# Glossary

Terms we use across projects, with what they mean here.

- **SKU**: stock keeping unit, one sellable variant (size and colour).
- **PSP**: payment service provider; ours is Stripe.
- **Tenant**: a merchant account in the shop; every table has \`tenant_id\`.
- **Idempotency key**: a client-chosen id that makes a retried request safe.
- **Dunning**: the process of retrying failed subscription payments.
`,
  "shared/how-to/shell-snippets.md": `# Shell snippets

Small shell commands we reach for often, kept here so nobody has to rediscover them.

## Find large files

\`\`\`bash
# biggest files in the repo, ignoring .git
du -ah --exclude=.git . | sort -rh | head -20
\`\`\`

## Kill a process on a port

\`\`\`bash
# what listens on 3000?
lsof -ti tcp:3000 | xargs kill -9
\`\`\`

## Count lines of TypeScript

\`\`\`bash
# Count lines
git ls-files '*.ts' '*.tsx' | xargs wc -l | tail -1
\`\`\`
`,
  "projects/shop/profile.md": `# Shop

The online shop: Next.js 15 app router, Postgres 16 via Prisma 6, Redis for sessions and the cart, deployed on Fly.io.

- Repo: github.com/example/shop, default branch main.
- Package manager pnpm 9; Node 22.
- Money is integer cents (see decisions/adr-002-money-as-integers.md).
- Product owner: Maria Keller.
`,
  "projects/shop/decisions/adr-001-prisma.md": `# ADR-001: Prisma as the ORM

We use Prisma rather than Drizzle or raw SQL, for its migrations and generated types; accepted 2025-02.

## Context

The team knew Prisma; Drizzle was younger. We needed migrations that a junior could run.

## Decision

Prisma 5, upgraded to Prisma 6 in 2026. Raw SQL through \`prisma.$queryRaw\` for reporting queries only.

## Consequences

- Cold starts are slower because of the query engine.
- Connection pooling needs PgBouncer in transaction mode (see db/connection-pool.md).
`,
  "projects/shop/decisions/adr-002-money-as-integers.md": `# ADR-002: Money as integer cents

Amounts are stored as integer minor units (\`amount_cents bigint\`) with a currency code, never as floats or decimals in JavaScript.

## Why

0.1 + 0.2 is 0.30000000000000004 in JavaScript. Floating point rounding errors created one-cent mismatches with Stripe.

## Rules

- Columns: \`amount_cents bigint not null\`, \`currency char(3) not null\`.
- Format for display only at the edge, with \`Intl.NumberFormat\`.
- Tax and discounts are computed in cents and rounded half-even.
`,
  "projects/shop/decisions/adr-003-feature-flags.md": `# ADR-003: Feature flags with Unleash

Unfinished features ship behind Unleash flags named in kebab-case, such as \`checkout-v2\`, and flags are removed within two sprints of full rollout.

- Flag names: \`<area>-<feature>\`, e.g. \`checkout-v2\`, \`search-typo-tolerance\`.
- Server side: \`unleash.isEnabled("checkout-v2", context)\`.
- Every flag has an owner and a removal ticket.
`,
  "projects/shop/payments/stripe-webhooks.md": `# Stripe webhooks

Webhooks arrive at \`src/app/api/webhooks/stripe/route.ts\` and must be verified with \`stripe.webhooks.constructEvent\` on the raw request body.

## Signature verification fails

The error \`No signatures found matching the expected signature for payload\` means the body was parsed before verification. In the Next.js route handler read the raw body:

\`\`\`ts
export async function POST(req: Request) {
  const body = await req.text();
  const sig = req.headers.get("stripe-signature")!;
  const event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET!);
  // ...
}
\`\`\`

Also check that \`STRIPE_WEBHOOK_SECRET\` is the endpoint's secret (\`whsec_...\`), not the API key.

## Events we handle

| Event | Handler |
|---|---|
| payment_intent.succeeded | markOrderPaid |
| charge.refunded | recordRefund |
| invoice.payment_failed | startDunning |
`,
  "projects/shop/payments/refunds.md": `# Refunds

Refunds are issued from the admin through Stripe; partial refunds are allowed and every refund records a \`refund_reason\`.

## Reasons

\`refund_reason\` is an enum: \`duplicate\`, \`fraudulent\`, \`requested_by_customer\`, \`damaged\`, \`not_delivered\`.

## Partial refunds

A partial refund passes \`amount\` in cents. The order keeps \`refunded_cents\`; when it reaches \`total_cents\` the status becomes \`refunded\`.
`,
  "projects/shop/payments/idempotency.md": `# Idempotency keys

Every request that creates a payment sends an \`Idempotency-Key\` header; Stripe keeps keys for 24 hours and replays the first response.

- The key is \`order:<order_id>:attempt:<n>\`.
- Never generate a new key on a retry of the same attempt; that is how we charged customers twice (see incidents/2026-07-02-double-charge.md).
- Our own API accepts \`Idempotency-Key\` on POST /orders and stores it for 24 hours in Redis.
`,
  "projects/shop/frontend/i18n.md": `# Internationalisation

Translations use next-intl with message files in \`messages/<locale>.json\`; locales are de-DE, fr-FR and ja-JP, and English is the fallback.

## German strings

| Key | de-DE |
|---|---|
| cart.title | Warenkorb |
| cart.checkout | Zur Kasse |
| cart.empty | Ihr Warenkorb ist leer |

German copy is reviewed by Maria Keller before release. Übersetzungen nie maschinell ohne Prüfung übernehmen.

## Plurals

Use ICU plural syntax: \`{count, plural, one {# Artikel} other {# Artikel}}\`.
`,
  "projects/shop/frontend/tailwind.md": `# Tailwind setup

The shop uses Tailwind CSS 4 with the design tokens in \`src/styles/tokens.css\`; no inline styles and no arbitrary values for colours.

- Use \`cn()\` from \`src/lib/utils.ts\` to merge classes.
- Dark mode by the \`dark\` class on \`<html>\`.
`,
  "projects/shop/db/migrations.md": `# Database migrations

Migrations are Prisma migrations applied with \`prisma migrate deploy\` in the release job; never run \`prisma migrate reset\` against production.

## Failed migration P3009

\`Error: P3009 migrate found failed migrations in the target database\` means a previous deploy died mid-migration. Fix the schema by hand, then mark it:

\`\`\`bash
pnpm prisma migrate resolve --applied 20260310120000_add_refund_reason
\`\`\`

## Long migrations

Add indexes with \`CREATE INDEX CONCURRENTLY\` in a separate migration, as Prisma wraps migrations in a transaction otherwise.
`,
  "projects/shop/db/connection-pool.md": `# Connection pooling

Production connects through PgBouncer in transaction mode, so Prisma needs \`?pgbouncer=true&connection_limit=1\` on the DATABASE_URL.

## Prepared statement errors

\`prepared statement "s0" already exists\` comes from Prisma using prepared statements across pooled connections. Adding \`pgbouncer=true\` turns them off.

## Limits

PgBouncer \`default_pool_size = 20\`, Postgres \`max_connections = 200\`.
`,
  "projects/shop/incidents/2026-03-12-checkout-outage.md": `# Incident 2026-03-12: checkout outage

Checkout failed for 47 minutes because Redis hit its memory limit and refused writes; we raised maxmemory and set an eviction policy.

## Timeline

- 14:02 alerts: checkout error rate 38%.
- 14:10 logs show \`OOM command not allowed when used memory > 'maxmemory'\`.
- 14:31 maxmemory raised from 256mb to 1gb.
- 14:49 error rate back to normal.

## Root cause

Cart sessions had no TTL, so Redis filled up over three months. \`maxmemory-policy\` was \`noeviction\`.

## Follow-ups

- Set a 30-day TTL on cart keys.
- \`maxmemory-policy allkeys-lru\`.
- Alert at 80% Redis memory.
`,
  "projects/shop/incidents/2026-07-02-double-charge.md": `# Incident 2026-07-02: customers charged twice

212 customers were charged twice for one order because the payment retry generated a fresh idempotency key on each attempt.

## What happened

A network timeout to Stripe triggered our retry. The retry built a new \`Idempotency-Key\`, so Stripe treated it as a new payment.

## Fix

Keys are now derived from the order id and attempt number (see payments/idempotency.md). All 212 duplicate charges were refunded with reason \`duplicate\`.
`,
  "projects/shop/api/rate-limits.md": `# API rate limits

The public shop API allows 100 requests per minute per API token; past that it answers 429 with a Retry-After header in seconds.

- Limits are per token, not per IP.
- Bulk endpoints (\`/v1/products/bulk\`) count as 10 requests.
- Partners on the enterprise plan get 1000 per minute.
`,
  "projects/shop/api/pagination.md": `# API pagination

List endpoints use cursor pagination: pass \`cursor\` from the previous response's \`next_cursor\`, and \`limit\` up to 200 (default 50).

\`\`\`json
{ "data": [ ... ], "next_cursor": "b3JkZXI6MTIzNA", "has_more": true }
\`\`\`

Offset pagination (\`?page=\`) was removed in API v3.
`,
  "projects/shop/search/meilisearch.md": `# Product search with Meilisearch

Product search runs on Meilisearch 1.11; products are indexed on every change through a queue, and \`searchableAttributes\` are title, brand, sku.

- Typo tolerance on, min word size for one typo: 5.
- Reindex all: \`pnpm tsx scripts/reindex-products.ts\`.
`,
  "projects/shop/legal/cgv.md": `# Conditions générales de vente

Les conditions générales de vente de la boutique pour la France : droit de rétractation de 14 jours, livraison sous 5 jours ouvrés.

## Retours

Le client peut retourner un article dans les 14 jours suivant la réception. Les frais de retour sont à la charge du client sauf article défectueux.

## Mentions légales

Le texte complet est validé par le service juridique ; ne pas le modifier sans accord.
`,
  "projects/billing/profile.md": `# Billing

The billing service: Go 1.23, gRPC with protobufs generated by buf, Postgres 16, handles subscriptions, invoices and dunning.

- Repo: github.com/example/billing.
- Reviewer: Sam Okafor.
- gRPC deadline for ledger calls: 5 seconds.
`,
  "projects/billing/how-to/generate-protos.md": `# Generate protobuf code

Run \`buf generate\` from the repo root; it uses protoc-gen-go v1.34 and protoc-gen-go-grpc v1.5 pinned in \`buf.gen.yaml\`.

\`\`\`yaml
version: v2
plugins:
  - remote: buf.build/protocolbuffers/go:v1.34.2
    out: gen/go
  - remote: buf.build/grpc/go:v1.5.1
    out: gen/go
\`\`\`

Commit the generated files; CI fails if \`buf generate\` changes anything.
`,
  "projects/billing/quirks/tax-api.md": `# TaxJar API quirks

TaxJar answers 422 for US ZIP+4 codes in some states, so we normalise every ZIP to its first five digits before calling it.

- Error body: \`{"error":"Unprocessable Entity","detail":"to_zip 12345-6789 is not used within to_state NY"}\`.
- Rate limit is 3000 requests per minute; we cache rates for 24 hours by ZIP.
- Sandbox returns fixed rates, do not test edge cases there.
`,
  "projects/billing/quirks/invoice-pdf.md": `# Invoice PDFs

Invoices are rendered from HTML with wkhtmltopdf, which needs \`--enable-local-file-access\` to load the bundled fonts.

- Fonts live in \`assets/fonts/\`; missing fonts render as boxes.
- Page size A4, margins 15mm.
`,
  "projects/billing/decisions/adr-004-event-sourcing.md": `# ADR-004: Ledger as an event log

The ledger is append-only: every balance change is an event in \`ledger_events\`, and balances are projections rebuilt from events.

## Decision

No UPDATE on \`ledger_events\`. Corrections are new compensating events.

## Consequences

Projections can be rebuilt with \`billing-cli projections rebuild\`; it takes about 40 minutes on production data.
`,
  "projects/billing/runbooks/dunning.md": `# Dunning runbook

When a subscription payment fails, dunning retries the card on day 1, 3, 7 and 14, emails the customer each time, and cancels the subscription after the last failure.

| Attempt | Day | Email template |
|---|---|---|
| 1 | 1 | payment_failed_soft |
| 2 | 3 | payment_failed_reminder |
| 3 | 7 | payment_failed_urgent |
| 4 | 14 | subscription_cancelled |

To pause dunning for a customer: \`billing-cli dunning pause --customer cus_123\`.
`,
  "projects/billing/errors.md": `# Billing errors we see

Common errors in the billing service and what they mean; most are timeouts to the ledger.

## context deadline exceeded

\`rpc error: code = DeadlineExceeded desc = context deadline exceeded\` on ledger calls means the 5 second deadline passed. Usually the ledger projection is rebuilding.

## pq: duplicate key value violates unique constraint "invoices_number_key"

Two workers allocated the same invoice number. Invoice numbers come from a Postgres sequence since v1.8; this only appears on old data.
`,
  "projects/billing/testing.md": `# Billing tests

Run \`go test ./... -race\`; database tests use testcontainers with Postgres 16, and table-driven tests are the norm.

\`\`\`go
func TestProrate(t *testing.T) {
    cases := []struct{ name string; days, total int; want int }{
        {"half month", 15, 30, 50},
    }
    for _, c := range cases { /* ... */ }
}
\`\`\`
`,
  "projects/billing/ledger-design.md": `# Ledger design notes

Long-form design notes on how the billing ledger stores balances, written when we moved to event sourcing.

The ledger keeps every movement of money as an immutable event. Each event has an id, an account id, an amount in minor units, a currency, a kind and a timestamp. A balance is never stored as a mutable number; it is a projection, computed by folding events in order. We keep projections in a table per kind of balance: customer credit, prepaid usage, and outstanding invoices. Projections carry the id of the last event they include, so a rebuild can resume from where it stopped. When an event is written, the projection is updated in the same transaction, which keeps reads consistent without locking the events table. Corrections are written as compensating events with a reference to the event they correct, so the history shows both. Currency conversion never happens inside the ledger; amounts are converted before they are written, and the rate used is stored on the event. Rounding is half-even, in minor units, always at the boundary, never inside a fold. An account can be frozen, which makes new events for it fail with a clear error, but projections still read. Archival moves events older than seven years to cold storage after a final projection snapshot is taken. The snapshot is verified by re-folding the archived events and comparing totals, and the archive is only deleted from the hot table once totals match exactly. We considered double-entry with separate debit and credit rows; it doubled the rows and every query, and our auditors were satisfied with single events carrying signed amounts plus a balancing check that runs nightly. The nightly check sums every account and compares against the external bank statements, and an alert fires on any difference larger than zero cents. The quiet word for this whole design is boring: no clever caches, no eventual consistency for balances, one transaction per movement, and projections that can always be rebuilt from scratch with the rebuild command in about forty minutes on production volumes. The rebuild runs with a read replica to avoid load on the primary database, and it writes to a shadow table that is swapped in with a rename once it has caught up with the live events.
`,
  "projects/mobile/profile.md": `# Mobile app

The shop's mobile apps: Kotlin Multiplatform for shared logic, SwiftUI on iOS (minimum iOS 16) and Jetpack Compose on Android (minSdk 26).

- Releases go through fastlane.
- Push via APNs and FCM HTTP v1.
`,
  "projects/mobile/how-to/release-ios.md": `# Release the iOS app

Build and upload with \`bundle exec fastlane beta\`, which bumps the build number and pushes to TestFlight for testers.

## Steps

1. \`bundle exec fastlane beta\` on a clean main.
2. Wait for TestFlight processing (10 to 30 minutes).
3. Add the build to the "Internal" group.

## ITMS-90683

Upload rejected with \`ITMS-90683: Missing purpose string in Info.plist\` means a permission key such as \`NSCameraUsageDescription\` is missing. Add it to \`Info.plist\` with a user-facing sentence.
`,
  "projects/mobile/how-to/release-android.md": `# Release the Android app

Run \`./gradlew bundleRelease\`, bump \`versionCode\` in \`androidApp/build.gradle.kts\`, and upload the .aab to the Play Console internal track.

- Signing key is in Vault under \`kv/mobile/prod/upload-keystore\`.
- Promote internal to production after 48 hours without crashes.
`,
  "projects/mobile/quirks/push-notifications.md": `# Push notification quirks

FCM moved to the HTTP v1 API; a token that answers \`messaging/registration-token-not-registered\` is dead and must be deleted from \`device_tokens\`.

- APNs device tokens are hex strings of 64 characters; never store them base64.
- iOS needs the \`aps-environment\` entitlement set to production for TestFlight builds.
- Silent pushes are throttled by iOS; do not rely on them for sync.
`,
  "projects/mobile/quirks/deep-links.md": `# Deep links

Universal links need \`apple-app-site-association\` served at \`/.well-known/\` with content-type application/json and no redirect.

- Android App Links need \`assetlinks.json\` with the SHA-256 of the signing key.
- Test with \`xcrun simctl openurl booted https://shop.example.com/p/123\`.
`,
  "projects/mobile/crash-notes.md": `# Crash notes

Recurring crashes from Crashlytics and what we know about them.

## JobCancellationException

\`kotlinx.coroutines.JobCancellationException: StandaloneCoroutine was cancelled\` in \`CartViewModel\` is logged when the screen closes during a request. Not a real crash; filter it in Crashlytics.

## EXC_BAD_ACCESS in ImageCache

Fixed in 3.8.2 by moving the cache to an actor.
`,
  "projects/infra/profile.md": `# Infrastructure

AWS: EKS on Kubernetes 1.31, Terraform 1.9 for everything, ArgoCD for deploys, Route53 for DNS; owned by Kenji Sato.

- Never apply Terraform from a laptop; plans run in CI and Kenji approves.
- Clusters: prod-eu-1, staging-eu-1.
`,
  "projects/infra/terraform/state-locking.md": `# Terraform state locking

State is in S3 with a DynamoDB lock table \`tf-locks\`; when a run dies it can leave the lock behind.

## Error acquiring the state lock

\`\`\`
Error: Error acquiring the state lock
Lock Info:
  ID:        3b1e6c8a-...
  Path:      example-tf-state/prod/terraform.tfstate
\`\`\`

Check that no CI job is running, then:

\`\`\`bash
terraform force-unlock 3b1e6c8a-...
\`\`\`
`,
  "projects/infra/k8s/resource-limits.md": `# Kubernetes resource limits

Every container sets CPU and memory requests and a memory limit; a pod that exits with code 137 was OOMKilled and needs a higher limit.

| Workload | CPU request | Memory request | Memory limit |
|---|---|---|---|
| shop-web | 250m | 512Mi | 1Gi |
| billing-api | 200m | 256Mi | 512Mi |
| worker | 500m | 1Gi | 2Gi |

No CPU limits: they cause throttling. Check with \`kubectl top pod -n shop\`.
`,
  "projects/infra/k8s/ingress.md": `# Ingress

We use ingress-nginx; uploads over 1 MB need the annotation \`nginx.ingress.kubernetes.io/proxy-body-size\`.

\`\`\`yaml
metadata:
  annotations:
    nginx.ingress.kubernetes.io/proxy-body-size: "20m"
    cert-manager.io/cluster-issuer: letsencrypt-prod
\`\`\`

A 413 Request Entity Too Large from the shop means this annotation is missing.
`,
  "projects/infra/dns.md": `# DNS

DNS is in Route53, managed by Terraform; records use a TTL of 300, and staging lives under \`*.staging.example.com\`.

- Lower the TTL to 60 a day before a migration.
- MX records are managed by IT, not Terraform.
`,
  "projects/infra/certificates.md": `# TLS certificates

cert-manager issues Let's Encrypt certificates through the \`letsencrypt-prod\` ClusterIssuer with the DNS-01 challenge on Route53.

- Certificates renew 30 days before expiry.
- If a certificate is stuck, \`kubectl describe certificaterequest -n <ns>\` shows why.
`,
  "projects/infra/runbooks/disk-full.md": `# Runbook: disk full on a build node

Build nodes fill \`/var/lib/docker\` with old images; clean them with \`docker system prune\` and check the cron that should do it.

\`\`\`bash
df -h /var/lib/docker
docker system prune -af --filter "until=72h"
\`\`\`

The cron \`/etc/cron.daily/docker-prune\` should run this daily.
`,
  "projects/infra/oncall.md": `# On-call

On-call rotates weekly on Monday 10:00 Berlin time through PagerDuty; the secondary is paged after 15 minutes without an ack.

- Escalation: primary, secondary, then Kenji Sato.
- Handover notes go in #oncall.
`,
  "projects/infra/costs.md": `# Monthly cloud costs

AWS costs per month, reviewed in the first week of each month; the target is under 18k USD.

| Item | 2026-09 | 2026-10 |
|---|---|---|
| EKS nodes | 8,200 | 8,450 |
| RDS | 3,100 | 3,100 |
| S3 + transfer | 1,900 | 2,250 |
| NAT gateway | 1,400 | 1,350 |
`,
  "projects/data/profile.md": `# Data platform

Airflow 2.10 schedules dbt 1.8 models on BigQuery; raw data lands in the \`raw\` dataset, models build into \`analytics\`.

- Owner: data team, channel #data.
- Python 3.12, managed with uv.
`,
  "projects/data/dbt/naming.md": `# dbt model naming

Models are prefixed by layer: \`stg_\` for staging (one per source table), \`int_\` for intermediate, \`fct_\` for facts and \`dim_\` for dimensions.

- \`stg_shop__orders\`: double underscore between source and table.
- \`fct_orders\`, \`dim_customers\`.
- Columns snake_case; ids end in \`_id\`, timestamps in \`_at\`.
`,
  "projects/data/airflow/backfills.md": `# Airflow backfills

DAGs run with \`catchup=False\`; backfill a date range by hand with \`airflow dags backfill\`.

\`\`\`bash
airflow dags backfill -s 2026-01-01 -e 2026-01-31 shop_orders_daily
\`\`\`

Backfills over a month must be split, or BigQuery slots run out.
`,
  "projects/data/quirks/bigquery-costs.md": `# BigQuery costs

Large tables are partitioned by day with \`require_partition_filter = true\`, so a query without a date filter fails instead of scanning terabytes.

- Error: \`Cannot query over table 'analytics.fct_events' without a filter over column(s) 'event_date'\`.
- Use \`--dry_run\` to see bytes processed.
`,
  "projects/data/quirks/timezones.md": `# Timezones in the warehouse

Store every timestamp in UTC as \`TIMESTAMP\`; convert to Europe/Berlin only in the reporting layer, never \`DATETIME\` in models.
`,
  "projects/data/gdpr-deletion.md": `# Eliminación de datos personales

Procedimiento para la eliminación de datos personales de un cliente cuando lo solicita (derecho al olvido, RGPD).

## Pasos

1. Buscar el \`customer_id\` en la tienda.
2. Ejecutar \`python -m pipelines.gdpr.delete --customer-id <id>\`.
3. Confirmar por correo al cliente en un plazo de 30 días.

Los datos agregados y anonimizados se conservan.
`,
  "projects/data/legacy-readme.md": `Legacy exporter
===============

The old CSV exporter that sends nightly order files to the accounting firm by SFTP; scheduled for removal in 2027.

Configuration
-------------

The exporter reads \`EXPORT_SFTP_HOST\` and \`EXPORT_SFTP_KEY_PATH\`. Files are named \`orders_YYYYMMDD.csv\`.

Known problems
--------------

The accounting firm's SFTP server rejects keys other than RSA 4096; ed25519 keys fail with \`no matching host key type found\`.
`,
  "projects/data/hugo-page.md": `---
title: Data catalogue page
draft: false
tags: [docs, catalogue]
---

# Data catalogue

The public page that lists every dataset in the warehouse, generated with Hugo from dbt docs.

## Build

\`hugo --minify\` in \`docs/catalogue/\`, deployed to Cloudflare Pages.
`,
  "projects/data/markdown-guide.md": `# Writing docs in Markdown

How we write Markdown docs, including how to show a fenced code block inside another.

## Nesting fences

Use four backticks for the outer fence:

\`\`\`\`markdown
\`\`\`bash
echo hello
\`\`\`
\`\`\`\`

## Heading after the example

Text after the nested example, about the anchor naming rule: anchors are kebab-case.
`,
  "agents/claude/notes.md": `# Claude's notes

Things I learned about working with this team that are not in a project profile.

- Maria wants summaries in bullet points, not prose.
- Run \`pnpm lint\` before opening a pull request on the shop; CI fails on warnings.
- Billing tests are slow (8 minutes); run a single package with \`go test ./internal/invoice/...\`.
`,
  "agents/reviewer/checklist.md": `# Reviewer checklist

My checklist for each pull request, in order.

- [ ] Tests for the bug fix.
- [ ] No \`console.log\` or \`fmt.Println\` left behind.
- [ ] Migrations are backwards compatible.
- [ ] Feature flag for anything user-facing.
`,
};

/** Query -> the notes that answer it. An empty list means nothing in AGENT_NOTES does. */
export const AGENT_QUERIES: [string, string[]][] = [
  // Exact identifiers
  ["amount_cents", ["projects/shop/decisions/adr-002-money-as-integers.md"]],
  ["constructEvent", ["projects/shop/payments/stripe-webhooks.md"]],
  ["stripe.webhooks.constructEvent", ["projects/shop/payments/stripe-webhooks.md"]],
  ["require_partition_filter", ["projects/data/quirks/bigquery-costs.md"]],
  ["tf-locks", ["projects/infra/terraform/state-locking.md"]],
  ["proxy-body-size", ["projects/infra/k8s/ingress.md"]],
  ["nginx.ingress.kubernetes.io/proxy-body-size", ["projects/infra/k8s/ingress.md"]],
  ["next_cursor", ["projects/shop/api/pagination.md"]],
  ["JobCancellationException", ["projects/mobile/crash-notes.md"]],
  ["ITMS-90683", ["projects/mobile/how-to/release-ios.md"]],
  ["P3009", ["projects/shop/db/migrations.md"]],
  ["stg_shop__orders", ["projects/data/dbt/naming.md"]],
  ["apple-app-site-association", ["projects/mobile/quirks/deep-links.md"]],
  ["strictNullChecks", ["shared/conventions/typescript-style.md"]],
  ["Idempotency-Key", ["projects/shop/payments/idempotency.md"]],
  ["NSCameraUsageDescription", ["projects/mobile/how-to/release-ios.md"]],
  ["refund_reason", ["projects/shop/payments/refunds.md"]],
  ["checkout-v2", ["projects/shop/decisions/adr-003-feature-flags.md"]],
  // Error messages
  ["No signatures found matching the expected signature for payload", ["projects/shop/payments/stripe-webhooks.md"]],
  ["prepared statement \"s0\" already exists", ["projects/shop/db/connection-pool.md"]],
  ["Error acquiring the state lock", ["projects/infra/terraform/state-locking.md"]],
  ["OOM command not allowed when used memory > 'maxmemory'", ["projects/shop/incidents/2026-03-12-checkout-outage.md"]],
  ["rpc error: code = DeadlineExceeded desc = context deadline exceeded", ["projects/billing/errors.md"]],
  ["messaging/registration-token-not-registered", ["projects/mobile/quirks/push-notifications.md"]],
  ["pod exited with code 137", ["projects/infra/k8s/resource-limits.md"]],
  ["413 Request Entity Too Large", ["projects/infra/k8s/ingress.md"]],
  ["no matching host key type found", ["projects/data/legacy-readme.md"]],
  ["Cannot query over table without a filter over column(s)", ["projects/data/quirks/bigquery-costs.md"]],
  // Paraphrases
  ["how do we keep money values without floating point rounding problems", ["projects/shop/decisions/adr-002-money-as-integers.md"]],
  ["what happens when a customer's card keeps failing on their subscription", ["projects/billing/runbooks/dunning.md"]],
  ["the checkout went down because the cache ran out of memory", ["projects/shop/incidents/2026-03-12-checkout-outage.md"]],
  ["customers were billed twice for the same purchase", ["projects/shop/incidents/2026-07-02-double-charge.md"]],
  ["ship a beta build of the iPhone app to testers", ["projects/mobile/how-to/release-ios.md"]],
  ["clean up a build machine that ran out of disk space", ["projects/infra/runbooks/disk-full.md"]],
  ["who decides product priorities", ["shared/people/maria-keller.md"]],
  ["naming rules for warehouse models", ["projects/data/dbt/naming.md"]],
  ["uploading big files to the shop fails at the load balancer", ["projects/infra/k8s/ingress.md"]],
  ["protect against charging a card twice when a request is retried", ["projects/shop/payments/idempotency.md","projects/shop/incidents/2026-07-02-double-charge.md"]],
  // Questions
  ["How do I run the tests locally?", ["shared/how-to/run-tests-locally.md"]],
  ["What is the rate limit of the shop API?", ["projects/shop/api/rate-limits.md"]],
  ["Which ORM does the shop use and why?", ["projects/shop/decisions/adr-001-prisma.md"]],
  ["When does dunning retry a failed payment?", ["projects/billing/runbooks/dunning.md"]],
  ["What Go version does billing use?", ["projects/billing/profile.md"]],
  ["How do I rotate the database password?", ["shared/how-to/rotate-secrets.md"]],
  ["Why do we squash merge?", ["shared/conventions/git-workflow.md"]],
  ["What does Sam expect in a pull request?", ["shared/people/sam-okafor.md"]],
  ["Who is on call and how does escalation work?", ["projects/infra/oncall.md"]],
  ["What port does the local Postgres run on?", ["shared/tools/docker-compose.md","shared/how-to/run-tests-locally.md"]],
  // Typos
  ["stripe webhok signature", ["projects/shop/payments/stripe-webhooks.md"]],
  ["terrafrom state lock", ["projects/infra/terraform/state-locking.md"]],
  ["idempotancy key", ["projects/shop/payments/idempotency.md"]],
  ["pgbouncr prepared statments", ["projects/shop/db/connection-pool.md"]],
  ["kuberntes memory limts", ["projects/infra/k8s/resource-limits.md"]],
  // Several words
  ["partial refund reason enum", ["projects/shop/payments/refunds.md"]],
  ["fastlane testflight beta", ["projects/mobile/how-to/release-ios.md"]],
  ["airflow backfill catchup", ["projects/data/airflow/backfills.md"]],
  ["cert-manager letsencrypt ClusterIssuer", ["projects/infra/certificates.md"]],
  ["docker compose redis port", ["shared/tools/docker-compose.md"]],
  ["ruff line length pyproject", ["shared/conventions/python-style.md"]],
  // Paths
  ["/var/lib/docker", ["projects/infra/runbooks/disk-full.md"]],
  ["src/app/api/webhooks/stripe/route.ts", ["projects/shop/payments/stripe-webhooks.md"]],
  ["pyproject.toml", ["shared/conventions/python-style.md"]],
  ["androidApp/build.gradle.kts", ["projects/mobile/how-to/release-android.md"]],
  // Versions
  ["Prisma 6", ["projects/shop/profile.md","projects/shop/decisions/adr-001-prisma.md"]],
  ["Kubernetes 1.31", ["projects/infra/profile.md"]],
  ["v2.14.0", ["shared/how-to/release.md"]],
  ["protoc-gen-go v1.34", ["projects/billing/how-to/generate-protos.md"]],
  ["Meilisearch 1.11", ["projects/shop/search/meilisearch.md"]],
  // Other languages
  ["Warenkorb", ["projects/shop/frontend/i18n.md"]],
  ["Übersetzungen", ["projects/shop/frontend/i18n.md"]],
  ["インフラ担当", ["shared/people/kenji-sato.md"]],
  ["本番環境", ["shared/people/kenji-sato.md"]],
  ["eliminación de datos personales", ["projects/data/gdpr-deletion.md"]],
  ["droit de rétractation", ["projects/shop/legal/cgv.md"]],
  ["delete a customer's personal data on request", ["projects/data/gdpr-deletion.md"]],
  // Search syntax, read as plain words
  ["\"squash merge\" AND NOT rebase", ["shared/conventions/git-workflow.md"]],
  ["stripe* OR NEAR(webhook)", ["projects/shop/payments/stripe-webhooks.md"]],
  ["title:redis", ["projects/shop/incidents/2026-03-12-checkout-outage.md","shared/tools/docker-compose.md"]],
  ["'; drop table sections; --", []],
  ["dunning & !cancel | (retry)", ["projects/billing/runbooks/dunning.md"]],
  // Notes the splitter must handle: setext headings, front matter, nested fences, long paragraphs
  ["legacy CSV exporter SFTP", ["projects/data/legacy-readme.md"]],
  ["Hugo data catalogue", ["projects/data/hugo-page.md"]],
  ["anchors are kebab-case", ["projects/data/markdown-guide.md"]],
  ["shadow table swapped in with a rename", ["projects/billing/ledger-design.md"]],
  ["lsof kill process on port", ["shared/how-to/shell-snippets.md"]],
  // Nothing in the notes answers these
  ["recipe for sourdough bread", []],
  ["best hiking trails in Patagonia", []],
  ["quantum chromodynamics lattice simulation", []],
  ["what is the capital of Mongolia", []],
  ["how do I renew my passport", []],
  ["guitar chord progressions for jazz", []],
];
