# Paper slip workflow

## Daily use

1. In **Paper slips**, enter one slip per spreadsheet row: field, optional name,
   amount, and date. Add as many rows as needed and review the running total before
   clicking **Save all slips**. The whole batch saves together.
2. Use **People & fields** when you want a separate person directory or an additional
   field. The built-in fields are Guards, Admin, Operation, Extra, Agency, Driver,
   and Cash. Cash slips are collected immediately; names are optional in every field.
3. When payroll actually deducts a slip, use **Collections** to enter the amount,
   date, and payroll reference. A cash payment toward a credit slip uses the Cash
   payment option. Multiple partial collections may be recorded, up to the slip total.
4. In **Weekly report**, choose This week, Last week, or any From/To dates to report
   only part of a week.

## Calculations

All amounts are stored in centavos, never floating point.

- **Slip sales:** sum of slips dated inside the selected period.
- **Collected:** Cash slips in the period plus payroll deductions and cash payments
  recorded in the period.
- **Outstanding as of end date:** all credit slips dated on/before the end date minus
  their collections dated on/before that date.
- **Field totals:** each slip keeps its field, so multiple guards accumulate under
  Guards. A typed name is saved with the slip when provided.

The dashboard intentionally omits the outstanding balance card. The ledger still
tracks collections and the Weekly report can show an as-of outstanding amount.

Sales and collections are intentionally separate. Entering a credit slip increases
sales and outstanding debt; it does not mean the money has been collected. Cash slips
increase both sales and collected immediately.

## Existing records

This workflow adds `paper_fields`, `paper_people`, `paper_slips`, and
`paper_collections` tables to the same local SQLite database. It leaves the earlier
menu POS tables and records untouched. The paper dashboard reports only the paper
tables; any historical migration must be reviewed to avoid duplicate sales.
