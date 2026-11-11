/** Financial rules shared by the eventual API and reporting jobs. All values are minor units. */
export function money(value, label = "amount") {
  if (!Number.isSafeInteger(value))
    throw new RangeError(`${label} must be a safe integer in minor units`);
  return value;
}

function nonnegative(value, label) {
  money(value, label);
  if (value < 0) throw new RangeError(`${label} cannot be negative`);
  return value;
}

function positive(value, label) {
  nonnegative(value, label);
  if (value === 0) throw new RangeError(`${label} must be positive`);
  return value;
}

function sum(values) {
  const total = values.reduce((total, value) => total + money(value), 0);
  return money(total, "total");
}

export function quoteSale(lines, discountMinor = 0) {
  if (!Array.isArray(lines) || lines.length === 0)
    throw new RangeError("sale needs at least one line");
  const subtotalMinor = sum(
    lines.map((line) => {
      positive(line.quantity, "quantity");
      nonnegative(line.unitPriceMinor, "unit price");
      return money(line.quantity * line.unitPriceMinor, "line total");
    }),
  );
  nonnegative(discountMinor, "discount");
  if (discountMinor > subtotalMinor)
    throw new RangeError("discount exceeds subtotal");
  return {
    subtotalMinor,
    discountMinor,
    totalMinor: subtotalMinor - discountMinor,
  };
}

export function planSale({ totalMinor, tenders, buyer, drawerOpen }) {
  positive(totalMinor, "sale total");
  if (!Array.isArray(tenders) || tenders.length === 0)
    throw new RangeError("sale needs tender");
  if (!drawerOpen) throw new Error("drawer is closed");
  const amounts = { CASH: 0, DEBT: 0, PREPAID: 0 };
  for (const tender of tenders) {
    if (!Object.hasOwn(amounts, tender.type))
      throw new RangeError("invalid tender type");
    amounts[tender.type] = money(
      amounts[tender.type] + positive(tender.amountMinor, "tender"),
      "tender total",
    );
  }
  if (sum(Object.values(amounts)) !== totalMinor)
    throw new RangeError("tenders must equal sale total");
  if (amounts.DEBT || amounts.PREPAID) {
    if (!buyer || buyer.status !== "ACTIVE")
      throw new Error("active buyer account required");
  }
  if (amounts.DEBT) {
    if (!buyer.creditAllowed || buyer.debtRestricted)
      throw new Error("buyer cannot use credit");
    nonnegative(buyer.creditLimitMinor, "credit limit");
    money(buyer.outstandingMinor, "outstanding debt");
    const available = Math.max(
      0,
      buyer.creditLimitMinor - Math.max(0, buyer.outstandingMinor),
    );
    if (amounts.DEBT > available) throw new Error("credit limit exceeded");
  }
  if (amounts.PREPAID) {
    nonnegative(buyer.prepaidBalanceMinor, "prepaid balance");
    if (amounts.PREPAID > buyer.prepaidBalanceMinor)
      throw new Error("prepaid balance exceeded");
  }
  return {
    cashMovementMinor: amounts.CASH,
    debtChargeMinor: amounts.DEBT,
    prepaidDebitMinor: amounts.PREPAID,
    resultingDebtMinor: buyer
      ? money(buyer.outstandingMinor + amounts.DEBT, "resulting debt")
      : null,
  };
}

export function planDebtPayment({
  paymentMinor,
  outstandingMinor,
  method,
  drawerOpen,
  prepaidBalanceMinor = 0,
}) {
  positive(paymentMinor, "payment");
  nonnegative(outstandingMinor, "outstanding debt");
  if (paymentMinor > outstandingMinor)
    throw new RangeError("payment exceeds outstanding debt");
  if (method !== "CASH" && method !== "PREPAID")
    throw new RangeError("unsupported payment method");
  if (method === "CASH" && !drawerOpen) throw new Error("drawer is closed");
  if (
    method === "PREPAID" &&
    paymentMinor > nonnegative(prepaidBalanceMinor, "prepaid balance")
  ) {
    throw new Error("prepaid balance exceeded");
  }
  return {
    debtLedgerAmountMinor: -paymentMinor,
    cashMovementMinor: method === "CASH" ? paymentMinor : 0,
    prepaidDebitMinor: method === "PREPAID" ? paymentMinor : 0,
    resultingDebtMinor: outstandingMinor - paymentMinor,
  };
}

export function allocateOldestFirst(paymentMinor, charges) {
  positive(paymentMinor, "payment");
  let remaining = paymentMinor;
  const allocations = [];
  for (const charge of [...charges].sort(
    (a, b) =>
      a.effectiveAt.localeCompare(b.effectiveAt) || a.id.localeCompare(b.id),
  )) {
    positive(charge.openMinor, "open charge");
    const applied = Math.min(remaining, charge.openMinor);
    if (applied)
      allocations.push({ chargeId: charge.id, amountMinor: applied });
    remaining -= applied;
    if (!remaining) break;
  }
  if (remaining) throw new RangeError("payment exceeds open charges");
  return allocations;
}

export function debtBalance(entries) {
  return sum(
    entries
      .filter((entry) => entry.status === "POSTED")
      .map((entry) => entry.amountMinor),
  );
}

export function reconcileDrawer({
  openingFloatMinor,
  movements,
  countedCashMinor,
}) {
  nonnegative(openingFloatMinor, "opening float");
  nonnegative(countedCashMinor, "counted cash");
  const expectedCashMinor = money(
    openingFloatMinor + sum(movements.map((movement) => movement.amountMinor)),
    "expected cash",
  );
  if (expectedCashMinor < 0)
    throw new RangeError("expected cash cannot be negative");
  return {
    expectedCashMinor,
    countedCashMinor,
    varianceMinor: countedCashMinor - expectedCashMinor,
  };
}

export function reportTotals({ sales, entries, movements }) {
  const posted = sales.filter((sale) => sale.status === "POSTED");
  const grossSalesMinor = sum(posted.map((sale) => sale.totalMinor));
  const cashSalesMinor = sum(posted.map((sale) => sale.cashTenderMinor));
  const newDebtMinor = sum(posted.map((sale) => sale.debtTenderMinor));
  const cashDebtPaymentsMinor = sum(
    movements
      .filter((movement) => movement.type === "DEBT_PAYMENT_CASH_IN")
      .map((movement) => movement.amountMinor),
  );
  return {
    grossSalesMinor,
    cashSalesMinor,
    newDebtMinor,
    cashDebtPaymentsMinor,
    outstandingDebtMinor: debtBalance(entries),
  };
}
