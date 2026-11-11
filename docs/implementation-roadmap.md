# Implementation Roadmap

> The current application uses the paper-slip workflow in
> [Paper slip workflow](paper-workflow.md). This earlier POS roadmap is retained as
> background rather than a description of the main dashboard.

## Phase 0 — Confirm business rules

Agree on currency/timezone, tier limits, debt eligibility, settlement approval,
overpayments, due dates, guard-visible data, void/refund authority, retention, and who
may import paper debt. Collect sample paper sheets and expected closing reports.

## Phase 1 — Foundation

1. Create monorepo, local Docker services, migrations, seeds, CI, and environments.
2. Implement authentication, sessions, roles/permissions, users, sections, and tiers.
3. Add structured errors, request IDs, idempotency storage, audit middleware, backups,
   monitoring, and test fixtures.

Exit criterion: role boundaries are covered by API integration tests.

## Phase 2 — Catalog and cash POS

1. Menu administration and server-authoritative price snapshots.
2. Drawer opening, cash checkout, receipts, cash movement, and closing counts.
3. Cash reconciliation and daily reports.

Exit criterion: automated tests prove expected cash and variance from a known shift.

## Phase 3 — Debt ledger

1. Buyer lookup, tier limits, restrictions, charges, partial settlements, allocations.
2. Paper-debt staging/import with references, duplicate checks, evidence, and approval.
3. Reversal workflows, statements, aging, and section snapshots.

Exit criterion: concurrent purchases cannot exceed a locked buyer's credit limit, and
ledger totals reconcile exactly from source entries.

## Phase 4 — Role portals and reporting

Build guard verification, buyer self-service, admin analytics, exports, approval inbox,
weekly/monthly closures, and section breakdowns. Add privacy and accessibility review.

## Phase 5 — Pilot and migration

1. Run a small section and one drawer in parallel with paper records.
2. Compare each day's cash, digital/prepaid totals, debt charges, and settlements.
3. Resolve differences with documented reversing entries—not database edits.
4. Train users, establish incident/backup procedures, then migrate sections in batches.

## Minimum test matrix

- Exact cash, change, split cash/debt, debt-only, and prepaid-only checkout.
- At-limit, over-limit, suspended, restricted, and concurrent buyer attempts.
- Partial/full payment, oldest-first allocation, reversal, rejected approval, duplicate
  idempotency request, paper-import duplication, and historical section transfer.
- Drawer close with exact count, shortage, overage, refund, payout, and debt payment.
- Permission tests for every role and cross-buyer access attempt.
- Financial property tests: tender sum equals total; posted ledger sum equals balance;
  drawer movements equal expected cash; reversal pairs net to zero.

