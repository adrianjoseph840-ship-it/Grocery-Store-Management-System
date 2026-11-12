import { request } from "./api.js";
import { sheetPage } from "./slip-sheet.js";

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
  if (tab === "Paper slips") return sheetPage(view, notice, run);
  if (tab === "People & departments") return peoplePage(view, notice, run, role);
  if (tab === "Debt monitor") return debtMonitorPage(view);
  if (tab === "Weekly report") return reportPage(view, notice, run);
}

async function dashboard(view) {
  const [all, week] = await Promise.all([
    request("/paper/report"),
    request(`/paper/report?from=${weekStart(today())}&to=${today()}`),
  ]);
  const max = Math.max(...all.fields.map((f) => f.salesMinor), 1);
  view.innerHTML = `<div class="page-head"><div><div class="eyebrow">PAPER SLIP LEDGER</div><h1>Canteen dashboard</h1><p>Slip sales across all departments.</p></div><span class="pill">Updated now</span></div>
    <div class="grid paper-kpis">${metric("Total sales", all.salesMinor, "All recorded slips")}${metric("This week", week.salesMinor, `${week.from} to ${week.to}`)}</div>
    <div class="card"><h2>Sales by department</h2>${all.fields.map((f) => `<div class="field-line"><div class="field-label"><strong>${esc(f.name)}</strong><span>${pesos(f.salesMinor)}</span></div><div class="field-track"><div style="width:${Math.round((f.salesMinor / max) * 100)}%"></div></div></div>`).join("")}</div>`;
}

async function slipsPage(view, notice, run) {
  const [fields, people, slips] = await Promise.all([
    request("/paper/fields"),
    request("/paper/people"),
    request("/paper/slips"),
  ]);
  view.innerHTML = `<div class="page-head"><div><div class="eyebrow">DAILY ENTRY</div><h1>Paper slips</h1><p>Enter the amount written on each slip. Credit slips are assigned to a person and department.</p></div></div>
    <div class="two"><div class="card"><h2>Record a slip</h2><form id="paperSlipForm"><label>Department<select name="fieldId" id="slipField">${fieldOptions(fields)}</select></label><div id="slipPersonWrap"><label>Person<select name="personId" id="slipPerson"></select></label></div><label>Slip amount (₱)<input name="amount" type="number" min=".01" step=".01" required></label><label>Exact date<input name="slipDate" type="date" value="${today()}" required></label><label>Paper reference (optional)<input name="reference" placeholder="e.g. slip number"></label><button class="full-width">Record slip</button></form><p class="muted">For Cash, no person is needed; it is counted as collected immediately.</p></div>
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
        '<option value="">Add a person under People & departments first</option>';
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
  view.innerHTML = `<div class="page-head"><div><div class="eyebrow">ORGANIZATION</div><h1>People & departments</h1><p>Add workers here so their names can be selected when entering slips.</p></div></div>
    <div class="two"><div class="card"><h2>Add a person</h2><form id="addPaperPerson"><label>Full name<input name="name" required></label><label>Employee code (optional)<input name="employeeCode"></label><label>Department<select name="fieldId">${fieldOptions(fields.filter((f) => f.kind === "CREDIT"))}</select></label><button>Add person</button></form></div>${role === "ADMIN" ? '<div class="card"><h2>Add a department</h2><p class="muted">The default departments are ready. Add another for a new payroll group.</p><form id="addPaperField"><label>Department name<input name="name" placeholder="e.g. Maintenance" required></label><button class="secondary">Add department</button></form></div>' : ""}</div>
    <div class="card"><h2>Search worker debt</h2><form id="workerDebtSearch" class="inline"><label>Worker name or employee code<input name="query" type="search" placeholder="Enter a worker name" autocomplete="off" required></label><button>Search</button></form><div id="workerDebtResults" class="worker-debt-results"></div></div>
    <div class="card"><h2>Worker directory</h2>${people.map((person) => `<div class="row"><div><strong>${esc(person.name)}</strong><div class="muted">${esc(person.field_name)}${person.employee_code ? ` · ${esc(person.employee_code)}` : ""}</div></div><div class="directory-actions"><button type="button" class="secondary" data-edit-person="${person.id}">Edit</button><button type="button" class="secondary danger" data-delete-person="${person.id}">Delete</button></div></div>`).join("") || '<div class="empty">No workers added yet.</div>'}</div>
    <div class="card"><h2>Department directory</h2><div class="field-directory">${fields.map((f) => `<div class="field-directory-item"><div><strong>${esc(f.name)}</strong><div class="muted">${f.kind === "CASH" ? "Immediate cash sales" : `${people.filter((p) => p.field_id === f.id).length} people`}</div></div><div class="directory-actions"><span class="pill">${f.kind === "CASH" ? "Cash" : "Payroll"}</span>${role === "ADMIN" && f.kind !== "CASH" ? `<button type="button" class="secondary" data-edit-field="${f.id}">Edit</button><button type="button" class="secondary danger" data-delete-field="${f.id}">Delete</button>` : ""}</div></div>`).join("")}</div></div>`;
  $("#workerDebtSearch").onsubmit = (event) => {
    event.preventDefault();
    const query = new FormData(event.target).get("query").trim().toLowerCase();
    const matches = people.filter((person) =>
      `${person.name} ${person.employee_code || ""}`.toLowerCase().includes(query),
    );
    $("#workerDebtResults").innerHTML = matches.length
      ? matches.map((person) => `<div class="row"><div><strong>${esc(person.name)}</strong><div class="muted">${esc(person.field_name)}${person.employee_code ? ` · ${esc(person.employee_code)}` : ""}</div></div><div><span class="muted">Total</span><div class="worker-debt-amount">${pesos(person.outstanding_minor)}</div></div></div>`).join("")
      : '<div class="empty">No matching worker found.</div>';
  };
  view.querySelectorAll("[data-edit-person]").forEach((button) => {
    button.onclick = () => {
      const person = people.find((item) => item.id === button.dataset.editPerson);
      const name = prompt("Worker name:", person.name);
      if (name === null) return;
      const employeeCode = prompt("Employee code (optional):", person.employee_code || "");
      if (employeeCode === null) return;
      const fieldName = prompt(
        `Department (${fields.filter((field) => field.kind === "CREDIT").map((field) => field.name).join(", ")}):`,
        person.field_name,
      );
      if (fieldName === null) return;
      const selectedField = fields.find(
        (field) => field.kind === "CREDIT" && field.name.toLowerCase() === fieldName.trim().toLowerCase(),
      );
      if (!selectedField) return notice("Enter an existing payroll department name.", true);
      run(async () => {
        await request(`/paper/people/${person.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name, employeeCode, fieldId: selectedField.id }),
        });
        await peoplePage(view, notice, run, role);
        notice("Worker updated.");
      });
    };
  });
  view.querySelectorAll("[data-delete-person]").forEach((button) => {
    button.onclick = () => {
      const person = people.find((item) => item.id === button.dataset.deletePerson);
      if (!confirm(`Delete ${person.name}? Existing slips will remain in financial history.`)) return;
      run(async () => {
        await request(`/paper/people/${person.id}`, { method: "DELETE" });
        await peoplePage(view, notice, run, role);
        notice("Worker deleted; existing slip history was preserved.");
      });
    };
  });
  view.querySelectorAll("[data-edit-field]").forEach((button) => {
    button.onclick = () => {
      const field = fields.find((item) => item.id === button.dataset.editField);
      const name = prompt("Department name:", field.name);
      if (name === null) return;
      run(async () => {
        await request(`/paper/fields/${field.id}`, {
          method: "PATCH",
          body: JSON.stringify({ name }),
        });
        await peoplePage(view, notice, run, role);
        notice("Field updated.");
      });
    };
  });
  view.querySelectorAll("[data-delete-field]").forEach((button) => {
    button.onclick = () => {
      const field = fields.find((item) => item.id === button.dataset.deleteField);
      if (!confirm(`Delete the ${field.name} field?`)) return;
      run(async () => {
        await request(`/paper/fields/${field.id}`, { method: "DELETE" });
        await peoplePage(view, notice, run, role);
        notice("Field deleted.");
      });
    };
  });
  $("#addPaperPerson").onsubmit = (event) => {
    event.preventDefault();
    run(async () => {
      const data = Object.fromEntries(new FormData(event.target));
      await request("/paper/people", {
        method: "POST",
        body: JSON.stringify(data),
      });
      await peoplePage(view, notice, run, role);
      notice("Person added to department.");
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
        notice("Department added.");
      });
    };
}

async function debtMonitorPage(view) {
  const [people, slips] = await Promise.all([
    request("/paper/people"),
    request("/paper/slips"),
  ]);
  const sorted = [...people].sort(
    (a, b) => b.outstanding_minor - a.outstanding_minor || a.name.localeCompare(b.name),
  );
  const total = people.reduce((sum, person) => sum + person.outstanding_minor, 0);
  const debtors = people.filter((person) => person.outstanding_minor > 0).length;
  view.innerHTML = `<div class="page-head"><div><div class="eyebrow">WORKER BALANCES</div><h1>Debt monitor</h1><p>See every registered worker, their total, and every dated record.</p></div><span class="pill">${people.length} workers</span></div>
    <div class="grid paper-kpis">${metric("Total", total, "Across all registered workers")}<div class="card paper-metric"><div class="eyebrow">Workers with a total</div><div class="metric">${debtors}</div><div class="muted">${debtors} of ${people.length} workers</div></div></div>
    <div class="card"><form id="debtMonitorSearch" class="inline"><label>Search by name, employee code, or department<input id="debtMonitorQuery" name="query" type="search" placeholder="Start typing to locate a worker" autocomplete="off"></label><button type="submit">Search</button></form></div>
    <div class="card"><div class="table-wrap"><table><thead><tr><th>Worker</th><th>Employee code</th><th>Department</th><th>Total</th></tr></thead><tbody id="debtMonitorRows"></tbody></table></div></div><div id="debtRecordResults"></div>`;
  const draw = () => {
    const query = $("#debtMonitorQuery").value.trim().toLowerCase();
    const matches = sorted.filter((person) =>
      `${person.name} ${person.employee_code || ""} ${person.field_name}`.toLowerCase().includes(query),
    );
    $("#debtMonitorRows").innerHTML = matches.length
      ? matches.map((person) => `<tr><td><strong>${esc(person.name)}</strong></td><td>${esc(person.employee_code || "—")}</td><td>${esc(person.field_name)}</td><td class="debt-value ${person.outstanding_minor > 0 ? "has-debt" : ""}">${pesos(person.outstanding_minor)}</td></tr>`).join("")
      : '<tr><td colspan="4"><div class="empty">No matching worker found.</div></td></tr>';
    $("#debtRecordResults").innerHTML = query
      ? matches.map((person) => {
          const records = slips.filter((slip) =>
            slip.person_id === person.id ||
            (!slip.person_id && slip.field_id === person.field_id && slip.display_name?.toLowerCase() === person.name.toLowerCase()),
          );
          return `<div class="card"><div class="page-head"><div><h2>${esc(person.name)}</h2><p>${esc(person.field_name)} department</p></div><strong class="debt-value ${person.outstanding_minor > 0 ? "has-debt" : ""}">Total: ${pesos(person.outstanding_minor)}</strong></div><div class="table-wrap"><table><thead><tr><th>Exact date</th><th>Slip amount</th><th>Collected</th><th>Total</th></tr></thead><tbody>${records.length ? records.map((record) => `<tr><td>${esc(record.slip_date)}</td><td>${pesos(record.amount_minor)}</td><td>${pesos(record.collected_minor)}</td><td class="debt-value ${(record.amount_minor - record.collected_minor) > 0 ? "has-debt" : ""}">${pesos(record.amount_minor - record.collected_minor)}</td></tr>`).join("") : '<tr><td colspan="4" class="muted">No records for this person.</td></tr>'}</tbody></table></div></div>`;
        }).join("")
      : '<div class="card empty">Search for a person to see all exact dates and records.</div>';
  };
  $("#debtMonitorQuery").oninput = draw;
  $("#debtMonitorSearch").onsubmit = (event) => {
    event.preventDefault();
    draw();
  };
  draw();
}

async function collectionsPage(view, notice, run) {
  const slips = (await request("/paper/slips")).filter(
    (s) => s.field_kind === "CREDIT" && s.amount_minor > s.collected_minor,
  );
  view.innerHTML = `<div class="page-head"><div><div class="eyebrow">PAYROLL & PAYMENTS</div><h1>Collections</h1><p>Record each payroll deduction or partial cash payment against its original slip.</p></div></div><div class="card"><h2>Unpaid slips</h2>${slips.map((s) => `<div class="slip-row"><div><strong>${esc(s.display_name || "Unnamed slip")}</strong><div class="muted">${esc(s.field_name)} · ${esc(s.slip_date)} · ${esc(s.reference || "No reference")}</div><div class="muted">Original ${pesos(s.amount_minor)} · Remaining ${pesos(s.amount_minor - s.collected_minor)}</div></div><button class="secondary" data-collect="${s.id}">Collect</button></div>`).join("") || '<div class="empty">No unpaid slips.</div>'}</div><div id="collectionEditor"></div>`;
  view.querySelectorAll("[data-collect]").forEach(
    (button) =>
      (button.onclick = () => {
        const slip = slips.find((s) => s.id === button.dataset.collect);
        $("#collectionEditor").innerHTML =
          `<div class="card"><h2>Collect from ${esc(slip.display_name || "Unnamed slip")}</h2><p>Remaining on this slip: <strong>${pesos(slip.amount_minor - slip.collected_minor)}</strong></p><form id="collectForm"><label>Amount (₱)<input name="amount" type="number" min=".01" max="${((slip.amount_minor - slip.collected_minor) / 100).toFixed(2)}" step=".01" required></label><label>Method<select name="method"><option value="PAYROLL">Payroll deduction</option><option value="CASH">Cash payment</option></select></label><label>Collection date<input name="collectionDate" type="date" value="${today()}" required></label><label>Reference (optional)<input name="reference" placeholder="Payroll batch or receipt"></label><button>Record collection</button></form></div>`;
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
        `<div class="grid">${metric("Slip sales", r.salesMinor, "Recorded in exact date range")}${metric("Collected", r.collectedMinor, "Received in exact date range")}${metric("Cash", r.cashMinor, "Cash slips and payments")}${metric("Payroll", r.payrollMinor, "Deductions received")}</div><div class="card"><h2>Department breakdown</h2><div class="table-wrap"><table><thead><tr><th>Department</th><th>Slip sales</th><th>Collected</th><th>Total as of ${esc(to)}</th></tr></thead><tbody>${r.fields.map((f) => `<tr><td>${esc(f.name)}</td><td>${pesos(f.salesMinor)}</td><td>${pesos(f.collectedMinor)}</td><td>${pesos(f.outstandingMinor)}</td></tr>`).join("")}</tbody></table></div></div>`;
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
