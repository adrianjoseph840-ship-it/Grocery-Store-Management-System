# Paper slip workflow

## Daily use

1. In **People & fields**, add each worker to their field. The built-in fields are
   Guards, Admin, Operation, Extra, Agency, Driver, and Cash. Admins can add more.
2. In **Paper slips**, select the field and person, enter the written amount and date,
   then record the slip. Use the Cash field for immediate cash purchases; it needs no
   person.
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
  Guards while remaining distinguishable by person.

Sales and collections are intentionally separate. Entering a credit slip increases
sales and outstanding debt; it does not mean the money has been collected. Cash slips
increase both sales and collected immediately.

## Existing records

This workflow adds `paper_fields`, `paper_people`, `paper_slips`, and
`paper_collections` tables to the same local SQLite database. It leaves the earlier
menu POS tables and records untouched. The paper dashboard reports only the paper
tables; any historical migration must be reviewed to avoid duplicate sales.
