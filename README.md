# Canteen Management System

A multi-role canteen platform for point-of-sale cash payments, buyer tabs/credit,
paper-debt migration, settlement tracking, verification, and financial reporting.

## Documentation

- [System architecture](docs/architecture.md)
- [PostgreSQL schema](docs/schema.sql)
- [Implementation roadmap](docs/implementation-roadmap.md)

## Stack

Node.js (no external packages), SQLite, HTML, CSS, and JavaScript. The app runs on
one local machine. The PostgreSQL documentation describes a future larger deployment.

## Run locally

Requires Node.js 22 or newer. Open PowerShell in this project folder. To check Node:

```powershell
node --version
```

On the first run with a new database, set an administrator password and start the app:

```powershell
$env:CANTEEN_ADMIN_PASSWORD = "replace-with-your-own-long-password"
node src/server.js
```

Open `http://127.0.0.1:3000` and log in as `admin` with that password. Keep PowerShell
open while using the app; press `Ctrl+C` to stop it. The password variable is used only
when creating a new database. On later runs, simply use `node src/server.js`.

To create optional sample accounts and menu items after the database exists:

```powershell
$env:CANTEEN_DEMO_PASSWORD = "choose-a-demo-password-12-chars-or-more"
node scripts/seed-demo.js
```

This creates `demo.admin`, `demo.cashier`, `demo.guard`, and `demo.buyer` with that
password. It does not change existing accounts. Do not use demo accounts for real
financial records. Administrators can create actual accounts in the **Team** tab;
there is no public registration page.

Data lives in `data/canteen.sqlite` and is excluded from Git. Set `CANTEEN_DATA_DIR`
to choose another data folder and `PORT` to change the listening port. Run tests with
`node --test`.

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

