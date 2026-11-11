# Canteen Management System

A multi-role canteen platform for point-of-sale cash payments, buyer tabs/credit,
paper-debt migration, settlement tracking, verification, and financial reporting.

## Documentation

- [System architecture](docs/architecture.md)
- [PostgreSQL schema](docs/schema.sql)
- [Implementation roadmap](docs/implementation-roadmap.md)
- [Developer guide and troubleshooting](docs/development.md)

## Stack

Node.js (no runtime packages), SQLite, HTML, CSS, and JavaScript. The app runs on
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

Do **not** open `web/index.html` directly or use VS Code Live Server: those can show
the page and CSS but cannot handle `/api/login`, resulting in HTTP 405. Confirm the
correct server at `http://127.0.0.1:3000/api/health` (it returns JSON).

To create optional sample accounts and menu items after the database exists:

```powershell
$env:CANTEEN_DEMO_PASSWORD = "choose-a-demo-password-12-chars-or-more"
node scripts/seed-demo.js
```

This creates `demo.admin`, `demo.cashier`, `demo.guard`, and `demo.buyer` with that
password. It does not change existing accounts. Do not use demo accounts for real
financial records. Administrators can create and edit actual accounts in the **Accounts** tab;
there is no public registration page.

Passwords cannot be viewed in the app or database as plain text; only password hashes
are stored. The demo password is the value you supplied in `CANTEEN_DEMO_PASSWORD`
when seeding. If you forgot a user's password, log in as admin and set a new one in
**Accounts → Edit**.

Data lives in `data/canteen.sqlite` and is excluded from Git. Set `CANTEEN_DATA_DIR`
to choose another data folder and `PORT` to change the listening port. Run tests with
`node --test`. For code formatting, run `npm.cmd install` once, then
`npm.cmd run format`.

### Add or edit an account

Log in with an admin account, open **Accounts**, and use **Create account**. Select a
role, section, and optional credit limit. To edit an existing account, click **Edit**
beside it. You can change its role, section, credit settings, active status, or set a
new password. A password reset logs that user out of existing sessions.

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
multi-terminal concurrency, backups, self-service password reset, full approval workflows, and
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


