# Canteen Management System

A multi-role canteen platform for point-of-sale cash payments, buyer tabs/credit,
paper-debt migration, settlement tracking, verification, and financial reporting.

## Documentation

- [System architecture](docs/architecture.md)
- [PostgreSQL schema](docs/schema.sql)
- [Implementation roadmap](docs/implementation-roadmap.md)

## Recommended stack

- **Frontend:** Next.js (React + TypeScript), Tailwind CSS, TanStack Query
- **Backend:** NestJS (TypeScript), REST API, OpenAPI/Swagger
- **Database:** PostgreSQL with Prisma or Drizzle ORM
- **Authentication:** Secure server sessions or short-lived access tokens with
  rotating refresh tokens
- **Deployment:** Docker Compose initially; managed PostgreSQL and container hosting
  for production

Start as a modular monolith. It is easier to deploy and keep financial operations
transactional than microservices, while module boundaries leave room to split out
reporting or notifications later.

## Run locally

Requires Node.js 22 or newer. In PowerShell:

```powershell
$env:CANTEEN_ADMIN_PASSWORD = "choose-a-strong-unique-password"
node src/server.js
```

Open `http://127.0.0.1:3000`, then sign in as `admin` with that password. The password
is only used when the database is first created. Data lives in `data/canteen.sqlite`
and is excluded from Git. Set `CANTEEN_DATA_DIR` to choose another data folder and
`PORT` to change the listening port. Run tests with `node --test`.

## Implemented workflows

- Admin: financial overview, section and user creation, menu management, paper debt
  import, buyer accounts, sale voids, date range reports, and audit log.
- Cashier: drawer opening/closing, cash and split cash/debt checkout, buyer accounts,
  and partial cash settlements.
- Guard: minimal buyer debt/restriction status lookup.
- Buyer: own balance and ledger history.

The responsive cashier screen supports menu search, quantity controls, buyer credit
context, a live cash/tab split, and a confirmation step before posting. Buyer accounts
can be searched by name or username.

The runtime stores transactions in SQLite using atomic writes; `docs/schema.sql` is a
PostgreSQL reference for a later deployment migration. The local server binds to
`127.0.0.1` and is intended for one machine or a trusted local pilot. Public hosting,
multi-terminal concurrency, backups, password reset, full approval workflows, and
partial refunds require further work before production use. Sale voids require an
admin, an open admin drawer for cash refunds, and no later buyer payment when debt is
involved; this conservative rule avoids allocating repayments to the wrong charge.

## Financial invariants

1. A sale, payment, refund, or adjustment is never silently edited or deleted.
   Corrections use reversing entries.
2. Cash drawer movement and buyer debt movement are recorded separately.
3. Every financial write is atomic, idempotent, and attributed to an actor.
4. Debt balances are derived from posted ledger entries; cached balances are only
   an optimization.
5. Closing reports use the canteen's configured business timezone and immutable
   shift snapshots.

## Local Git and GitHub

This directory can be initialized locally with:

```powershell
git init
git add README.md docs
git commit -m "docs: define canteen system architecture"
```

Before pushing, create or select a GitHub repository and add it as `origin`, or use
GitHub CLI if authenticated:

```powershell
gh repo create canteen-management-system --private --source . --remote origin --push
```

Repository creation and pushing should only be done after confirming the target
GitHub account/organization and repository visibility.

