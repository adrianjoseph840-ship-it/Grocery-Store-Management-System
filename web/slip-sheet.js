import { request } from "./api.js";

/** Spreadsheet-style batch entry for paper slips; the server saves all rows atomically. */
const $ = (selector) => document.querySelector(selector);
const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const pesos = (minor) =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(
    (minor || 0) / 100,
  );
const today = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });

export async function sheetPage(view, notice, run) {
  const [fields, slips] = await Promise.all([
    request("/paper/fields"),
    request("/paper/slips"),
  ]);
  const defaultField =
    fields.find((field) => field.name === "Guards")?.id || fields[0]?.id;

  // Each row is one paper slip. A blank name is valid even for payroll fields.
  const row = () => `<tr class="sheet-entry">
    <td class="row-number"></td>
    <td><select class="sheet-field" aria-label="Field">${fields.map((field) => `<option value="${field.id}" ${field.id === defaultField ? "selected" : ""}>${esc(field.name)}</option>`).join("")}</select></td>
    <td><input class="sheet-name" aria-label="Name (optional)" placeholder="Optional name" maxlength="120" autocomplete="off"></td>
    <td><input class="sheet-amount" aria-label="Slip amount in pesos" type="number" min="0.01" step="0.01" placeholder="0.00"></td>
    <td><input class="sheet-date" aria-label="Slip date" type="date" value="${today()}"></td>
    <td><button type="button" class="sheet-remove secondary" aria-label="Remove row">×</button></td>
  </tr>`;

  view.innerHTML = `<div class="page-head"><div><div class="eyebrow">DAILY ENTRY</div><h1>Paper slip sheet</h1><p>Type across the rows like a spreadsheet. Names are optional; every slip is counted under its field.</p></div></div>
    <div class="card"><form id="sheetForm"><div class="table-wrap"><table class="sheet-table"><thead><tr><th>#</th><th>Field</th><th>Name (optional)</th><th>Slip amount (₱)</th><th>Date</th><th></th></tr></thead><tbody id="sheetRows">${Array.from({ length: 5 }, row).join("")}</tbody></table></div>
      <div class="sheet-actions"><button id="addSheetRow" type="button" class="secondary">+ Add row</button><div class="sheet-total"><span id="sheetCount">0 slips</span><strong id="sheetTotal">${pesos(0)}</strong></div><button id="saveSheet" type="submit">Save all slips</button></div></form><p class="muted">Cash field amounts count as collected immediately. The other fields count as paper slip sales until payment is recorded.</p></div>
    <div class="card"><h2>Recently saved slips</h2><div class="table-wrap"><table><thead><tr><th>Date</th><th>Field</th><th>Name</th><th>Amount</th></tr></thead><tbody>${slips.map((slip) => `<tr><td>${esc(slip.slip_date)}</td><td>${esc(slip.field_name)}</td><td>${esc(slip.display_name || "—")}</td><td>${pesos(slip.amount_minor)}</td></tr>`).join("") || '<tr><td colspan="4" class="muted">No slips saved yet.</td></tr>'}</tbody></table></div></div>`;

  const renumber = () =>
    view
      .querySelectorAll("#sheetRows .row-number")
      .forEach((cell, index) => (cell.textContent = index + 1));
  const updateTotal = () => {
    const values = [...view.querySelectorAll("#sheetRows .sheet-amount")].map(
      (input) => Number(input.value || 0),
    );
    const count = values.filter((value) => value > 0).length;
    $("#sheetCount").textContent = `${count} slip${count === 1 ? "" : "s"}`;
    $("#sheetTotal").textContent = pesos(
      Math.round(
        values.reduce(
          (sum, value) => sum + (Number.isFinite(value) ? value : 0),
          0,
        ) * 100,
      ),
    );
  };
  renumber();
  $("#sheetRows").oninput = updateTotal;
  $("#sheetRows").onclick = (event) => {
    if (!event.target.closest(".sheet-remove")) return;
    event.target.closest("tr").remove();
    if (!$("#sheetRows").children.length)
      $("#sheetRows").insertAdjacentHTML("beforeend", row());
    renumber();
    updateTotal();
  };
  $("#addSheetRow").onclick = () => {
    $("#sheetRows").insertAdjacentHTML("beforeend", row());
    renumber();
  };
  $("#sheetForm").onsubmit = (event) => {
    event.preventDefault();
    run(async () => {
      const slipsToSave = [...view.querySelectorAll("#sheetRows tr")]
        .map((entry, index) => {
          const name = entry.querySelector(".sheet-name").value.trim();
          const value = entry.querySelector(".sheet-amount").value.trim();
          if (!value) {
            if (name) throw new Error(`Row ${index + 1}: enter a slip amount.`);
            return null;
          }
          const amountMinor = Math.round(Number(value) * 100);
          if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0)
            throw new Error(`Row ${index + 1}: enter a positive amount.`);
          return {
            fieldId: entry.querySelector(".sheet-field").value,
            name,
            amountMinor,
            slipDate: entry.querySelector(".sheet-date").value,
          };
        })
        .filter(Boolean);
      if (!slipsToSave.length)
        throw new Error("Enter at least one slip amount.");
      const button = $("#saveSheet");
      button.disabled = true;
      try {
        await request("/paper/slips/batch", {
          method: "POST",
          body: JSON.stringify({ slips: slipsToSave }),
        });
        await sheetPage(view, notice, run);
        const totalMinor = slipsToSave.reduce(
          (sum, slip) => sum + slip.amountMinor,
          0,
        );
        notice(
          `${slipsToSave.length} slip${slipsToSave.length === 1 ? "" : "s"} saved · ${pesos(totalMinor)} total.`,
        );
      } finally {
        button.disabled = false;
      }
    });
  };
}
