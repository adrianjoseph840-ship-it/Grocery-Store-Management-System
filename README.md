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

## Current implementation

The first code slice is the dependency-free financial domain module in
`src/finance.js`. It validates sale totals and tender splits, credit limits, debt
payments, payment allocation, drawer closing, and financial summaries. Run its
tests with `node --test`. It does not yet connect to PostgreSQL or expose an API;
the SQL schema is a reference for the next backend milestone.

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

