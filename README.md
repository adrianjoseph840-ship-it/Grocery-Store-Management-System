# Canteen Management System

A multi-role canteen platform centered on paper slips, payroll deductions, cash
sales, field totals, and weekly or custom date-range income reporting.

## Documentation

- [Active database and manual accounts](docs/active-database.md)

- [System architecture](docs/architecture.md)
- [PostgreSQL schema](docs/schema.sql)
- [Implementation roadmap](docs/implementation-roadmap.md)
- [Developer guide and troubleshooting](docs/development.md)
- [Paper slip workflow and calculations](docs/paper-workflow.md)

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
If the app was already running when you update the code, stop that process with
`Ctrl+C` and start it again so the new paper-slip API routes are loaded. An
`EADDRINUSE` error means another process is already using port 3000.

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

The programmer can create a separate account for each person directly in the main
SQLite database using this command from the project folder:

```powershell
node scripts/create-account.js
```

Enter that person's email, full name, role, and a unique temporary password when
prompted. Give only that person's credentials to them. At first sign-in, they must
change the password before accessing the app. Repeat the command for each person.
The database stores only a password hash, so record the temporary password securely
when you create it; it cannot be read back from the database.

Log in with an admin account, open **Accounts**, and use **Create account**. Enter the
account email and a temporary password, then select a role, section, and optional credit
limit. At first login, the account holder must replace the temporary password before any
other screen or API action is available. To edit an existing account, click **Edit**
beside it. You can change its role, section, credit settings, active status, or set a
new temporary password. A password reset logs that user out of existing sessions and
requires another password change at the next login.

## Implemented workflows

- Admin: paper-slip dashboard, person and field directory, extra fields, slip entry,
  payroll collections, weekly and custom date reports, accounts, and audit log.
- Cashier: paper-slip entry, person directory, payroll/cash collections, and reports.
- Guard: minimal buyer debt/restriction status lookup.
- Buyer: own balance and ledger history.

Default fields are **Guards, Admin, Operation, Extra, Agency, Driver, and Cash**.
**Paper slips** is a spreadsheet-style entry sheet: choose one fixed field for the sheet,
then add rows with an optional name, amount, and date. The total updates as you type, and **Save all slips** posts
the whole batch together. Cash slips count as collected immediately. The dashboard
shows sales and collected income without an outstanding-debt card. The **Weekly
report** accepts any date range, including only part of a week.

The earlier menu POS data and API remain in the database for continuity. The new
paper-slip dashboard reports only the new paper ledger, so old sales are not counted
twice. No existing records are deleted or automatically migrated.

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


