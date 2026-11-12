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
  const [fields, people, slips] = await Promise.all([
    request("/paper/fields"),
    request("/paper/people"),
    request("/paper/slips"),
  ]);
  // Registered workers are displayed automatically; an extra blank row handles unknown names.
  const row = (person = null) => `<tr class="sheet-entry" data-person-id="${person?.id || ""}">
    <td class="row-number"></td>
    <td class="sheet-person-name">${person ? esc(person.name) : ""}</td>
    <td><input class="sheet-amount" aria-label="Slip amount in pesos" type="number" min="0.01" step="0.01" placeholder="0.00"></td>
    <td><input class="sheet-date" aria-label="Slip date" type="date" value="${today()}"></td>
    <td><button type="button" class="sheet-remove secondary" aria-label="Remove row">×</button></td>
  </tr>`;

  view.innerHTML = `<div class="page-head"><div><div class="eyebrow">DAILY ENTRY</div><h1>Paper slip sheet</h1><p>Choose the department once, then enter every slip for that department below.</p></div></div>
    <div class="card"><form id="sheetForm"><label>Department<select id="sheetFixedField" aria-label="Department">${fields.map((field) => `<option value="${field.id}">${esc(field.name)}</option>`).join("")}</select></label><p class="muted">Workers added under People & departments appear automatically. The final blank row can be used when the name is unknown.</p><div class="table-wrap"><table class="sheet-table"><thead><tr><th>#</th><th>Name</th><th>Slip amount (₱)</th><th>Exact date</th><th></th></tr></thead><tbody id="sheetRows"></tbody></table></div>
      <div class="sheet-actions"><button id="addSheetRow" type="button" class="secondary">+ Add row</button><div class="sheet-total"><span id="sheetCount">0 slips</span><strong id="sheetTotal">${pesos(0)}</strong></div><button id="saveSheet" type="submit">Save all slips</button></div></form></div>
    <div class="card"><h2>Recently saved slips</h2><div class="table-wrap"><table><thead><tr><th>Exact date</th><th>Department</th><th>Name</th><th>Amount</th></tr></thead><tbody>${slips.map((slip) => `<tr><td>${esc(slip.slip_date)}</td><td>${esc(slip.field_name)}</td><td>${esc(slip.display_name || "—")}</td><td>${pesos(slip.amount_minor)}</td></tr>`).join("") || '<tr><td colspan="4" class="muted">No slips saved yet.</td></tr>'}</tbody></table></div></div>`;

  const fillWorkerRows = () => {
    const selectedField = fields.find((field) => field.id === $("#sheetFixedField").value);
    const matches = people.filter((person) => person.field_id === selectedField.id);
    $("#sheetRows").innerHTML =
      (selectedField.kind === "CASH" ? "" : matches.map((person) => row(person)).join("")) + row();
    renumber();
    updateTotal();
  };
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
  $("#sheetFixedField").onchange = fillWorkerRows;
  fillWorkerRows();
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
          const personId = entry.dataset.personId;
          const value = entry.querySelector(".sheet-amount").value.trim();
          if (!value) {
            return null;
          }
          const amountMinor = Math.round(Number(value) * 100);
          if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0)
            throw new Error(`Row ${index + 1}: enter a positive amount.`);
          return {
            fieldId: $("#sheetFixedField").value,
            personId: personId || null,
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
