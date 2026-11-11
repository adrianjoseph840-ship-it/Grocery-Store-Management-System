import { request } from "./api.js";

/** Screens for the paper-slip workflow. The API remains the source of all totals. */
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
const centavos = (value) => Math.round(Number(value) * 100);
const today = () =>
  new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Manila" });
const weekStart = (day) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
};
const addDays = (day, count) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
};
const fieldOptions = (fields) =>
  fields.map((f) => `<option value="${f.id}">${esc(f.name)}</option>`).join("");
const metric = (label, value, note) =>
  `<div class="card paper-metric"><div class="eyebrow">${label}</div><div class="metric">${pesos(value)}</div><div class="muted">${note}</div></div>`;

export async function renderPaperPage(tab, view, notice, role) {
  const run = async (action) => {
    try {
      await action();
    } catch (error) {
      notice(error.message, true);
    }
  };
  if (tab === "Dashboard") return dashboard(view);
  if (tab === "Paper slips") return slipsPage(view, notice, run);
  if (tab === "People & fields") return peoplePage(view, notice, run, role);
  if (tab === "Collections") return collectionsPage(view, notice, run);
  if (tab === "Weekly report") return reportPage(view, notice, run);
}

async function dashboard(view) {
  const [all, week] = await Promise.all([
    request("/paper/report"),
    request(`/paper/report?from=${weekStart(today())}&to=${today()}`),
  ]);
  const max = Math.max(...all.fields.map((f) => f.salesMinor), 1);
  view.innerHTML = `<div class="page-head"><div><div class="eyebrow">PAPER SLIP LEDGER</div><h1>Canteen dashboard</h1><p>Sales recorded, money collected, and unpaid slips across all fields.</p></div><span class="pill">Updated now</span></div>
    <div class="grid paper-kpis">${metric("Total sales", all.salesMinor, "All recorded slips")}${metric("Money collected", all.collectedMinor, "Cash and payroll received")}${metric("Outstanding", all.outstandingMinor, "Still to be deducted or paid")}${metric("This week", week.salesMinor, `${week.from} to ${week.to}`)}</div>
    <div class="two"><div class="card"><h2>Sales by field</h2><p class="muted">Each person's paper slips stay in their field.</p>${all.fields.map((f) => `<div class="field-line"><div class="field-label"><strong>${esc(f.name)}</strong><span>${pesos(f.salesMinor)}</span></div><div class="field-track"><div style="width:${Math.round((f.salesMinor / max) * 100)}%"></div></div></div>`).join("")}</div>
    <div class="card"><h2>Collection breakdown</h2><div class="summary-line"><span>Cash received</span><strong>${pesos(all.cashMinor)}</strong></div><div class="summary-line"><span>Payroll deductions received</span><strong>${pesos(all.payrollMinor)}</strong></div><div class="summary-line emphasis"><span>Still outstanding</span><strong>${pesos(all.outstandingMinor)}</strong></div><p class="muted">A slip counts as a sale when entered. It counts as collected only when paid in cash or deducted from payroll.</p></div></div>`;
}

async function slipsPage(view, notice, run) {
  const [fields, people, slips] = await Promise.all([
    request("/paper/fields"),
    request("/paper/people"),
    request("/paper/slips"),
  ]);
  view.innerHTML = `<div class="page-head"><div><div class="eyebrow">DAILY ENTRY</div><h1>Paper slips</h1><p>Enter the amount written on each slip. Credit slips are assigned to a person and field.</p></div></div>
    <div class="two"><div class="card"><h2>Record a slip</h2><form id="paperSlipForm"><label>Field<select name="fieldId" id="slipField">${fieldOptions(fields)}</select></label><div id="slipPersonWrap"><label>Person<select name="personId" id="slipPerson"></select></label></div><label>Slip amount (₱)<input name="amount" type="number" min=".01" step=".01" required></label><label>Slip date<input name="slipDate" type="date" value="${today()}" required></label><label>Paper reference (optional)<input name="reference" placeholder="e.g. slip number"></label><button class="full-width">Record slip</button></form><p class="muted">For Cash, no person is needed; it is counted as collected immediately.</p></div>
    <div class="card"><h2>Recent slips</h2><div class="paper-scroll">${slips.map((s) => `<div class="slip-row"><div><strong>${esc(s.person_name || "Cash sale")}</strong><div class="muted">${esc(s.field_name)} · ${esc(s.slip_date)} ${s.reference ? `· ${esc(s.reference)}` : ""}</div></div><div class="right"><strong>${pesos(s.amount_minor)}</strong><div class="muted">${s.person_id ? `${pesos(s.amount_minor - s.collected_minor)} open` : "Collected"}</div></div></div>`).join("") || '<div class="empty">No paper slips yet.</div>'}</div></div></div>`;
  const selected = () => fields.find((f) => f.id === $("#slipField").value);
  const updatePeople = () => {
    const selectedField = selected();
    $("#slipPersonWrap").hidden = selectedField.kind === "CASH";
    const matches = people.filter((p) => p.field_id === selectedField.id);
    $("#slipPerson").innerHTML = matches
      .map(
        (p) =>
          `<option value="${p.id}">${esc(p.name)}${p.employee_code ? ` (${esc(p.employee_code)})` : ""}</option>`,
      )
      .join("");
    if (!matches.length && selectedField.kind === "CREDIT")
      $("#slipPerson").innerHTML =
        '<option value="">Add a person under People & fields first</option>';
  };
  $("#slipField").onchange = updatePeople;
  updatePeople();
  $("#paperSlipForm").onsubmit = (event) => {
    event.preventDefault();
    run(async () => {
      const data = Object.fromEntries(new FormData(event.target));
      await request("/paper/slips", {
        method: "POST",
        body: JSON.stringify({
          fieldId: data.fieldId,
          personId: data.personId || null,
          amountMinor: centavos(data.amount),
          slipDate: data.slipDate,
          reference: data.reference,
        }),
      });
      await slipsPage(view, notice, run);
      notice("Paper slip recorded.");
    });
  };
}

async function peoplePage(view, notice, run, role) {
  const [fields, people] = await Promise.all([
    request("/paper/fields"),
    request("/paper/people"),
  ]);
  view.innerHTML = `<div class="page-head"><div><div class="eyebrow">ORGANIZATION</div><h1>People & fields</h1><p>Put each person in their field so every slip contributes to the right total.</p></div></div>
    <div class="two"><div class="card"><h2>Add a person</h2><form id="addPaperPerson"><label>Full name<input name="name" required></label><label>Employee code (optional)<input name="employeeCode"></label><label>Field<select name="fieldId">${fieldOptions(fields.filter((f) => f.kind === "CREDIT"))}</select></label><button>Add person</button></form></div>${role === "ADMIN" ? '<div class="card"><h2>Add a field</h2><p class="muted">The default fields are ready. Add another for a new payroll group.</p><form id="addPaperField"><label>Field name<input name="name" placeholder="e.g. Maintenance" required></label><button class="secondary">Add field</button></form></div>' : ""}</div>
    <div class="card"><h2>Field directory</h2><div class="field-directory">${fields.map((f) => `<div class="field-directory-item"><div><strong>${esc(f.name)}</strong><div class="muted">${f.kind === "CASH" ? "Immediate cash sales" : `${people.filter((p) => p.field_id === f.id).length} people`}</div></div><span class="pill">${f.kind === "CASH" ? "Cash" : "Payroll"}</span></div>`).join("")}</div></div>`;
  $("#addPaperPerson").onsubmit = (event) => {
    event.preventDefault();
    run(async () => {
      const data = Object.fromEntries(new FormData(event.target));
      await request("/paper/people", {
        method: "POST",
        body: JSON.stringify(data),
      });
      await peoplePage(view, notice, run, role);
      notice("Person added to field.");
    });
  };
  if (role === "ADMIN")
    $("#addPaperField").onsubmit = (event) => {
      event.preventDefault();
      run(async () => {
        const data = Object.fromEntries(new FormData(event.target));
        await request("/paper/fields", {
          method: "POST",
          body: JSON.stringify(data),
        });
        await peoplePage(view, notice, run, role);
        notice("Field added.");
      });
    };
}

async function collectionsPage(view, notice, run) {
  const slips = (await request("/paper/slips")).filter(
    (s) => s.person_id && s.amount_minor > s.collected_minor,
  );
  view.innerHTML = `<div class="page-head"><div><div class="eyebrow">PAYROLL & PAYMENTS</div><h1>Collections</h1><p>Record each payroll deduction or partial cash payment against its original slip.</p></div></div><div class="card"><h2>Unpaid slips</h2>${slips.map((s) => `<div class="slip-row"><div><strong>${esc(s.person_name)}</strong><div class="muted">${esc(s.field_name)} · ${esc(s.slip_date)} · ${esc(s.reference || "No reference")}</div><div class="muted">Original ${pesos(s.amount_minor)} · Remaining ${pesos(s.amount_minor - s.collected_minor)}</div></div><button class="secondary" data-collect="${s.id}">Collect</button></div>`).join("") || '<div class="empty">No unpaid slips.</div>'}</div><div id="collectionEditor"></div>`;
  view.querySelectorAll("[data-collect]").forEach(
    (button) =>
      (button.onclick = () => {
        const slip = slips.find((s) => s.id === button.dataset.collect);
        $("#collectionEditor").innerHTML =
          `<div class="card"><h2>Collect from ${esc(slip.person_name)}</h2><p>Remaining on this slip: <strong>${pesos(slip.amount_minor - slip.collected_minor)}</strong></p><form id="collectForm"><label>Amount (₱)<input name="amount" type="number" min=".01" max="${((slip.amount_minor - slip.collected_minor) / 100).toFixed(2)}" step=".01" required></label><label>Method<select name="method"><option value="PAYROLL">Payroll deduction</option><option value="CASH">Cash payment</option></select></label><label>Collection date<input name="collectionDate" type="date" value="${today()}" required></label><label>Reference (optional)<input name="reference" placeholder="Payroll batch or receipt"></label><button>Record collection</button></form></div>`;
        $("#collectionEditor").scrollIntoView({
          behavior: "smooth",
          block: "start",
        });
        $("#collectForm").onsubmit = (event) => {
          event.preventDefault();
          run(async () => {
            const data = Object.fromEntries(new FormData(event.target));
            await request("/paper/collections", {
              method: "POST",
              body: JSON.stringify({
                slipId: slip.id,
                amountMinor: centavos(data.amount),
                method: data.method,
                collectionDate: data.collectionDate,
                reference: data.reference,
              }),
            });
            await collectionsPage(view, notice, run);
            notice("Collection recorded.");
          });
        };
      }),
  );
}

async function reportPage(view, notice, run) {
  const start = weekStart(today());
  view.innerHTML = `<div class="page-head"><div><div class="eyebrow">INCOME REPORT</div><h1>Weekly & part-week</h1><p>Choose any dates to see sales and collections for only that part of the week.</p></div></div><div class="card"><div class="report-presets"><button class="secondary" id="thisWeek">This week</button><button class="secondary" id="lastWeek">Last week</button></div><form id="paperReportForm" class="inline"><label>From<input name="from" type="date" value="${start}" required></label><label>To<input name="to" type="date" value="${today()}" required></label><button>Run report</button></form></div><div id="paperReportResult"></div>`;
  const runReport = () =>
    run(async () => {
      const { from, to } = Object.fromEntries(
        new FormData($("#paperReportForm")),
      );
      const r = await request(
        `/paper/report?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      );
      $("#paperReportResult").innerHTML =
        `<div class="grid">${metric("Slip sales", r.salesMinor, "Recorded in date range")}${metric("Collected", r.collectedMinor, "Received in date range")}${metric("Cash", r.cashMinor, "Cash slips and payments")}${metric("Payroll", r.payrollMinor, "Deductions received")}</div><div class="card"><h2>Field breakdown</h2><div class="table-wrap"><table><thead><tr><th>Field</th><th>Slip sales</th><th>Collected</th><th>Outstanding as of ${esc(to)}</th></tr></thead><tbody>${r.fields.map((f) => `<tr><td>${esc(f.name)}</td><td>${pesos(f.salesMinor)}</td><td>${pesos(f.collectedMinor)}</td><td>${pesos(f.outstandingMinor)}</td></tr>`).join("")}</tbody></table></div></div>`;
    });
  $("#paperReportForm").onsubmit = (event) => {
    event.preventDefault();
    runReport();
  };
  $("#thisWeek").onclick = () => {
    $("[name=from]").value = start;
    $("[name=to]").value = today();
    runReport();
  };
  $("#lastWeek").onclick = () => {
    $("[name=from]").value = addDays(start, -7);
    $("[name=to]").value = addDays(start, -1);
    runReport();
  };
  runReport();
}
