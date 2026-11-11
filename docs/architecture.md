# System Architecture

## 1. Scope and terminology

- **Buyer:** staff/personnel allowed to purchase; belongs to a section and buyer tier.
- **Tier:** policy grouping that controls eligibility and credit limit.
- **Sale:** priced items purchased in one checkout.
- **Tender:** how a sale is funded: cash, prepaid balance, debt, or a permitted mix.
- **Debt ledger:** immutable charges, settlements, migrations, reversals, and approved
  adjustments affecting a buyer's amount due.
- **Paper debt:** an opening debt imported with its paper reference and evidence.
- **Drawer session:** a cashier's opening float, cash movements, and closing count.

Money is stored as integer minor units (`BIGINT`, e.g. centavos), never floating
point. Timestamps are stored in UTC and displayed in the configured business timezone.

## 2. Roles and permissions

| Capability | Admin | Cashier / Tracking | Guard | Buyer |
|---|---:|---:|---:|---:|
| View all analytics and reports | Yes | Shift/assigned scope | No | No |
| Manage users, sections, tiers, menu | Yes | No | No | No |
| Open/close own drawer | Oversight | Yes | No | No |
| Create cash/debt sale | Override | Yes | No | No |
| Record debt payment | Approve/override | Create/request | No | No |
| Approve adjustment/settlement | Yes | No | No | No |
| Verify buyer status | Yes | Yes | Yes (minimal data) | Own only |
| View debt/history | All | Operational need | Status only | Own only |
| Export reports | Yes | Assigned shift | No | Own statement |

Authorization must be enforced in the API, not just hidden in the UI. Guard responses
should disclose only status, restrictions, and limited identity—never full financial
history.

## 3. Backend layout

```text
apps/
  api/src/
    modules/
      auth/              login, sessions, password/MFA policies
      identity/          users, roles, permissions
      buyers/            buyer profiles, sections, tiers, restrictions
      catalog/           menu items, categories, prices, availability
      pos/               carts, sales, sale lines, tender orchestration
      ledger/            debt charges, payments, reversals, balance queries
      cash-drawer/       shifts, cash movements, closing/reconciliation
      verification/      guard-safe buyer lookup
      reporting/         daily/weekly/monthly and section summaries
      approvals/         settlement and adjustment workflow
      audit/             append-only audit events
    common/              authorization, validation, errors, idempotency
    infrastructure/      database, queue, storage, observability
  web/src/
    app/                  route groups by role
    features/             pos, buyers, ledger, reports, administration
    components/           shared accessible UI
packages/
  contracts/              API DTOs/schema and generated client
  config/                 shared linting and TypeScript configuration
```

Keep modules behind application services; do not let controllers write ORM records
directly. All checkout and settlement paths run in a database transaction.

## 4. Core API

All mutating endpoints accept an `Idempotency-Key`. Amounts returned by the API use
minor units plus currency, for example `{ "amountMinor": 12500, "currency": "PHP" }`.

```text
POST   /v1/auth/login
POST   /v1/auth/logout
GET    /v1/me

GET    /v1/menu-items?available=true
POST   /v1/sales/quote
POST   /v1/sales
GET    /v1/sales/{saleId}
POST   /v1/sales/{saleId}/void-requests

GET    /v1/buyers?query=&sectionId=&status=
GET    /v1/buyers/{buyerId}/account-summary
GET    /v1/buyers/{buyerId}/ledger
POST   /v1/buyers/{buyerId}/paper-debt-imports
POST   /v1/buyers/{buyerId}/payments

POST   /v1/approvals/{approvalId}/approve
POST   /v1/approvals/{approvalId}/reject

POST   /v1/drawer-sessions
POST   /v1/drawer-sessions/{id}/movements
POST   /v1/drawer-sessions/{id}/close
GET    /v1/drawer-sessions/{id}/reconciliation

GET    /v1/verification/buyers/{publicCode}
GET    /v1/reports/financial-summary?from=&to=&sectionId=
GET    /v1/reports/closures?period=daily|weekly|monthly

GET    /v1/admin/users
POST   /v1/admin/users
PATCH  /v1/admin/users/{id}
GET    /v1/admin/audit-events
```

## 5. Frontend dashboards

### Cashier POS

```text
┌──────────────── Header: drawer status • cashier • clock ────────────────┐
│ Buyer search / scan       │ Menu search + category filters              │
│ Name • section • tier     │ [Item] [Item] [Item]                        │
│ Balance • available credit│                                             │
├───────────────────────────┼─────────────────────────────────────────────┤
│ Alerts / restrictions     │ Cart                                        │
│ Recent buyer transactions │ qty • item • price • subtotal               │
│                           │ Total                                       │
│                           │ [Cash] [Charge to tab] [Split payment]       │
└───────────────────────────┴─────────────────────────────────────────────┘
```

Confirmation must show the buyer, tender breakdown, resulting debt balance, amount
received, and cash change before posting. After posting, offer receipt/reprint—not
silent editing.

### Admin dashboard

```text
Filters: date range • section • tier • cashier
[Gross sales] [Cash collected] [New debt] [Debt payments] [Outstanding]
Revenue trend                 Cash vs debt mix
Section revenue/debt table    Aging buckets (current/30/60/90+)
Drawer variance alerts        Pending approvals
Recent audit activity         Exports / closing reports
```

Admin routes: Overview, Sales, Debt Ledger, Buyers, Sections & Tiers, Menu,
Cash Drawers, Approvals, Reports, Users & Roles, Audit Log, Settings.

### Guard verification

A large search/scan field followed by identity, photo (if permitted), section, and a
high-contrast status: **Clear**, **Pending debt**, **Restricted**, or **Review needed**.
Show only the reason code and action guidance allowed by policy.

### Buyer portal

Account summary, current amount due, available credit, due/restriction status,
chronological statement, sale details, payments, and downloadable statement.

## 6. Hybrid cash/debt reconciliation

### A. Cash sale

1. Validate item prices from the server-side catalog and lock the active drawer.
2. Create sale and lines from the price snapshot.
3. Create a `CASH` tender for the exact applied amount.
4. Add a drawer `SALE_CASH_IN` movement for that amount.
5. Write the audit event and commit atomically.

Cash earned for a period is derived from posted cash tender on sales (net refunds).
Physical cash expected in a drawer also includes opening float, debt-payment cash,
cash-in/out, and excludes payouts—so it is intentionally not the same metric.

### B. Debt sale

1. Lock buyer account; verify active status, tier eligibility, restrictions, and limit.
2. Calculate `availableCredit = creditLimit - max(outstandingBalance, 0)`.
3. Reject or require an authorized override when the debt portion exceeds availability.
4. Create sale/lines and a `DEBT` tender.
5. Append a debt-ledger `CHARGE` for the debt portion linked to the sale.
6. Audit and commit. No cash drawer movement is created.

### C. Split cash/debt sale

Create two tenders whose sum equals the sale total. Only the cash portion enters the
drawer; only the debt portion becomes a ledger charge. Enforce this invariant in both
application validation and a deferred database/transaction check.

### D. Debt settlement or partial payment

1. Lock buyer account and confirm the amount is positive.
2. Record a `PAYMENT` ledger entry (negative effect on amount due).
3. If paid in cash, create `DEBT_PAYMENT_CASH_IN` in the open drawer. If funded from
   prepaid balance, append a prepaid-ledger debit instead; never call it cash earned.
4. Allocate payment oldest-first to open charges unless an admin selects a documented
   alternative policy. Store allocations for aging and traceability.
5. If policy requires approval, keep it `PENDING`; it affects neither balance nor cash
   until an admin posts it. Audit request and approval separately.

Overpayment should be rejected initially. If the business later permits it, represent
the excess as prepaid credit—not negative debt.

### E. Existing paper debt migration

1. Admin/cashier enters buyer, original date (or estimated date flag), amount, paper
   reference, notes, and optional evidence image.
2. A second person reviews totals when required by policy.
3. Approval posts an `OPENING_BALANCE` ledger entry with source `PAPER_IMPORT`.
4. Mark the paper record with the generated import reference to prevent duplication.
5. Preserve the source reference permanently; corrections use reversal + replacement.

### F. Closing and reconciliation

```text
expectedCash = openingFloat
             + cashSales
             + cashDebtPayments
             + otherCashIn
             - cashRefunds
             - payouts
             - otherCashOut

drawerVariance = countedCash - expectedCash
outstandingDebt = postedCharges + postedOpeningBalances
                + postedAdjustments - postedPayments - postedReversals
```

The closing record stores component totals, counted denominations, variance, cashier,
reviewer, and timestamp as an immutable snapshot. Section revenue follows the buyer's
section snapshot at sale time, so later transfers do not rewrite historical reports.

## 7. Security and operational requirements

- Argon2id password hashing, optional MFA for admins, session revocation, rate limits.
- Row/permission checks for every buyer-scoped query; redact guard responses.
- Database constraints, decimal-safe money utilities, and server-authoritative prices.
- Append-only audit storage with before/after metadata; never log passwords or tokens.
- Encrypted transport, encrypted backups, restricted evidence-file access.
- Automated backups with tested restore procedure; health checks and error monitoring.
- Approval/override reason codes for credit-limit exceptions, voids, and adjustments.

