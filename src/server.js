import http from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  randomUUID,
} from "node:crypto";
import { join, extname } from "node:path";
import {
  planSale,
  planDebtPayment,
  quoteSale,
  reconcileDrawer,
} from "./finance.js";
import { createPaperService } from "./paper.js";

// Local deployment: SQLite keeps cash, debt, and audit records in one database.
// Amounts are integer centavos throughout the application.
const dataDir = process.env.CANTEEN_DATA_DIR || join(process.cwd(), "data");
const secureCookie = process.env.COOKIE_SECURE === "1";
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(join(dataDir, "canteen.sqlite"));
db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
db.exec(`
CREATE TABLE IF NOT EXISTS sections(id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, name TEXT NOT NULL, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('ADMIN','CASHIER','GUARD','BUYER')), section_id TEXT REFERENCES sections(id), credit_limit INTEGER NOT NULL DEFAULT 0, credit_allowed INTEGER NOT NULL DEFAULT 0, restricted INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY, name TEXT NOT NULL, price INTEGER NOT NULL CHECK(price >= 0), available INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS drawers(id TEXT PRIMARY KEY, cashier_id TEXT NOT NULL REFERENCES users(id), opening INTEGER NOT NULL, opened_at TEXT NOT NULL, closed_at TEXT, counted INTEGER, expected INTEGER, variance INTEGER);
CREATE UNIQUE INDEX IF NOT EXISTS open_drawer ON drawers(cashier_id) WHERE closed_at IS NULL;
CREATE TABLE IF NOT EXISTS sales(id TEXT PRIMARY KEY, buyer_id TEXT REFERENCES users(id), cashier_id TEXT NOT NULL REFERENCES users(id), drawer_id TEXT NOT NULL REFERENCES drawers(id), section_id TEXT REFERENCES sections(id), total INTEGER NOT NULL, cash INTEGER NOT NULL, debt INTEGER NOT NULL, prepaid INTEGER NOT NULL, created_at TEXT NOT NULL, request_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'POSTED');
CREATE TABLE IF NOT EXISTS sale_lines(id TEXT PRIMARY KEY, sale_id TEXT NOT NULL REFERENCES sales(id), item_id TEXT NOT NULL REFERENCES items(id), name TEXT NOT NULL, quantity INTEGER NOT NULL, unit_price INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY, buyer_id TEXT NOT NULL REFERENCES users(id), amount INTEGER NOT NULL, type TEXT NOT NULL, sale_id TEXT REFERENCES sales(id), reference TEXT, created_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, request_key TEXT UNIQUE);
CREATE TABLE IF NOT EXISTS movements(id TEXT PRIMARY KEY, drawer_id TEXT NOT NULL REFERENCES drawers(id), amount INTEGER NOT NULL, type TEXT NOT NULL, sale_id TEXT REFERENCES sales(id), ledger_id TEXT REFERENCES ledger(id), created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY, actor_id TEXT REFERENCES users(id), action TEXT NOT NULL, subject_id TEXT, details TEXT, created_at TEXT NOT NULL);
`);
// Existing installations predate first-login password changes, so migrate them
// in place without forcing established accounts through the new flow.
if (!db.prepare("PRAGMA table_info(users)").all().some((column) => column.name === "must_change_password"))
  db.exec("ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0");
if (!db.prepare("PRAGMA table_info(users)").all().some((column) => column.name === "profile_details"))
  db.exec("ALTER TABLE users ADD COLUMN profile_details TEXT NOT NULL DEFAULT ''");
if (!db.prepare("PRAGMA table_info(users)").all().some((column) => column.name === "profile_picture"))
  db.exec("ALTER TABLE users ADD COLUMN profile_picture TEXT NOT NULL DEFAULT ''");
const now = () => new Date().toISOString();
const id = () => randomUUID();
const hashPassword = (password) => {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
};
const verifyPassword = (password, stored) => {
  const [salt, hash] = stored.split(":");
  return timingSafeEqual(
    scryptSync(password, salt, 64),
    Buffer.from(hash, "hex"),
  );
};
const audit = (actor, action, subject, details = {}) =>
  db
    .prepare("INSERT INTO audit VALUES(?,?,?,?,?,?)")
    .run(id(), actor, action, subject, JSON.stringify(details), now());
const balance = (buyerId) =>
  db
    .prepare(
      "SELECT COALESCE(SUM(amount),0) AS amount FROM ledger WHERE buyer_id=?",
    )
    .get(buyerId).amount;
const findUser = (userId) =>
  db
    .prepare(
      "SELECT id,name,username,role,section_id,credit_limit,credit_allowed,restricted,active,must_change_password,profile_details,profile_picture FROM users WHERE id=?",
    )
    .get(userId);
const appError = (message, code = 400) =>
  Object.assign(new Error(message), { code });
const roles = (user, ...allowed) => {
  if (!allowed.includes(user.role)) throw appError("Forbidden", 403);
};
const activeDrawer = (userId) =>
  db
    .prepare("SELECT * FROM drawers WHERE cashier_id=? AND closed_at IS NULL")
    .get(userId);
const transactional = (fn) => {
  // Serialize financial writes so credit checks and ledger inserts see one state.
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
};
function bootstrap() {
  if (db.prepare("SELECT COUNT(*) AS n FROM users").get().n) return;
  const password = process.env.CANTEEN_ADMIN_PASSWORD;
  if (!password || password.length < 12)
    throw new Error(
      "Set CANTEEN_ADMIN_PASSWORD to at least 12 characters for first run",
    );
  const admin = id();
  db.prepare(
    "INSERT INTO users(id,name,username,password_hash,role) VALUES(?,?,?,?,?)",
  ).run(admin, "Administrator", "admin", hashPassword(password), "ADMIN");
  audit(admin, "BOOTSTRAP", admin);
}
bootstrap();
// New paper-slip tables are additive; existing POS and user records remain intact.
const paper = createPaperService(db, { audit, transactional, appError });

function authentication(req) {
  const cookie = req.headers.cookie
    ?.split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith("canteen_session="))
    ?.split("=")[1];
  if (!cookie) throw appError("Log in required", 401);
  const tokenHash = scryptSync(cookie, "canteen-session", 32).toString("hex");
  const session = db
    .prepare("SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?")
    .get(tokenHash, Date.now());
  const user = session && findUser(session.user_id);
  if (!user?.active) throw appError("Log in required", 401);
  return user;
}
function json(res, status, value, headers = {}) {
  // API callers always receive a nonempty JSON body, including errors.
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(value));
}
function body(req) {
  // Reject malformed JSON at the boundary before any database change.
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 100000) reject(appError("Request too large", 413));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(appError("Invalid JSON"));
      }
    });
  });
}
const buyerSummary = (buyerId) => {
  const buyer = findUser(buyerId);
  if (!buyer) throw appError("Buyer not found", 404);
  return {
    ...buyer,
    balanceMinor: balance(buyerId),
    availableCreditMinor: Math.max(
      0,
      buyer.credit_limit - Math.max(0, balance(buyerId)),
    ),
  };
};
async function api(req, res, path) {
  const method = req.method;
  if (method === "GET" && path === "/api/health") {
    return json(res, 200, { status: "ok" });
  }
  if (method === "POST" && path === "/api/login") {
    const input = await body(req);
    const row = db
      .prepare("SELECT * FROM users WHERE username=? AND active=1")
      .get(input.username);
    if (
      !row ||
      typeof input.password !== "string" ||
      !verifyPassword(input.password, row.password_hash)
    )
      throw appError("Invalid credentials", 401);
    const token = randomBytes(32).toString("hex");
    db.prepare("INSERT INTO sessions VALUES(?,?,?)").run(
      scryptSync(token, "canteen-session", 32).toString("hex"),
      row.id,
      Date.now() + 8 * 60 * 60 * 1000,
    );
    audit(row.id, "LOGIN", row.id);
    return json(res, 200, findUser(row.id), {
      "set-cookie": `canteen_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${secureCookie ? "; Secure" : ""}`,
    });
  }
  const user = authentication(req);
  if (method === "PATCH" && path === "/api/profile") {
    const input = await body(req);
    const name = input.name?.trim();
    const username = input.username?.trim();
    const details = input.profileDetails?.trim() || "";
    const picture = input.profilePicture || "";
    if (!name || !username || details.length > 500)
      throw appError("Name and username are required; profile details are limited to 500 characters");
    if (
      picture &&
      (!/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(picture) ||
        picture.length > 350000)
    )
      throw appError("Profile picture must be a PNG, JPEG, or WebP image under 250 KB");
    const duplicate = db
      .prepare("SELECT id FROM users WHERE username=? COLLATE NOCASE AND id<>?")
      .get(username, user.id);
    if (duplicate) throw appError("Username is already in use", 409);
    db.prepare(
      "UPDATE users SET name=?,username=?,profile_details=?,profile_picture=? WHERE id=?",
    ).run(name, username, details, picture, user.id);
    audit(user.id, "UPDATE_PROFILE", user.id, { name, username });
    return json(res, 200, findUser(user.id));
  }
  if (method === "POST" && path === "/api/change-password") {
    const input = await body(req);
    const credentials = db
      .prepare("SELECT password_hash FROM users WHERE id=?")
      .get(user.id);
    if (
      typeof input.currentPassword !== "string" ||
      !verifyPassword(input.currentPassword, credentials.password_hash)
    )
      throw appError("Current password is incorrect", 401);
    if (typeof input.newPassword !== "string" || input.newPassword.length < 12)
      throw appError("New password must be at least 12 characters");
    if (input.newPassword !== input.confirmPassword)
      throw appError("New passwords do not match");
    if (input.newPassword === input.currentPassword)
      throw appError("Choose a password different from the temporary password");
    db.prepare(
      "UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?",
    ).run(hashPassword(input.newPassword), user.id);
    audit(user.id, "CHANGE_PASSWORD", user.id, { firstLogin: !!user.must_change_password });
    return json(res, 200, findUser(user.id));
  }
  // A temporary-password session may only identify itself, change its password,
  // or log out. This is enforced by the API rather than only by the browser.
  if (
    user.must_change_password &&
    !(method === "GET" && path === "/api/me") &&
    !(method === "POST" && path === "/api/logout")
  )
    throw appError("Change your temporary password before continuing", 403);
  // The paper workflow is intentionally separate from the older menu POS routes.
  if (path.startsWith("/api/paper/")) {
    if (method === "GET" && path === "/api/paper/fields") {
      roles(user, "ADMIN", "CASHIER", "GUARD");
      return json(res, 200, paper.listFields());
    }
    if (method === "POST" && path === "/api/paper/fields") {
      roles(user, "ADMIN");
      return json(res, 201, paper.addField(await body(req), user.id));
    }
    if (method === "PATCH" && /^\/api\/paper\/fields\/[^/]+$/.test(path)) {
      roles(user, "ADMIN");
      return json(res, 200, paper.updateField(path.split("/")[4], await body(req), user.id));
    }
    if (method === "DELETE" && /^\/api\/paper\/fields\/[^/]+$/.test(path)) {
      roles(user, "ADMIN");
      return json(res, 200, paper.deleteField(path.split("/")[4], user.id));
    }
    if (method === "GET" && path === "/api/paper/people") {
      roles(user, "ADMIN", "CASHIER", "GUARD");
      return json(res, 200, paper.listPeople(user.id));
    }
    if (method === "POST" && path === "/api/paper/people") {
      roles(user, "ADMIN", "CASHIER");
      return json(res, 201, paper.addPerson(await body(req), user.id));
    }
    if (method === "PATCH" && /^\/api\/paper\/people\/[^/]+$/.test(path)) {
      roles(user, "ADMIN", "CASHIER");
      return json(res, 200, paper.updatePerson(path.split("/")[4], await body(req), user.id));
    }
    if (method === "DELETE" && /^\/api\/paper\/people\/[^/]+$/.test(path)) {
      roles(user, "ADMIN", "CASHIER");
      return json(res, 200, paper.deletePerson(path.split("/")[4], user.id));
    }
    if (method === "GET" && path === "/api/paper/slips") {
      roles(user, "ADMIN", "CASHIER");
      return json(res, 200, paper.listSlips(user.id));
    }
    if (method === "POST" && path === "/api/paper/slips") {
      roles(user, "ADMIN", "CASHIER");
      return json(
        res,
        201,
        paper.addSlip(await body(req), user.id, req.headers["idempotency-key"]),
      );
    }
    if (method === "POST" && path === "/api/paper/slips/batch") {
      roles(user, "ADMIN", "CASHIER");
      const input = await body(req);
      return json(
        res,
        201,
        paper.addSlips(input.slips, user.id, req.headers["idempotency-key"]),
      );
    }
    if (method === "POST" && path === "/api/paper/collections") {
      roles(user, "ADMIN", "CASHIER");
      return json(
        res,
        201,
        paper.addCollection(
          await body(req),
          user.id,
          req.headers["idempotency-key"],
        ),
      );
    }
    if (method === "GET" && path === "/api/paper/report") {
      roles(user, "ADMIN", "CASHIER");
      const query = new URL(req.url, "http://localhost").searchParams;
      return json(res, 200, paper.report(query.get("from"), query.get("to"), user.id));
    }
    throw appError("Paper route not found", 404);
  }
  if (method === "POST" && path === "/api/logout") {
    const token = req.headers.cookie?.match(/canteen_session=([^;]+)/)?.[1];
    if (token)
      db.prepare("DELETE FROM sessions WHERE token_hash=?").run(
        scryptSync(token, "canteen-session", 32).toString("hex"),
      );
    return json(
      res,
      200,
      { ok: true },
      {
        "set-cookie":
          `canteen_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie ? "; Secure" : ""}`,
      },
    );
  }
  if (method === "GET" && path === "/api/me") return json(res, 200, user);
  if (method === "GET" && path === "/api/sections")
    return json(
      res,
      200,
      db.prepare("SELECT * FROM sections ORDER BY name").all(),
    );
  if (method === "POST" && path === "/api/sections") {
    roles(user, "ADMIN");
    const input = await body(req);
    if (!input.name?.trim()) throw appError("Name required");
    const sectionId = id();
    db.prepare("INSERT INTO sections VALUES(?,?)").run(
      sectionId,
      input.name.trim(),
    );
    audit(user.id, "CREATE_SECTION", sectionId);
    return json(res, 201, { id: sectionId });
  }
  if (method === "GET" && path === "/api/items")
    return json(
      res,
      200,
      db.prepare("SELECT * FROM items ORDER BY name").all(),
    );
  if (method === "POST" && path === "/api/items") {
    roles(user, "ADMIN");
    const input = await body(req);
    if (
      !input.name?.trim() ||
      !Number.isSafeInteger(input.priceMinor) ||
      input.priceMinor < 0
    )
      throw appError("Valid name and price required");
    const itemId = id();
    db.prepare("INSERT INTO items VALUES(?,?,?,1)").run(
      itemId,
      input.name.trim(),
      input.priceMinor,
    );
    audit(user.id, "CREATE_ITEM", itemId);
    return json(res, 201, { id: itemId });
  }
  if (method === "PATCH" && path.startsWith("/api/items/")) {
    roles(user, "ADMIN");
    const itemId = path.split("/")[3],
      input = await body(req);
    if (
      !Number.isSafeInteger(input.priceMinor) ||
      input.priceMinor < 0 ||
      !input.name?.trim()
    )
      throw appError("Valid name and price required");
    const result = db
      .prepare("UPDATE items SET name=?,price=?,available=? WHERE id=?")
      .run(
        input.name.trim(),
        input.priceMinor,
        input.available ? 1 : 0,
        itemId,
      );
    if (!result.changes) throw appError("Item not found", 404);
    audit(user.id, "UPDATE_ITEM", itemId);
    return json(res, 200, { ok: true });
  }
  if (method === "GET" && path === "/api/users") {
    roles(user, "ADMIN", "CASHIER");
    return json(
      res,
      200,
      db
        .prepare(
          "SELECT id,name,username,role,section_id,credit_limit,credit_allowed,restricted,active,must_change_password FROM users ORDER BY name",
        )
        .all(),
    );
  }
  if (method === "GET" && path === "/api/verify") {
    roles(user, "GUARD", "ADMIN");
    const query = new URL(req.url, "http://localhost").searchParams
      .get("username")
      ?.trim();
    if (!query) throw appError("Username required");
    const buyer = db
      .prepare(
        "SELECT id,name,section_id,restricted FROM users WHERE username=? AND role='BUYER' AND active=1",
      )
      .get(query);
    if (!buyer) throw appError("Buyer not found", 404);
    const amount = balance(buyer.id);
    return json(res, 200, {
      name: buyer.name,
      sectionId: buyer.section_id,
      status: buyer.restricted
        ? "RESTRICTED"
        : amount > 0
          ? "PENDING_DEBT"
          : "CLEAR",
    });
  }
  if (method === "POST" && path === "/api/users") {
    roles(user, "ADMIN");
    const input = await body(req);
    if (
      !input.name?.trim() ||
      !input.username?.trim() ||
      typeof input.password !== "string" ||
      input.password.length < 12 ||
      !["ADMIN", "CASHIER", "GUARD", "BUYER"].includes(input.role) ||
      !Number.isSafeInteger(input.creditLimitMinor ?? 0) ||
      (input.creditLimitMinor ?? 0) < 0
    )
      throw appError("Invalid user details; password needs 12 characters");
    if (
      db
        .prepare("SELECT id FROM users WHERE username=?")
        .get(input.username.trim())
    )
      throw appError("Username is already in use", 409);
    const userId = id();
    db.prepare(
      "INSERT INTO users(id,name,username,password_hash,role,section_id,credit_limit,credit_allowed,must_change_password) VALUES(?,?,?,?,?,?,?,?,1)",
    ).run(
      userId,
      input.name.trim(),
      input.username.trim(),
      hashPassword(input.password),
      input.role,
      input.sectionId || null,
      input.creditLimitMinor ?? 0,
      input.creditAllowed ? 1 : 0,
    );
    audit(user.id, "CREATE_USER", userId);
    return json(res, 201, { id: userId });
  }
  if (method === "PATCH" && /^\/api\/users\/[^/]+$/.test(path)) {
    roles(user, "ADMIN");
    const targetId = path.split("/")[3];
    const input = await body(req);
    const current = findUser(targetId);
    if (!current) throw appError("Account not found", 404);
    if (
      !input.name?.trim() ||
      !input.username?.trim() ||
      !["ADMIN", "CASHIER", "GUARD", "BUYER"].includes(input.role) ||
      !Number.isSafeInteger(input.creditLimitMinor) ||
      input.creditLimitMinor < 0 ||
      (input.password && input.password.length < 12)
    )
      throw appError(
        "Invalid account details; new passwords need 12 characters",
      );
    if (targetId === user.id && (input.role !== "ADMIN" || !input.active))
      throw appError("You cannot remove your own administrator access");
    const duplicate = db
      .prepare("SELECT id FROM users WHERE username=? AND id<>?")
      .get(input.username.trim(), targetId);
    if (duplicate) throw appError("Username is already in use", 409);
    const updated = transactional(() => {
      db.prepare(
        "UPDATE users SET name=?,username=?,role=?,section_id=?,credit_limit=?,credit_allowed=?,restricted=?,active=? WHERE id=?",
      ).run(
        input.name.trim(),
        input.username.trim(),
        input.role,
        input.sectionId || null,
        input.creditLimitMinor,
        input.creditAllowed ? 1 : 0,
        input.restricted ? 1 : 0,
        input.active ? 1 : 0,
        targetId,
      );
      // A password reset revokes existing sessions so old credentials stop working.
      if (input.password) {
        db.prepare("UPDATE users SET password_hash=?,must_change_password=1 WHERE id=?").run(
          hashPassword(input.password),
          targetId,
        );
        db.prepare("DELETE FROM sessions WHERE user_id=?").run(targetId);
      }
      const result = findUser(targetId);
      audit(user.id, "UPDATE_USER", targetId, {
        before: current,
        after: result,
        passwordReset: !!input.password,
      });
      return result;
    });
    return json(res, 200, updated);
  }
  if (
    method === "GET" &&
    path.startsWith("/api/buyers/") &&
    path.endsWith("/ledger")
  ) {
    const buyerId = path.split("/")[3];
    if (user.role !== "ADMIN" && user.role !== "CASHIER" && user.id !== buyerId)
      throw appError("Forbidden", 403);
    return json(
      res,
      200,
      db
        .prepare(
          "SELECT id,amount,type,sale_id,reference,created_at FROM ledger WHERE buyer_id=? ORDER BY created_at DESC",
        )
        .all(buyerId),
    );
  }
  if (method === "GET" && path.startsWith("/api/buyers/")) {
    const buyerId = path.split("/")[3];
    if (user.role === "BUYER" && user.id !== buyerId)
      throw appError("Forbidden", 403);
    const summary = buyerSummary(buyerId);
    if (user.role === "GUARD")
      return json(res, 200, {
        id: summary.id,
        name: summary.name,
        sectionId: summary.section_id,
        status: summary.restricted
          ? "RESTRICTED"
          : summary.balanceMinor > 0
            ? "PENDING_DEBT"
            : "CLEAR",
      });
    return json(res, 200, summary);
  }
  if (method === "POST" && path === "/api/drawers/open") {
    roles(user, "CASHIER", "ADMIN");
    const input = await body(req);
    if (!Number.isSafeInteger(input.openingMinor) || input.openingMinor < 0)
      throw appError("Invalid opening float");
    if (activeDrawer(user.id)) throw appError("Drawer already open");
    const drawerId = id();
    db.prepare(
      "INSERT INTO drawers(id,cashier_id,opening,opened_at) VALUES(?,?,?,?)",
    ).run(drawerId, user.id, input.openingMinor, now());
    audit(user.id, "OPEN_DRAWER", drawerId);
    return json(res, 201, { id: drawerId });
  }
  if (method === "GET" && path === "/api/drawers/current") {
    roles(user, "CASHIER", "ADMIN");
    return json(res, 200, activeDrawer(user.id) || null);
  }
  if (method === "POST" && path === "/api/drawers/close") {
    roles(user, "CASHIER", "ADMIN");
    const input = await body(req);
    return transactional(() => {
      const drawer = activeDrawer(user.id);
      if (!drawer) throw appError("No open drawer");
      const movements = db
        .prepare("SELECT amount FROM movements WHERE drawer_id=?")
        .all(drawer.id)
        .map((r) => ({ amountMinor: r.amount }));
      const result = reconcileDrawer({
        openingFloatMinor: drawer.opening,
        movements,
        countedCashMinor: input.countedMinor,
      });
      db.prepare(
        "UPDATE drawers SET closed_at=?,counted=?,expected=?,variance=? WHERE id=?",
      ).run(
        now(),
        result.countedCashMinor,
        result.expectedCashMinor,
        result.varianceMinor,
        drawer.id,
      );
      audit(user.id, "CLOSE_DRAWER", drawer.id, result);
      return json(res, 200, result);
    });
  }
  if (method === "GET" && path === "/api/sales") {
    roles(user, "ADMIN", "CASHIER");
    return json(
      res,
      200,
      db
        .prepare(
          "SELECT sales.id,sales.created_at,sales.total,sales.cash,sales.debt,sales.status,users.name buyer_name FROM sales LEFT JOIN users ON users.id=sales.buyer_id ORDER BY sales.created_at DESC LIMIT 100",
        )
        .all(),
    );
  }
  if (method === "POST" && /^\/api\/sales\/[^/]+\/void$/.test(path)) {
    roles(user, "ADMIN");
    const saleId = path.split("/")[3],
      input = await body(req);
    if (typeof input.reason !== "string" || input.reason.trim().length < 5)
      throw appError("A reason of at least 5 characters is required");
    return transactional(() => {
      const sale = db.prepare("SELECT * FROM sales WHERE id=?").get(saleId);
      if (!sale) throw appError("Sale not found", 404);
      if (sale.status !== "POSTED") throw appError("Sale already voided");
      if (sale.prepaid) throw appError("Prepaid sale voids are not supported");
      if (
        sale.debt &&
        db
          .prepare(
            "SELECT id FROM ledger WHERE buyer_id=? AND type='PAYMENT' AND created_at>=? LIMIT 1",
          )
          .get(sale.buyer_id, sale.created_at)
      )
        throw appError(
          "Buyer has a later payment; review allocations before voiding this sale",
        );
      if (sale.debt && balance(sale.buyer_id) < sale.debt)
        throw appError(
          "Buyer has settled some debt; reverse the payment first",
        );
      const drawer = activeDrawer(user.id);
      if (sale.cash && !drawer)
        throw appError("Open an admin drawer to record the cash refund");
      if (sale.debt) {
        const entryId = id();
        db.prepare("INSERT INTO ledger VALUES(?,?,?,?,?,?,?,?,?)").run(
          entryId,
          sale.buyer_id,
          -sale.debt,
          "SALE_VOID",
          sale.id,
          input.reason.trim(),
          user.id,
          now(),
          `void:${sale.id}`,
        );
      }
      if (sale.cash)
        db.prepare("INSERT INTO movements VALUES(?,?,?,?,?,?,?)").run(
          id(),
          drawer.id,
          -sale.cash,
          "SALE_REFUND_CASH_OUT",
          sale.id,
          null,
          now(),
        );
      db.prepare("UPDATE sales SET status='VOIDED' WHERE id=?").run(sale.id);
      audit(user.id, "VOID_SALE", sale.id, {
        reason: input.reason.trim(),
        cashRefundMinor: sale.cash,
        debtReversalMinor: sale.debt,
      });
      return json(res, 200, {
        id: sale.id,
        status: "VOIDED",
        cashRefundMinor: sale.cash,
        debtReversalMinor: sale.debt,
      });
    });
  }
  if (method === "POST" && path === "/api/sales") {
    roles(user, "CASHIER", "ADMIN");
    const input = await body(req);
    const key = req.headers["idempotency-key"];
    if (typeof key !== "string" || key.length < 8 || key.length > 200)
      throw appError("Idempotency-Key header required");
    return transactional(() => {
      const existing = db
        .prepare("SELECT id FROM sales WHERE request_key=?")
        .get(key);
      if (existing) return json(res, 200, existing);
      const drawer = activeDrawer(user.id);
      const lines = input.lines?.map((line) => {
        const item = db
          .prepare("SELECT * FROM items WHERE id=? AND available=1")
          .get(line.itemId);
        if (!item) throw appError("Item unavailable");
        return { item, quantity: line.quantity, unitPriceMinor: item.price };
      });
      const quote = quoteSale(lines);
      const buyer = input.buyerId ? findUser(input.buyerId) : null;
      const plan = planSale({
        totalMinor: quote.totalMinor,
        tenders: input.tenders,
        drawerOpen: Boolean(drawer),
        buyer: buyer && {
          status: buyer.active ? "ACTIVE" : "SUSPENDED",
          creditAllowed: !!buyer.credit_allowed,
          debtRestricted: !!buyer.restricted,
          creditLimitMinor: buyer.credit_limit,
          outstandingMinor: balance(buyer.id),
          prepaidBalanceMinor: 0,
        },
      });
      const saleId = id();
      db.prepare("INSERT INTO sales VALUES(?,?,?,?,?,?,?,?,?,?,?,?)").run(
        saleId,
        buyer?.id || null,
        user.id,
        drawer.id,
        buyer?.section_id || null,
        quote.totalMinor,
        plan.cashMovementMinor,
        plan.debtChargeMinor,
        plan.prepaidDebitMinor,
        now(),
        key,
        "POSTED",
      );
      for (const line of lines)
        db.prepare("INSERT INTO sale_lines VALUES(?,?,?,?,?,?)").run(
          id(),
          saleId,
          line.item.id,
          line.item.name,
          line.quantity,
          line.item.price,
        );
      if (plan.cashMovementMinor)
        db.prepare("INSERT INTO movements VALUES(?,?,?,?,?,?,?)").run(
          id(),
          drawer.id,
          plan.cashMovementMinor,
          "SALE_CASH_IN",
          saleId,
          null,
          now(),
        );
      if (plan.debtChargeMinor)
        db.prepare("INSERT INTO ledger VALUES(?,?,?,?,?,?,?,?,?)").run(
          id(),
          buyer.id,
          plan.debtChargeMinor,
          "CHARGE",
          saleId,
          null,
          user.id,
          now(),
          `sale:${key}`,
        );
      audit(user.id, "POST_SALE", saleId, plan);
      return json(res, 201, {
        id: saleId,
        totalMinor: quote.totalMinor,
        ...plan,
      });
    });
  }
  if (
    method === "POST" &&
    path.startsWith("/api/buyers/") &&
    path.endsWith("/payments")
  ) {
    roles(user, "CASHIER", "ADMIN");
    const buyerId = path.split("/")[3],
      input = await body(req),
      key = req.headers["idempotency-key"];
    if (typeof key !== "string" || key.length < 8)
      throw appError("Idempotency-Key header required");
    return transactional(() => {
      const existing = db
        .prepare("SELECT id FROM ledger WHERE request_key=?")
        .get(key);
      if (existing) return json(res, 200, existing);
      if (!findUser(buyerId)) throw appError("Buyer not found", 404);
      const drawer = activeDrawer(user.id);
      const plan = planDebtPayment({
        paymentMinor: input.amountMinor,
        outstandingMinor: balance(buyerId),
        method: "CASH",
        drawerOpen: !!drawer,
      });
      const ledgerId = id();
      db.prepare("INSERT INTO ledger VALUES(?,?,?,?,?,?,?,?,?)").run(
        ledgerId,
        buyerId,
        plan.debtLedgerAmountMinor,
        "PAYMENT",
        null,
        null,
        user.id,
        now(),
        key,
      );
      db.prepare("INSERT INTO movements VALUES(?,?,?,?,?,?,?)").run(
        id(),
        drawer.id,
        plan.cashMovementMinor,
        "DEBT_PAYMENT_CASH_IN",
        null,
        ledgerId,
        now(),
      );
      audit(user.id, "DEBT_PAYMENT", ledgerId, plan);
      return json(res, 201, { id: ledgerId, ...plan });
    });
  }
  if (
    method === "POST" &&
    path.startsWith("/api/buyers/") &&
    path.endsWith("/paper-debt")
  ) {
    roles(user, "ADMIN");
    const buyerId = path.split("/")[3],
      input = await body(req),
      key = req.headers["idempotency-key"];
    if (typeof key !== "string" || key.length < 8)
      throw appError("Idempotency-Key header required");
    if (
      !Number.isSafeInteger(input.amountMinor) ||
      input.amountMinor <= 0 ||
      !input.reference?.trim()
    )
      throw appError("Positive amount and paper reference required");
    return transactional(() => {
      const existing = db
        .prepare("SELECT id FROM ledger WHERE request_key=?")
        .get(key);
      if (existing) return json(res, 200, existing);
      if (!findUser(buyerId)) throw appError("Buyer not found", 404);
      if (
        db
          .prepare(
            "SELECT id FROM ledger WHERE type='PAPER_IMPORT' AND buyer_id=? AND reference=?",
          )
          .get(buyerId, input.reference.trim())
      )
        throw appError("Paper reference already imported");
      const ledgerId = id();
      db.prepare("INSERT INTO ledger VALUES(?,?,?,?,?,?,?,?,?)").run(
        ledgerId,
        buyerId,
        input.amountMinor,
        "PAPER_IMPORT",
        null,
        input.reference.trim(),
        user.id,
        now(),
        key,
      );
      audit(user.id, "PAPER_IMPORT", ledgerId);
      return json(res, 201, { id: ledgerId });
    });
  }
  if (method === "GET" && path === "/api/reports/summary") {
    roles(user, "ADMIN");
    const sales = db
      .prepare(
        "SELECT COALESCE(SUM(total),0) gross,COALESCE(SUM(cash),0) cash,COALESCE(SUM(debt),0) debt FROM sales WHERE status='POSTED'",
      )
      .get();
    const debt = db
      .prepare("SELECT COALESCE(SUM(amount),0) outstanding FROM ledger")
      .get();
    const payments = db
      .prepare(
        "SELECT COALESCE(SUM(amount),0) cashDebtPayments FROM movements WHERE type='DEBT_PAYMENT_CASH_IN'",
      )
      .get();
    const sections = db
      .prepare(
        "SELECT sections.name,COALESCE(SUM(sales.total),0) revenue,COALESCE(SUM(sales.debt),0) newDebt FROM sections LEFT JOIN sales ON sales.section_id=sections.id GROUP BY sections.id ORDER BY sections.name",
      )
      .all();
    return json(res, 200, { ...sales, ...debt, ...payments, sections });
  }
  if (method === "GET" && path === "/api/reports/period") {
    roles(user, "ADMIN");
    const query = new URL(req.url, "http://localhost").searchParams;
    const from = query.get("from"),
      to = query.get("to");
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(from || "") ||
      !/^\d{4}-\d{2}-\d{2}$/.test(to || "") ||
      from > to
    )
      throw appError("Valid from/to dates required");
    const start = Date.parse(`${from}T00:00:00+08:00`),
      end = Date.parse(`${to}T00:00:00+08:00`);
    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      new Date(start).toLocaleDateString("en-CA", {
        timeZone: "Asia/Manila",
      }) !== from ||
      new Date(end).toLocaleDateString("en-CA", { timeZone: "Asia/Manila" }) !==
        to
    )
      throw appError("Invalid calendar date");
    const fromUtc = new Date(start).toISOString(),
      toUtc = new Date(end + 86_399_999).toISOString();
    const sales = db
      .prepare(
        "SELECT COALESCE(SUM(total),0) gross,COALESCE(SUM(cash),0) cash,COALESCE(SUM(debt),0) debt FROM sales WHERE status='POSTED' AND created_at BETWEEN ? AND ?",
      )
      .get(fromUtc, toUtc);
    const payments = db
      .prepare(
        "SELECT COALESCE(SUM(-amount),0) settled FROM ledger WHERE type='PAYMENT' AND created_at BETWEEN ? AND ?",
      )
      .get(fromUtc, toUtc);
    const imports = db
      .prepare(
        "SELECT COALESCE(SUM(amount),0) paperImported FROM ledger WHERE type='PAPER_IMPORT' AND created_at BETWEEN ? AND ?",
      )
      .get(fromUtc, toUtc);
    const sections = db
      .prepare(
        "SELECT sections.name,COALESCE(SUM(sales.total),0) revenue,COALESCE(SUM(sales.debt),0) newDebt FROM sales LEFT JOIN sections ON sections.id=sales.section_id WHERE sales.status='POSTED' AND sales.created_at BETWEEN ? AND ? GROUP BY sections.id ORDER BY sections.name",
      )
      .all(fromUtc, toUtc);
    return json(res, 200, {
      from,
      to,
      ...sales,
      ...payments,
      ...imports,
      sections,
    });
  }
  if (method === "GET" && path === "/api/reports/audit") {
    roles(user, "ADMIN");
    return json(
      res,
      200,
      db
        .prepare("SELECT * FROM audit ORDER BY created_at DESC LIMIT 100")
        .all(),
    );
  }
  throw appError("Route not found", 404);
}

const webRoot = join(process.cwd(), "web");
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (
      req.method !== "GET" &&
      req.headers.origin &&
      new URL(req.headers.origin).host !== req.headers.host
    )
      throw appError("Invalid origin", 403);
    if (url.pathname.startsWith("/api/"))
      return await api(req, res, url.pathname);
    if (req.method !== "GET") throw appError("Method not allowed", 405);
    const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    if (
      ![
        "index.html",
        "app.js",
        "api.js",
        "paper-ui.js",
        "slip-sheet.js",
        "style.css",
        "theme.css",
        "paper.css",
        "manifest.webmanifest",
        "service-worker.js",
        "app-icon.svg",
        "app-icon-192.png",
        "app-icon-512.png",
      ].includes(file)
    )
      throw appError("Not found", 404);
    const mime = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".webmanifest": "application/manifest+json; charset=utf-8",
      ".svg": "image/svg+xml; charset=utf-8",
      ".png": "image/png",
    };
    res.writeHead(200, {
      "content-type": mime[extname(file)],
      "x-content-type-options": "nosniff",
    });
    res.end(readFileSync(join(webRoot, file)));
  } catch (error) {
    const status = Number.isInteger(error.code) ? error.code : 500;
    // A handler can fail after sending headers; avoid writing a second response.
    if (!res.headersSent)
      json(res, status, {
        error: status === 500 ? "Internal server error" : error.message,
      });
    if (status === 500) console.error(error);
  }
});
const host = process.env.HOST || "127.0.0.1";
server.listen(Number(process.env.PORT || 3000), host, () =>
  console.log(
    `Canteen running at http://${host}:${process.env.PORT || 3000}`,
  ),
);
