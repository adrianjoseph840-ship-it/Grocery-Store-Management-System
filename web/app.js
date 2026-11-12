import { request } from "./api.js";
import { renderPaperPage } from "./paper-ui.js";

if ("serviceWorker" in navigator)
  window.addEventListener("load", () =>
    navigator.serviceWorker.register("/service-worker.js").catch(() => {}),
  );

// UI rendering stays role-specific; every permission is also checked by the API.
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
const minor = (value) => Math.round(Number(value) * 100);
let me,
  users = [],
  items = [],
  cart = [],
  selectedBuyer = "";
function notice(message, error = false) {
  $("#notice").textContent = message;
  $("#notice").className = error ? "error" : "";
}
async function act(fn) {
  try {
    await fn();
    notice("Saved successfully.");
  } catch (error) {
    notice(error.message, true);
  }
}
const form = (event) => Object.fromEntries(new FormData(event.target));
async function boot() {
  try {
    // Detect VS Code Live Server and other static previews before login.
    await request("/health");
    $("#loginForm button").disabled = false;
    $("#loginForm button").textContent = "Log in";
    me = await request("/me");
    showApp();
  } catch (error) {
    document.body.classList.add("login-mode");
    $("#login").hidden = false;
    $("#app").hidden = true;
    if (error.status !== 401) {
      $("#loginError").textContent = error.message;
      $("#loginError").hidden = false;
      $("#loginForm button").disabled = true;
    }
  }
}
async function showApp() {
  document.body.classList.remove("login-mode");
  $("#login").hidden = true;
  $("#app").hidden = false;
  if (me.must_change_password) return showRequiredPasswordChange();
  $("#identity").innerHTML =
    `${esc(me.name)} · ${esc(me.role)} <button class="secondary" id="logout">Log out</button>`;
  $("#logout").onclick = async () => {
    await request("/logout", { method: "POST" });
    location.reload();
  };
  const tabs =
    me.role === "ADMIN"
      ? [
          "Dashboard",
          "Paper slips",
          "People & departments",
          "Debt monitor",
          "Weekly report",
          "Accounts",
          "Audit",
          "My profile",
        ]
      : me.role === "CASHIER"
        ? [
            "Dashboard",
            "Paper slips",
            "People & departments",
            "Debt monitor",
            "Weekly report",
            "My profile",
          ]
        : me.role === "GUARD"
          ? ["Verify", "My profile"]
          : ["My account", "My profile"];
  $("#nav").innerHTML = tabs
    .map(
      (tab, i) =>
        `<button data-tab="${tab}" class="${i ? "" : "active"}">${tab}</button>`,
    )
    .join("");
  $("#nav").onclick = (e) => {
    if (e.target.dataset.tab) {
      $("#nav button.active")?.classList.remove("active");
      e.target.classList.add("active");
      render(e.target.dataset.tab);
    }
  };
  render(tabs[0]);
}
function showRequiredPasswordChange() {
  $("#identity").innerHTML = `${esc(me.name)} <button class="secondary" id="logout">Log out</button>`;
  $("#nav").innerHTML = "";
  $("#notice").textContent = "";
  $("#view").innerHTML = `<div class="card password-change-card"><div class="eyebrow">ACCOUNT SECURITY</div><h1>Create your own password</h1><p>Your administrator gave you a temporary password. Change it before using the canteen system.</p><form id="requiredPasswordForm"><label>Temporary password<input name="currentPassword" type="password" autocomplete="current-password" required></label><label>New password (12+ characters)<input name="newPassword" type="password" minlength="12" autocomplete="new-password" required></label><label>Confirm new password<input name="confirmPassword" type="password" minlength="12" autocomplete="new-password" required></label><button class="full-width">Change password and continue</button></form><p id="passwordChangeError" class="error" role="alert" hidden></p></div>`;
  $("#logout").onclick = async () => {
    await request("/logout", { method: "POST" });
    location.reload();
  };
  $("#requiredPasswordForm").onsubmit = async (event) => {
    event.preventDefault();
    const button = event.target.querySelector("button");
    const error = $("#passwordChangeError");
    button.disabled = true;
    error.hidden = true;
    try {
      me = await request("/change-password", {
        method: "POST",
        body: JSON.stringify(form(event)),
      });
      await showApp();
      notice("Password changed successfully.");
    } catch (cause) {
      error.textContent = cause.message;
      error.hidden = false;
    } finally {
      button.disabled = false;
    }
  };
}
async function render(tab) {
  notice("");
  try {
    if (
      [
        "Dashboard",
        "Paper slips",
        "People & departments",
        "Debt monitor",
        "Collections",
        "Weekly report",
      ].includes(tab)
    )
      return await renderPaperPage(tab, $("#view"), notice, me.role);
    // Await each screen so connection failures land in the visible status area.
    if (tab === "Overview") return await overview();
    if (tab === "POS") return await pos();
    if (tab === "Sales") return await sales();
    if (tab === "Reports") return await reports();
    if (tab === "Buyers") return await buyers();
    if (tab === "Menu") return await menu();
    if (tab === "Accounts") return await team();
    if (tab === "Audit") return await audit();
    if (tab === "Verify") return await verify();
    if (tab === "My account") return await account(me.id);
    if (tab === "My profile") return profile();
  } catch (error) {
    notice(error.message, true);
  }
}
function profile() {
  const photo = me.profile_picture
    ? `<img class="profile-photo" src="${me.profile_picture}" alt="${esc(me.name)} profile picture">`
    : `<div class="profile-photo profile-placeholder" aria-hidden="true">${esc(me.name?.[0]?.toUpperCase() || "?")}</div>`;
  $("#view").innerHTML =
    `<div class="page-head"><div><div class="eyebrow">MY PROFILE</div><h1>Profile and security</h1><p>Update your personal information and password.</p></div></div><div class="two"><div class="card"><div class="profile-heading">${photo}<div><h2>${esc(me.name)}</h2><span class="pill">${esc(me.role)}</span></div></div><form id="profileForm"><label>Profile picture<input name="picture" type="file" accept="image/png,image/jpeg,image/webp"></label><p class="muted">PNG, JPEG, or WebP; maximum 250 KB. Leave empty to keep the current picture.</p>${me.profile_picture ? '<label><input name="removePicture" type="checkbox"> Remove current picture</label>' : ""}<label>Full name<input name="name" value="${esc(me.name)}" required></label><label>Username<input name="username" value="${esc(me.username)}" required></label><label>Profile details<textarea name="profileDetails" maxlength="500" rows="5" placeholder="Position, contact details, or other useful information">${esc(me.profile_details || "")}</textarea></label><button>Save profile</button></form></div><div class="card"><h2>Change password</h2><p>Passwords cannot be viewed. If you forget yours, an administrator can set a new temporary password.</p><form id="profilePasswordForm"><label>Current password<input name="currentPassword" type="password" autocomplete="current-password" required></label><label>New password (12+ characters)<input name="newPassword" type="password" minlength="12" autocomplete="new-password" required></label><label>Confirm new password<input name="confirmPassword" type="password" minlength="12" autocomplete="new-password" required></label><button>Change password</button></form></div></div>`;
  $("#profileForm").onsubmit = (event) => {
    event.preventDefault();
    act(async () => {
      const fields = form(event);
      const file = event.target.elements.picture.files[0];
      if (file?.size > 250000) throw Error("Profile picture must be under 250 KB.");
      const profilePicture = fields.removePicture
        ? ""
        : file
          ? await readImage(file)
          : me.profile_picture || "";
      me = await request("/profile", {
        method: "PATCH",
        body: JSON.stringify({
          name: fields.name,
          username: fields.username,
          profileDetails: fields.profileDetails,
          profilePicture,
        }),
      });
      await showApp();
      document.querySelector('[data-tab="My profile"]')?.click();
    });
  };
  $("#profilePasswordForm").onsubmit = (event) => {
    event.preventDefault();
    act(async () => {
      me = await request("/change-password", {
        method: "POST",
        body: JSON.stringify(form(event)),
      });
      event.target.reset();
    });
  };
}
function readImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(Error("Could not read the selected image."));
    reader.readAsDataURL(file);
  });
}
async function overview() {
  const r = await request("/reports/summary");
  $("#view").innerHTML = `<h1>Financial overview</h1><div class="grid">${[
    ["Gross sales", r.gross],
    ["Cash sales", r.cash],
    ["New debt", r.debt],
    ["Cash debt payments", r.cashDebtPayments],
    ["Total", r.outstanding],
  ]
    .map(
      ([label, value]) =>
        `<div class="card"><div class="muted">${label}</div><div class="metric">${pesos(value)}</div></div>`,
    )
    .join(
      "",
    )}</div><div class="card"><h2>By section</h2><table><tr><th>Section</th><th>Revenue</th><th>New debt</th></tr>${r.sections.map((s) => `<tr><td>${esc(s.name)}</td><td>${pesos(s.revenue)}</td><td>${pesos(s.newDebt)}</td></tr>`).join("")}</table></div>`;
}
async function pos() {
  // Prices are displayed from the menu, then recalculated by the server on checkout.
  [items, users] = await Promise.all([request("/items"), request("/users")]);
  const drawer = await request("/drawers/current");
  $("#view").innerHTML =
    `<div class="page-head"><div><div class="eyebrow">CASHIER WORKSPACE</div><h1>Point of sale</h1><p>Choose items, review the payment split, then post the sale.</p></div><span class="pill ${drawer ? "" : "warning"}">${drawer ? "Drawer open" : "Drawer closed"}</span></div>
  <div class="card drawer-bar">${drawer ? `<span>Opening float <strong>${pesos(drawer.opening)}</strong></span><button class="secondary" id="closeDrawer">Close drawer</button>` : `<form id="openDrawer" class="inline"><label>Opening float (₱)<input name="opening" type="number" min="0" step=".01" value="0" required></label><button>Open drawer</button></form>`}</div>
  <div class="pos-grid"><div class="card"><h2>Menu</h2><label>Search items<input id="menuSearch" type="search" placeholder="Search by item name" autocomplete="off"></label><div id="menuList" class="menu-grid"></div></div>
  <div class="card checkout-card"><h2>Current sale</h2><label>Buyer<select id="buyer"><option value="">Walk-in customer · cash only</option>${users
    .filter((u) => u.role === "BUYER" && u.active)
    .map(
      (u) =>
        `<option value="${u.id}" ${selectedBuyer === u.id ? "selected" : ""}>${esc(u.name)} (${esc(u.username)})</option>`,
    )
    .join(
      "",
    )}</select></label><div id="buyerInfo"></div><div id="cart"></div><form id="checkout"><label>Cash applied to this sale (₱)<input id="cashAmount" name="cash" type="number" min="0" step=".01" value="0" required></label><div id="split"></div><button class="full-width" ${drawer ? "" : "disabled"}>Review sale</button></form><div id="saleReview"></div></div></div>`;
  const drawMenu = () => {
    const term = $("#menuSearch").value.toLowerCase().trim();
    const matches = items.filter(
      (i) => i.available && i.name.toLowerCase().includes(term),
    );
    $("#menuList").innerHTML =
      matches
        .map(
          (i) =>
            `<button class="menu-tile" data-add="${i.id}"><strong>${esc(i.name)}</strong><span>${pesos(i.price)}</span></button>`,
        )
        .join("") || '<div class="empty">No matching items</div>';
  };
  drawMenu();
  $("#menuSearch").oninput = drawMenu;
  $("#view").onclick = (e) => {
    const add = e.target.closest("[data-add]");
    if (add) {
      const item = items.find((i) => i.id === add.dataset.add),
        line = cart.find((x) => x.id === item.id);
      if (line) line.quantity++;
      else cart.push({ ...item, quantity: 1 });
      drawCart(true);
    }
    const qty = e.target.closest("[data-qty]");
    if (qty) {
      const line = cart.find((x) => x.id === qty.dataset.qty);
      line.quantity += Number(qty.dataset.delta);
      if (line.quantity <= 0) cart = cart.filter((x) => x !== line);
      drawCart(false);
    }
  };
  $("#buyer").onchange = async (e) => {
    selectedBuyer = e.target.value;
    $("#saleReview").innerHTML = "";
    if (!selectedBuyer) {
      $("#buyerInfo").innerHTML = "";
      drawCart(false);
      return;
    }
    try {
      const b = await request("/buyers/" + selectedBuyer);
      if (selectedBuyer !== b.id) return;
      $("#buyerInfo").className = `buyer-info ${b.restricted ? "warning" : ""}`;
      $("#buyerInfo").innerHTML =
        `<strong>${esc(b.name)}</strong> · ${esc(b.username)}<br>Total ${pesos(b.balanceMinor)} · Available credit ${pesos(b.availableCreditMinor)}${b.restricted ? " · Debt restricted" : ""}`;
      drawCart(false);
    } catch (error) {
      notice(error.message, true);
    }
  };
  if (selectedBuyer) $("#buyer").dispatchEvent(new Event("change"));
  $("#cashAmount").oninput = drawSplit;
  drawCart(false);
  if (drawer)
    $("#closeDrawer").onclick = () => {
      const amount = prompt("Counted physical cash (₱):");
      if (amount === null) return;
      act(async () => {
        const result = await request("/drawers/close", {
          method: "POST",
          body: JSON.stringify({ countedMinor: minor(amount) }),
        });
        await pos();
        notice(
          `Drawer closed · Expected ${pesos(result.expectedCashMinor)} · Variance ${pesos(result.varianceMinor)}`,
        );
      });
    };
  else
    $("#openDrawer").onsubmit = (e) => {
      e.preventDefault();
      act(async () => {
        await request("/drawers/open", {
          method: "POST",
          body: JSON.stringify({ openingMinor: minor(form(e).opening) }),
        });
        await pos();
      });
    };
  $("#checkout").onsubmit = (e) => {
    e.preventDefault();
    try {
      const total = cart.reduce((n, i) => n + i.price * i.quantity, 0),
        cash = minor($("#cashAmount").value);
      if (!cart.length) throw Error("Add an item first.");
      if (!Number.isSafeInteger(cash) || cash < 0 || cash > total)
        throw Error("Cash must be between zero and the sale total.");
      if (total > cash && !selectedBuyer)
        throw Error("Select a buyer before charging the balance to a tab.");
      const buyerName =
        users.find((u) => u.id === selectedBuyer)?.name || "Walk-in customer";
      $("#saleReview").innerHTML =
        `<div class="confirm-panel"><h3>Review before posting</h3><div class="split"><span>Buyer</span><strong>${esc(buyerName)}</strong></div><div class="split"><span>Sale total</span><strong>${pesos(total)}</strong></div><div class="split"><span>Cash</span><strong>${pesos(cash)}</strong></div><div class="split"><span>Added to tab</span><strong>${pesos(total - cash)}</strong></div><div class="confirm-actions"><button type="button" id="confirmSale">Confirm and post</button><button type="button" class="secondary" id="cancelReview">Edit sale</button></div></div>`;
      $("#cancelReview").onclick = () => ($("#saleReview").innerHTML = "");
      $("#confirmSale").onclick = () =>
        act(async () => {
          const lines = cart.map((i) => ({
              itemId: i.id,
              quantity: i.quantity,
            })),
            tenders = [];
          if (cash) tenders.push({ type: "CASH", amountMinor: cash });
          if (total > cash)
            tenders.push({ type: "DEBT", amountMinor: total - cash });
          $("#confirmSale").disabled = true;
          try {
            const result = await request("/sales", {
              method: "POST",
              body: JSON.stringify({
                buyerId: selectedBuyer || null,
                lines,
                tenders,
              }),
            });
            cart = [];
            $("#cashAmount").value = "0";
            drawCart(false);
            $("#saleReview").innerHTML = "";
            notice(
              `Sale posted · ${pesos(result.totalMinor)} total · ${pesos(result.debtChargeMinor)} added to tab`,
            );
          } catch (error) {
            $("#confirmSale").disabled = false;
            throw error;
          }
        });
    } catch (error) {
      notice(error.message, true);
    }
  };
}
function drawSplit() {
  const total = cart.reduce((n, i) => n + i.price * i.quantity, 0),
    cash = minor($("#cashAmount").value || 0),
    debt = Math.max(0, total - cash);
  $("#split").innerHTML =
    `<div class="split"><span>Cash</span><strong>${pesos(cash)}</strong></div><div class="split"><span>Tab</span><strong>${pesos(debt)}</strong></div>`;
  $("#saleReview").innerHTML = "";
}
function drawCart(setCash) {
  const total = cart.reduce((n, i) => n + i.price * i.quantity, 0);
  $("#cart").innerHTML = cart.length
    ? cart
        .map(
          (i) =>
            `<div class="row"><div><strong>${esc(i.name)}</strong><div class="muted">${pesos(i.price)} each</div></div><div class="quantity"><button type="button" class="secondary" data-qty="${i.id}" data-delta="-1" aria-label="Remove one ${esc(i.name)}">−</button><strong>${i.quantity}</strong><button type="button" class="secondary" data-qty="${i.id}" data-delta="1" aria-label="Add one ${esc(i.name)}">+</button></div></div>`,
        )
        .join("")
    : '<div class="empty">Your sale is empty. Add items from the menu.</div>';
  $("#cart").insertAdjacentHTML(
    "beforeend",
    `<div class="checkout-total"><span>Total</span><strong>${pesos(total)}</strong></div>`,
  );
  if (setCash) $("#cashAmount").value = (total / 100).toFixed(2);
  drawSplit();
}
async function buyers() {
  users = await request("/users");
  const all = users.filter((u) => u.role === "BUYER");
  $("#view").innerHTML =
    `<div class="page-head"><div><div class="eyebrow">ACCOUNTS</div><h1>Buyer accounts</h1><p>Find a buyer to view their balance and statement.</p></div><span class="pill">${all.length} buyers</span></div><div class="card"><label>Search by name or username<input id="buyerSearch" type="search" placeholder="Start typing a name" autocomplete="off"></label><div id="buyerList" class="grid"></div></div>`;
  const draw = () => {
    const term = $("#buyerSearch").value.toLowerCase().trim();
    const matches = all.filter((u) =>
      `${u.name} ${u.username}`.toLowerCase().includes(term),
    );
    $("#buyerList").innerHTML =
      matches
        .map(
          (u) =>
            `<div class="card"><h3>${esc(u.name)}</h3><p>${esc(u.username)}</p><button data-view="${u.id}">Open account</button></div>`,
        )
        .join("") || '<div class="empty">No matching buyers</div>';
  };
  $("#buyerSearch").oninput = draw;
  draw();
  $("#view").onclick = (e) => {
    if (e.target.dataset.view) account(e.target.dataset.view);
  };
}
async function account(id) {
  const b = await request("/buyers/" + id),
    ledger = await request("/buyers/" + id + "/ledger");
  $("#view").innerHTML =
    `<div class="card"><h1>${esc(b.name)}</h1><p>Outstanding debt</p><div class="metric">${pesos(b.balanceMinor)}</div>${me.role !== "BUYER" ? `<p>Available credit: ${pesos(b.availableCreditMinor)}</p><form id="payment" class="inline"><label>Cash payment (₱)<input name="amount" type="number" min=".01" step=".01" required></label><button>Record payment</button></form>${me.role === "ADMIN" ? `<form id="paper" class="inline"><label>Paper debt amount (₱)<input name="amount" type="number" min=".01" step=".01" required></label><label>Paper reference<input name="reference" required></label><button>Import paper debt</button></form>` : ""}` : ""}</div><div class="card"><h2>Statement</h2>${ledger.map((l) => `<div class="row"><span>${esc(l.type)} <span class="muted">${esc(l.reference || "")} · ${new Date(l.created_at).toLocaleString()}</span></span><strong>${pesos(l.amount)}</strong></div>`).join("") || "<p>No entries yet.</p>"}</div>`;
  if ($("#payment"))
    $("#payment").onsubmit = (e) => {
      e.preventDefault();
      act(async () => {
        await request(`/buyers/${id}/payments`, {
          method: "POST",
          body: JSON.stringify({ amountMinor: minor(form(e).amount) }),
        });
        await account(id);
      });
    };
  if ($("#paper"))
    $("#paper").onsubmit = (e) => {
      e.preventDefault();
      act(async () => {
        const f = form(e);
        await request(`/buyers/${id}/paper-debt`, {
          method: "POST",
          body: JSON.stringify({
            amountMinor: minor(f.amount),
            reference: f.reference,
          }),
        });
        await account(id);
      });
    };
}
async function menu() {
  items = await request("/items");
  $("#view").innerHTML =
    `<h1>Menu management</h1><div class="card"><form id="newItem" class="inline"><label>Name<input name="name" required></label><label>Price (₱)<input name="price" type="number" min="0" step=".01" required></label><button>Add item</button></form></div><div class="card">${items.map((i) => `<div class="row"><span>${esc(i.name)} · ${pesos(i.price)}</span><span class="pill ${i.available ? "" : "warning"}">${i.available ? "Available" : "Unavailable"}</span></div>`).join("")}</div>`;
  $("#newItem").onsubmit = (e) => {
    e.preventDefault();
    act(async () => {
      const f = form(e);
      await request("/items", {
        method: "POST",
        body: JSON.stringify({ name: f.name, priceMinor: minor(f.price) }),
      });
      await menu();
    });
  };
}
async function team() {
  // Only admins see this screen; accounts are never created from the login page.
  const [sections, people] = await Promise.all([
    request("/sections"),
    request("/users"),
  ]);
  $("#view").innerHTML =
    `<h1>Team and sections</h1><div class="two"><div class="card"><h2>Add section</h2><form id="newSection"><label>Name<input name="name" required></label><button>Add section</button></form>${sections.map((s) => `<div class="row">${esc(s.name)}</div>`).join("")}</div><div class="card"><h2>Add team member</h2><form id="newUser"><label>Full name<input name="name" required></label><label>Account email<input name="username" inputmode="email" required></label><label>Temporary password (12+ characters)<input name="password" type="password" minlength="12" autocomplete="new-password" required></label><p class="muted">The account holder must replace this password after their first login.</p><label>Role<select name="role"><option>BUYER</option><option>CASHIER</option><option>GUARD</option><option>ADMIN</option></select></label><label>Section<select name="section"><option value="">None</option>${sections.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join("")}</select></label><label>Credit limit (₱)<input name="limit" type="number" min="0" step=".01" value="0"></label><label><input name="credit" type="checkbox" style="display:inline;width:auto"> Allow credit</label><button>Create user</button></form></div></div><div class="card"><h2>Users</h2>${people.map((u) => `<div class="row"><span>${esc(u.name)} <small class="muted">${esc(u.username)}</small></span><span class="pill">${u.must_change_password ? "Password change required" : esc(u.role)}</span></div>`).join("")}</div>`;
  $("#view h1").textContent = "Accounts and sections";
  $("#newUser").previousElementSibling.textContent = "Create account";
  $("#newUser button").textContent = "Create account";
  $("#view").insertAdjacentHTML(
    "afterbegin",
    "<p>Administrators create login accounts here. Select an existing account below to edit it.</p>",
  );
  const rows = $("#view .card:last-child").querySelectorAll(".row");
  rows.forEach((row, index) => {
    const button = document.createElement("button");
    button.className = "secondary";
    button.textContent = "Edit";
    button.onclick = () => editAccount(people[index], sections);
    row.append(button);
  });
  $("#newSection").onsubmit = (e) => {
    e.preventDefault();
    act(async () => {
      await request("/sections", {
        method: "POST",
        body: JSON.stringify(form(e)),
      });
      await team();
    });
  };
  $("#newUser").onsubmit = (e) => {
    e.preventDefault();
    act(async () => {
      const f = form(e);
      await request("/users", {
        method: "POST",
        body: JSON.stringify({
          name: f.name,
          username: f.username,
          password: f.password,
          role: f.role,
          sectionId: f.section || null,
          creditLimitMinor: minor(f.limit),
          creditAllowed: !!f.credit,
        }),
      });
      await team();
    });
  };
}
function editAccount(person, sections) {
  $("#accountEditor")?.remove();
  $("#view").insertAdjacentHTML(
    "beforeend",
    `<div class="card" id="accountEditor"><h2>Edit ${esc(person.name)}</h2><form id="editAccount"><label>Full name<input name="name" value="${esc(person.name)}" required></label><label>Account email<input name="username" inputmode="email" value="${esc(person.username)}" required></label><label>Role<select name="role">${["BUYER", "CASHIER", "GUARD", "ADMIN"].map((role) => `<option ${person.role === role ? "selected" : ""}>${role}</option>`).join("")}</select></label><label>Section<select name="section"><option value="">None</option>${sections.map((s) => `<option value="${s.id}" ${person.section_id === s.id ? "selected" : ""}>${esc(s.name)}</option>`).join("")}</select></label><label>Credit limit (₱)<input name="limit" type="number" min="0" step=".01" value="${(person.credit_limit / 100).toFixed(2)}" required></label><label><input name="credit" type="checkbox" ${person.credit_allowed ? "checked" : ""}> Allow credit</label><label><input name="restricted" type="checkbox" ${person.restricted ? "checked" : ""}> Restrict debt purchases</label><label><input name="active" type="checkbox" ${person.active ? "checked" : ""}> Active account</label><label>New temporary password (optional, 12+ characters)<input name="password" type="password" minlength="12" autocomplete="new-password"></label><p class="muted">After a reset, the account holder must choose a new password at login.</p><button>Save account</button></form></div>`,
  );
  $("#accountEditor").scrollIntoView({ behavior: "smooth", block: "start" });
  $("#editAccount").onsubmit = (event) => {
    event.preventDefault();
    act(async () => {
      const fields = form(event);
      await request(`/users/${person.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: fields.name,
          username: fields.username,
          role: fields.role,
          sectionId: fields.section || null,
          creditLimitMinor: minor(fields.limit),
          creditAllowed: !!fields.credit,
          restricted: !!fields.restricted,
          active: !!fields.active,
          password: fields.password || undefined,
        }),
      });
      await team();
    });
  };
}
async function verify() {
  $("#view").innerHTML =
    `<div class="card"><h1>Buyer verification</h1><p>Enter the buyer's username.</p><form id="lookup" class="inline"><label>Username<input name="username" required></label><button>Check status</button></form><div id="result"></div></div>`;
  $("#lookup").onsubmit = (e) => {
    e.preventDefault();
    act(async () => {
      const b = await request(
        "/verify?username=" + encodeURIComponent(form(e).username),
      );
      $("#result").innerHTML =
        `<h2>${esc(b.name)}</h2><span class="pill ${b.status === "CLEAR" ? "" : "warning"}">${esc(b.status.replace("_", " "))}</span>`;
    });
  };
}
async function sales() {
  const rows = await request("/sales");
  $("#view").innerHTML =
    `<h1>Sales</h1><div class="card"><table><tr><th>When</th><th>Buyer</th><th>Total</th><th>Cash</th><th>Debt</th><th>Status</th><th></th></tr>${rows.map((r) => `<tr><td>${new Date(r.created_at).toLocaleString()}</td><td>${esc(r.buyer_name || "Walk-in")}</td><td>${pesos(r.total)}</td><td>${pesos(r.cash)}</td><td>${pesos(r.debt)}</td><td>${esc(r.status)}</td><td>${me.role === "ADMIN" && r.status === "POSTED" ? `<button class="secondary" data-void="${r.id}">Void</button>` : ""}</td></tr>`).join("")}</table></div>`;
  $("#view").onclick = (e) => {
    if (e.target.dataset.void)
      act(async () => {
        const reason = prompt("Reason for void (at least 5 characters):");
        if (reason === null) return;
        await request(`/sales/${e.target.dataset.void}/void`, {
          method: "POST",
          body: JSON.stringify({ reason }),
        });
        await sales();
      });
  };
}
async function reports() {
  const today = new Date().toLocaleDateString("en-CA", {
    timeZone: "Asia/Manila",
  });
  $("#view").innerHTML =
    `<h1>Period report</h1><div class="card"><form id="period" class="inline"><label>From<input name="from" type="date" value="${today}" required></label><label>To<input name="to" type="date" value="${today}" required></label><button>Run report</button></form></div><div id="periodResult"></div>`;
  $("#period").onsubmit = (e) => {
    e.preventDefault();
    act(async () => {
      const f = form(e),
        r = await request(
          `/reports/period?from=${encodeURIComponent(f.from)}&to=${encodeURIComponent(f.to)}`,
        );
      $("#periodResult").innerHTML = `<div class="grid">${[
        ["Gross sales", r.gross],
        ["Cash sales", r.cash],
        ["New debt", r.debt],
        ["Debt settled", r.settled],
        ["Paper debt imported", r.paperImported],
      ]
        .map(
          ([name, value]) =>
            `<div class="card"><div class="muted">${name}</div><div class="metric">${pesos(value)}</div></div>`,
        )
        .join(
          "",
        )}</div><div class="card"><h2>Sections</h2><table><tr><th>Section</th><th>Revenue</th><th>New debt</th></tr>${r.sections.map((s) => `<tr><td>${esc(s.name || "Walk-in")}</td><td>${pesos(s.revenue)}</td><td>${pesos(s.newDebt)}</td></tr>`).join("")}</table></div>`;
    });
  };
  $("#period").requestSubmit();
}
async function audit() {
  const rows = await request("/reports/audit");
  $("#view").innerHTML =
    `<h1>Audit log</h1><div class="card">${rows.map((r) => `<div class="row"><span>${esc(r.action)} <span class="muted">${esc(r.subject_id || "")}</span></span><time>${new Date(r.created_at).toLocaleString()}</time></div>`).join("")}</div>`;
}
$("#loginForm").onsubmit = async (e) => {
  e.preventDefault();
  const button = $("#loginForm button"),
    error = $("#loginError");
  button.disabled = true;
  error.hidden = true;
  try {
    me = await request("/login", {
      method: "POST",
      body: JSON.stringify(form(e)),
    });
    showApp();
  } catch (cause) {
    error.textContent = cause.message;
    error.hidden = false;
  } finally {
    button.disabled = false;
  }
};
boot();
