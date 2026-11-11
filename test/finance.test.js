import test from "node:test";
import assert from "node:assert/strict";
import {
  quoteSale,
  planSale,
  planDebtPayment,
  allocateOldestFirst,
  debtBalance,
  reconcileDrawer,
  reportTotals,
} from "../src/finance.js";

test("cash and debt portions remain distinct in split checkout", () => {
  const quote = quoteSale([{ quantity: 2, unitPriceMinor: 7500 }], 1000);
  assert.equal(quote.totalMinor, 14000);
  assert.deepEqual(
    planSale({
      totalMinor: 14000,
      tenders: [
        { type: "CASH", amountMinor: 4000 },
        { type: "DEBT", amountMinor: 10000 },
      ],
      buyer: {
        status: "ACTIVE",
        creditAllowed: true,
        debtRestricted: false,
        creditLimitMinor: 15000,
        outstandingMinor: 4000,
      },
      drawerOpen: true,
    }),
    {
      cashMovementMinor: 4000,
      debtChargeMinor: 10000,
      prepaidDebitMinor: 0,
      resultingDebtMinor: 14000,
    },
  );
});

test("invalid tenders and limits fail before posting", () => {
  const base = {
    totalMinor: 10000,
    buyer: {
      status: "ACTIVE",
      creditAllowed: true,
      debtRestricted: false,
      creditLimitMinor: 15000,
      outstandingMinor: 10000,
    },
    drawerOpen: true,
  };
  assert.throws(
    () => planSale({ ...base, tenders: [{ type: "CASH", amountMinor: 9000 }] }),
    /tenders must equal/,
  );
  assert.throws(
    () =>
      planSale({ ...base, tenders: [{ type: "DEBT", amountMinor: 10000 }] }),
    /credit limit/,
  );
  assert.throws(
    () =>
      planSale({
        ...base,
        tenders: [{ type: "CASH", amountMinor: 10000 }],
        drawerOpen: false,
      }),
    /drawer is closed/,
  );
  assert.throws(
    () => quoteSale([{ quantity: 0, unitPriceMinor: 100 }]),
    /quantity/,
  );
});

test("partial debt payment enters cash drawer without becoming a sale", () => {
  const payment = planDebtPayment({
    paymentMinor: 3000,
    outstandingMinor: 8000,
    method: "CASH",
    drawerOpen: true,
  });
  assert.deepEqual(payment, {
    debtLedgerAmountMinor: -3000,
    cashMovementMinor: 3000,
    prepaidDebitMinor: 0,
    resultingDebtMinor: 5000,
  });
  assert.deepEqual(
    allocateOldestFirst(3000, [
      { id: "b", effectiveAt: "2026-11-10", openMinor: 4000 },
      { id: "a", effectiveAt: "2026-10-01", openMinor: 2000 },
    ]),
    [
      { chargeId: "a", amountMinor: 2000 },
      { chargeId: "b", amountMinor: 1000 },
    ],
  );
  assert.throws(
    () =>
      planDebtPayment({
        paymentMinor: 9000,
        outstandingMinor: 8000,
        method: "CASH",
        drawerOpen: true,
      }),
    /exceeds/,
  );
});

test("prepaid payment reduces debt but creates no physical cash", () => {
  assert.equal(
    planDebtPayment({
      paymentMinor: 2000,
      outstandingMinor: 5000,
      method: "PREPAID",
      prepaidBalanceMinor: 2500,
    }).cashMovementMinor,
    0,
  );
});

test("drawer variance and reports reconcile source entries", () => {
  const movements = [
    { type: "SALE_CASH_IN", amountMinor: 4000 },
    { type: "DEBT_PAYMENT_CASH_IN", amountMinor: 3000 },
    { type: "PAYOUT", amountMinor: -500 },
  ];
  assert.deepEqual(
    reconcileDrawer({
      openingFloatMinor: 10000,
      movements,
      countedCashMinor: 16400,
    }),
    {
      expectedCashMinor: 16500,
      countedCashMinor: 16400,
      varianceMinor: -100,
    },
  );
  const entries = [
    { status: "POSTED", amountMinor: 8000 },
    { status: "POSTED", amountMinor: -3000 },
    { status: "PENDING", amountMinor: 9000 },
  ];
  assert.equal(debtBalance(entries), 5000);
  assert.deepEqual(
    reportTotals({
      sales: [
        {
          status: "POSTED",
          totalMinor: 14000,
          cashTenderMinor: 4000,
          debtTenderMinor: 10000,
        },
      ],
      entries,
      movements,
    }),
    {
      grossSalesMinor: 14000,
      cashSalesMinor: 4000,
      newDebtMinor: 10000,
      cashDebtPaymentsMinor: 3000,
      outstandingDebtMinor: 5000,
    },
  );
});
