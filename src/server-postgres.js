import http from "node:http";
import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import pg from "pg";

const { Pool } = pg;
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "0" ? false : { rejectUnauthorized: false },
});
const now = () => new Date().toISOString();
const id = () => randomUUID();
const appError = (message, code = 400) => Object.assign(new Error(message), { code });
const hashPassword = (password) => {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
};
const verifyPassword = (password, stored) => {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
const rows = async (text, values = [], client = pool) => (await client.query(text, values)).rows;
const row = async (text, values = [], client = pool) => (await client.query(text, values)).rows[0];
const roles = (user, ...allowed) => {
  if (!allowed.includes(user.role)) throw appError("Forbidden", 403);
};
const transaction = async (work) => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};

await pool.query(`
CREATE TABLE IF NOT EXISTS sections(id text PRIMARY KEY, name text NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS users(
  id text PRIMARY KEY, name text NOT NULL, username text NOT NULL UNIQUE,
  password_hash text NOT NULL, role text NOT NULL CHECK(role IN ('ADMIN','CASHIER','GUARD','BUYER')),
  section_id text REFERENCES sections(id), credit_limit integer NOT NULL DEFAULT 0,
  credit_allowed integer NOT NULL DEFAULT 0, restricted integer NOT NULL DEFAULT 0,
  active integer NOT NULL DEFAULT 1, must_change_password integer NOT NULL DEFAULT 0,
  profile_details text NOT NULL DEFAULT '', profile_picture text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sessions(token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id), expires_at bigint NOT NULL);
CREATE TABLE IF NOT EXISTS audit(id text PRIMARY KEY, actor_id text REFERENCES users(id), action text NOT NULL, subject_id text, details text, created_at text NOT NULL);
CREATE TABLE IF NOT EXISTS paper_fields(id text PRIMARY KEY, name text NOT NULL UNIQUE, kind text NOT NULL CHECK(kind IN ('CREDIT','CASH')), created_at text NOT NULL);
CREATE TABLE IF NOT EXISTS paper_people(
  id text PRIMARY KEY, name text NOT NULL, employee_code text, field_id text NOT NULL REFERENCES paper_fields(id),
  created_at text NOT NULL, owner_id text NOT NULL REFERENCES users(id), UNIQUE(owner_id,employee_code)
);
CREATE TABLE IF NOT EXISTS paper_slips(
  id text PRIMARY KEY, person_id text REFERENCES paper_people(id), field_id text NOT NULL REFERENCES paper_fields(id),
  amount_minor integer NOT NULL CHECK(amount_minor>0), slip_date text NOT NULL, reference text,
  recorded_by text NOT NULL REFERENCES users(id), created_at text NOT NULL, request_key text NOT NULL UNIQUE, person_name text
);
CREATE TABLE IF NOT EXISTS paper_collections(
  id text PRIMARY KEY, slip_id text NOT NULL REFERENCES paper_slips(id), amount_minor integer NOT NULL CHECK(amount_minor>0),
  method text NOT NULL CHECK(method IN ('PAYROLL','CASH')), collection_date text NOT NULL, reference text,
  recorded_by text NOT NULL REFERENCES users(id), created_at text NOT NULL, request_key text NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS paper_people_owner_idx ON paper_people(owner_id,field_id,name);
CREATE INDEX IF NOT EXISTS paper_slips_owner_idx ON paper_slips(recorded_by,slip_date);
CREATE INDEX IF NOT EXISTS paper_collections_slip_idx ON paper_collections(slip_id);
`);

async function audit(actor, action, subject, details = {}, client = pool) {
  await client.query("INSERT INTO audit VALUES($1,$2,$3,$4,$5,$6)", [id(), actor, action, subject, JSON.stringify(details), now()]);
}
async function findUser(userId, client = pool) {
  return row("SELECT id,name,username,role,section_id,credit_limit,credit_allowed,restricted,active,must_change_password,profile_details,profile_picture FROM users WHERE id=$1", [userId], client);
}
async function bootstrap() {
  if (Number((await row("SELECT COUNT(*) count FROM users")).count)) return;
  const password = process.env.CANTEEN_ADMIN_PASSWORD;
  if (!password || password.length < 12)
    throw new Error("Set CANTEEN_ADMIN_PASSWORD to at least 12 characters for first deployment");
  const admin = id();
  await pool.query("INSERT INTO users(id,name,username,password_hash,role) VALUES($1,$2,$3,$4,$5)", [admin, "Administrator", "admin", hashPassword(password), "ADMIN"]);
  await audit(admin, "BOOTSTRAP", admin);
}
await bootstrap();
for (const [name, kind] of [["Guards","CREDIT"],["Admin","CREDIT"],["Operation","CREDIT"],["Extra","CREDIT"],["Agency","CREDIT"],["Driver","CREDIT"],["Cash","CASH"]])
  await pool.query("INSERT INTO paper_fields VALUES($1,$2,$3,$4) ON CONFLICT(name) DO NOTHING", [id(), name, kind, now()]);

function json(res, status, value, headers = {}) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(value));
}
function body(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 400000) reject(appError("Request too large", 413));
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(appError("Invalid JSON")); }
    });
  });
}
async function authentication(req) {
  const token = req.headers.cookie?.match(/canteen_session=([^;]+)/)?.[1];
  if (!token) throw appError("Log in required", 401);
  const tokenHash = scryptSync(token, "canteen-session", 32).toString("hex");
  const session = await row("SELECT user_id FROM sessions WHERE token_hash=$1 AND expires_at>$2", [tokenHash, Date.now()]);
  const user = session && await findUser(session.user_id);
  if (!user || !user.active) throw appError("Log in required", 401);
  return user;
}
const validDate = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
const validAmount = (value) => Number.isSafeInteger(value) && value > 0;
async function listPeople(owner) {
  return rows(`SELECT p.*,f.name field_name,
    COALESCE((SELECT SUM(s.amount_minor) FROM paper_slips s WHERE s.recorded_by=p.owner_id AND (s.person_id=p.id OR (s.person_id IS NULL AND lower(s.person_name)=lower(p.name) AND s.field_id=p.field_id))),0)::int -
    COALESCE((SELECT SUM(c.amount_minor) FROM paper_collections c JOIN paper_slips s ON s.id=c.slip_id WHERE s.recorded_by=p.owner_id AND (s.person_id=p.id OR (s.person_id IS NULL AND lower(s.person_name)=lower(p.name) AND s.field_id=p.field_id))),0)::int outstanding_minor
    FROM paper_people p JOIN paper_fields f ON f.id=p.field_id WHERE p.owner_id=$1 ORDER BY f.name,p.name`, [owner]);
}
async function listSlips(owner) {
  return rows(`SELECT s.*,f.name field_name,f.kind field_kind,COALESCE(s.person_name,p.name) display_name,
    COALESCE((SELECT SUM(c.amount_minor) FROM paper_collections c WHERE c.slip_id=s.id),0)::int collected_minor
    FROM paper_slips s JOIN paper_fields f ON f.id=s.field_id LEFT JOIN paper_people p ON p.id=s.person_id
    WHERE s.recorded_by=$1 ORDER BY s.slip_date DESC,s.created_at DESC LIMIT 500`, [owner]);
}
async function paperReport(owner, from, to) {
  if ((from && !validDate(from)) || (to && !validDate(to)) || (from && to && from > to)) throw appError("Use a valid date range");
  const fields = (await rows("SELECT * FROM paper_fields ORDER BY CASE WHEN kind='CASH' THEN 1 ELSE 0 END,name")).map((field) => ({ ...field, salesMinor: 0, collectedMinor: 0, outstandingMinor: 0 }));
  const byId = new Map(fields.map((field) => [field.id, field]));
  const slips = await rows("SELECT id,field_id,amount_minor,slip_date FROM paper_slips WHERE recorded_by=$1", [owner]);
  const collections = await rows("SELECT c.slip_id,c.amount_minor,c.method,c.collection_date,s.field_id FROM paper_collections c JOIN paper_slips s ON s.id=c.slip_id WHERE s.recorded_by=$1", [owner]);
  const inRange = (day) => (!from || day >= from) && (!to || day <= to);
  for (const slip of slips) {
    const field = byId.get(slip.field_id);
    if (inRange(slip.slip_date)) { field.salesMinor += slip.amount_minor; if (field.kind === "CASH") field.collectedMinor += slip.amount_minor; }
    if (field.kind === "CREDIT" && (!to || slip.slip_date <= to)) field.outstandingMinor += slip.amount_minor;
  }
  let payrollMinor = 0, cashMinor = 0;
  for (const collection of collections) {
    const field = byId.get(collection.field_id);
    if (inRange(collection.collection_date)) { field.collectedMinor += collection.amount_minor; collection.method === "PAYROLL" ? payrollMinor += collection.amount_minor : cashMinor += collection.amount_minor; }
    if (!to || collection.collection_date <= to) field.outstandingMinor -= collection.amount_minor;
  }
  const total = (key) => fields.reduce((sum, field) => sum + field[key], 0);
  return { from: from || null, to: to || null, salesMinor: total("salesMinor"), collectedMinor: total("collectedMinor"), outstandingMinor: total("outstandingMinor"), payrollMinor, cashMinor: cashMinor + (fields.find((field) => field.kind === "CASH")?.collectedMinor || 0), fields };
}

async function api(req, res, path) {
  const method = req.method;
  if (method === "GET" && path === "/api/health") return json(res, 200, { status: "ok", database: "postgres" });
  if (method === "POST" && path === "/api/login") {
    const input = await body(req);
    const account = await row("SELECT * FROM users WHERE lower(username)=lower($1) AND active=1", [input.username || ""]);
    if (!account || typeof input.password !== "string" || !verifyPassword(input.password, account.password_hash)) throw appError("Invalid credentials", 401);
    const token = randomBytes(32).toString("hex");
    await pool.query("INSERT INTO sessions VALUES($1,$2,$3)", [scryptSync(token, "canteen-session", 32).toString("hex"), account.id, Date.now() + 28800000]);
    await audit(account.id, "LOGIN", account.id);
    return json(res, 200, await findUser(account.id), { "set-cookie": `canteen_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800` });
  }
  const user = await authentication(req);
  if (method === "GET" && path === "/api/me") return json(res, 200, user);
  if (method === "POST" && path === "/api/logout") {
    const token = req.headers.cookie?.match(/canteen_session=([^;]+)/)?.[1];
    if (token) await pool.query("DELETE FROM sessions WHERE token_hash=$1", [scryptSync(token, "canteen-session", 32).toString("hex")]);
    return json(res, 200, { ok: true }, { "set-cookie": "canteen_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0" });
  }
  if (method === "POST" && path === "/api/change-password") {
    const input = await body(req);
    const credentials = await row("SELECT password_hash FROM users WHERE id=$1", [user.id]);
    if (!verifyPassword(input.currentPassword, credentials.password_hash)) throw appError("Current password is incorrect", 401);
    if (typeof input.newPassword !== "string" || input.newPassword.length < 12 || input.newPassword !== input.confirmPassword) throw appError("New matching password must contain at least 12 characters");
    await pool.query("UPDATE users SET password_hash=$1,must_change_password=0 WHERE id=$2", [hashPassword(input.newPassword), user.id]);
    await audit(user.id, "CHANGE_PASSWORD", user.id);
    return json(res, 200, await findUser(user.id));
  }
  if (method === "PATCH" && path === "/api/profile") {
    const input = await body(req), name = input.name?.trim(), username = input.username?.trim(), details = input.profileDetails?.trim() || "", picture = input.profilePicture || "";
    if (!name || !username || details.length > 500 || picture.length > 350000) throw appError("Invalid profile details");
    if (await row("SELECT id FROM users WHERE lower(username)=lower($1) AND id<>$2", [username, user.id])) throw appError("Username is already in use", 409);
    await pool.query("UPDATE users SET name=$1,username=$2,profile_details=$3,profile_picture=$4 WHERE id=$5", [name, username, details, picture, user.id]);
    return json(res, 200, await findUser(user.id));
  }
  if (user.must_change_password) throw appError("Change your temporary password before continuing", 403);

  if (method === "GET" && path === "/api/paper/fields") return json(res, 200, await rows("SELECT * FROM paper_fields ORDER BY CASE WHEN kind='CASH' THEN 1 ELSE 0 END,name"));
  if (method === "POST" && path === "/api/paper/fields") {
    roles(user, "ADMIN"); const input = await body(req), name = input.name?.trim(); if (!name) throw appError("Department name required");
    const fieldId = id(); await pool.query("INSERT INTO paper_fields VALUES($1,$2,'CREDIT',$3)", [fieldId, name, now()]); await audit(user.id, "ADD_PAPER_FIELD", fieldId, { name }); return json(res, 201, { id: fieldId, name, kind: "CREDIT" });
  }
  if (/^\/api\/paper\/fields\/[^/]+$/.test(path) && method === "PATCH") {
    roles(user, "ADMIN"); const fieldId = path.split("/")[4], input = await body(req), name = input.name?.trim(); if (!name) throw appError("Department name required");
    const result = await pool.query("UPDATE paper_fields SET name=$1 WHERE id=$2 AND kind<>'CASH'", [name, fieldId]); if (!result.rowCount) throw appError("Department not found", 404); return json(res, 200, { id: fieldId, name });
  }
  if (/^\/api\/paper\/fields\/[^/]+$/.test(path) && method === "DELETE") {
    roles(user, "ADMIN"); const fieldId = path.split("/")[4];
    if (Number((await row("SELECT COUNT(*) count FROM paper_people WHERE field_id=$1", [fieldId])).count) || Number((await row("SELECT COUNT(*) count FROM paper_slips WHERE field_id=$1", [fieldId])).count)) throw appError("Department has workers or slip history");
    await pool.query("DELETE FROM paper_fields WHERE id=$1 AND kind<>'CASH'", [fieldId]); return json(res, 200, { ok: true });
  }
  if (method === "GET" && path === "/api/paper/people") return json(res, 200, await listPeople(user.id));
  if (method === "POST" && path === "/api/paper/people") {
    roles(user, "ADMIN", "CASHIER"); const input = await body(req), name = input.name?.trim(); if (!name) throw appError("Person name required");
    const personId = id(); await pool.query("INSERT INTO paper_people VALUES($1,$2,$3,$4,$5,$6)", [personId, name, input.employeeCode?.trim() || null, input.fieldId, now(), user.id]); return json(res, 201, { id: personId });
  }
  if (/^\/api\/paper\/people\/[^/]+$/.test(path) && method === "PATCH") {
    const personId = path.split("/")[4], input = await body(req), name = input.name?.trim(); if (!name) throw appError("Person name required");
    const result = await pool.query("UPDATE paper_people SET name=$1,employee_code=$2,field_id=$3 WHERE id=$4 AND owner_id=$5", [name, input.employeeCode?.trim() || null, input.fieldId, personId, user.id]); if (!result.rowCount) throw appError("Person not found", 404); return json(res, 200, { id: personId });
  }
  if (/^\/api\/paper\/people\/[^/]+$/.test(path) && method === "DELETE") {
    const personId = path.split("/")[4]; await transaction(async (client) => { const person = await row("SELECT * FROM paper_people WHERE id=$1 AND owner_id=$2", [personId, user.id], client); if (!person) throw appError("Person not found", 404); await client.query("UPDATE paper_slips SET person_name=COALESCE(person_name,$1),person_id=NULL WHERE person_id=$2", [person.name, personId]); await client.query("DELETE FROM paper_people WHERE id=$1", [personId]); }); return json(res, 200, { ok: true });
  }
  if (method === "GET" && path === "/api/paper/slips") return json(res, 200, await listSlips(user.id));
  const insertSlip = async (input, requestKey, client) => {
    if (!validAmount(input.amountMinor) || !validDate(input.slipDate)) throw appError("Valid amount and exact date required");
    const existing = await row("SELECT id FROM paper_slips WHERE request_key=$1", [requestKey], client); if (existing) return existing;
    let person = null; if (input.personId) { person = await row("SELECT * FROM paper_people WHERE id=$1 AND owner_id=$2", [input.personId, user.id], client); if (!person || person.field_id !== input.fieldId) throw appError("Choose a person in this department"); }
    const slipId = id(); await client.query("INSERT INTO paper_slips VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)", [slipId, person?.id || null, input.fieldId, input.amountMinor, input.slipDate, input.reference?.trim() || null, user.id, now(), requestKey, input.name?.trim() || person?.name || null]); return { id: slipId };
  };
  if (method === "POST" && path === "/api/paper/slips") {
    const input = await body(req);
    return json(res, 201, await transaction((client) => insertSlip(input, req.headers["idempotency-key"], client)));
  }
  if (method === "POST" && path === "/api/paper/slips/batch") {
    const input = await body(req), key = req.headers["idempotency-key"]; if (!Array.isArray(input.slips) || !input.slips.length) throw appError("Enter at least one slip");
    return json(res, 201, await transaction(async (client) => { const saved = []; for (let index=0; index<input.slips.length; index++) saved.push(await insertSlip(input.slips[index], `${key}:${index}`, client)); return saved; }));
  }
  if (method === "POST" && path === "/api/paper/collections") {
    const input = await body(req), key = req.headers["idempotency-key"];
    const result = await transaction(async (client) => { const existing = await row("SELECT id FROM paper_collections WHERE request_key=$1", [key], client); if (existing) return existing; const slip = await row("SELECT * FROM paper_slips WHERE id=$1 AND recorded_by=$2 FOR UPDATE", [input.slipId, user.id], client); if (!slip) throw appError("Slip not found", 404); const paid = Number((await row("SELECT COALESCE(SUM(amount_minor),0) amount FROM paper_collections WHERE slip_id=$1", [slip.id], client)).amount); if (!validAmount(input.amountMinor) || input.amountMinor > slip.amount_minor-paid || !validDate(input.collectionDate)) throw appError("Invalid collection amount or exact date"); const collectionId=id(); await client.query("INSERT INTO paper_collections VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)", [collectionId, slip.id, input.amountMinor, input.method, input.collectionDate, input.reference?.trim() || null, user.id, now(), key]); return { id: collectionId, remainingMinor: slip.amount_minor-paid-input.amountMinor }; }); return json(res, 201, result);
  }
  if (method === "GET" && path === "/api/paper/report") { const query = new URL(req.url, "http://localhost").searchParams; return json(res, 200, await paperReport(user.id, query.get("from"), query.get("to"))); }

  if (method === "GET" && path === "/api/sections") return json(res, 200, await rows("SELECT * FROM sections ORDER BY name"));
  if (method === "POST" && path === "/api/sections") { roles(user,"ADMIN"); const input=await body(req), sectionId=id(); await pool.query("INSERT INTO sections VALUES($1,$2)",[sectionId,input.name?.trim()]); return json(res,201,{id:sectionId}); }
  if (method === "GET" && path === "/api/users") { roles(user,"ADMIN","CASHIER"); return json(res,200,await rows("SELECT id,name,username,role,section_id,credit_limit,credit_allowed,restricted,active,must_change_password FROM users ORDER BY name")); }
  if (method === "POST" && path === "/api/users") {
    roles(user,"ADMIN"); const input=await body(req); if(!input.name?.trim()||!input.username?.trim()||typeof input.password!=="string"||input.password.length<12||!["ADMIN","CASHIER","GUARD","BUYER"].includes(input.role)) throw appError("Invalid account details"); const userId=id(); await pool.query("INSERT INTO users(id,name,username,password_hash,role,section_id,credit_limit,credit_allowed,must_change_password) VALUES($1,$2,$3,$4,$5,$6,$7,$8,1)",[userId,input.name.trim(),input.username.trim().toLowerCase(),hashPassword(input.password),input.role,input.sectionId||null,input.creditLimitMinor||0,input.creditAllowed?1:0]); await audit(user.id,"CREATE_USER",userId); return json(res,201,{id:userId});
  }
  if (/^\/api\/users\/[^/]+$/.test(path) && method === "PATCH") {
    roles(user,"ADMIN"); const target=path.split("/")[3], input=await body(req); await transaction(async(client)=>{ await client.query("UPDATE users SET name=$1,username=$2,role=$3,section_id=$4,credit_limit=$5,credit_allowed=$6,restricted=$7,active=$8 WHERE id=$9",[input.name?.trim(),input.username?.trim().toLowerCase(),input.role,input.sectionId||null,input.creditLimitMinor||0,input.creditAllowed?1:0,input.restricted?1:0,input.active?1:0,target]); if(input.password){await client.query("UPDATE users SET password_hash=$1,must_change_password=1 WHERE id=$2",[hashPassword(input.password),target]);await client.query("DELETE FROM sessions WHERE user_id=$1",[target]);}}); return json(res,200,await findUser(target));
  }
  if (method === "GET" && path === "/api/reports/audit") { roles(user,"ADMIN"); return json(res,200,await rows("SELECT * FROM audit ORDER BY created_at DESC LIMIT 100")); }
  if (method === "GET" && path === "/api/verify") return json(res,404,{error:"Buyer not found"});
  if (method === "GET" && /^\/api\/buyers\/[^/]+$/.test(path)) { const target=path.split("/")[3]; if(user.id!==target&&!["ADMIN","CASHIER"].includes(user.role)) throw appError("Forbidden",403); const buyer=await findUser(target); return json(res,200,{...buyer,balanceMinor:0,availableCreditMinor:buyer?.credit_limit||0}); }
  if (method === "GET" && /\/ledger$/.test(path)) return json(res,200,[]);
  throw appError("Route not found",404);
}

const webRoot = join(process.cwd(), "web");
const allowed = new Set(["index.html","app.js","api.js","paper-ui.js","slip-sheet.js","style.css","theme.css","paper.css","manifest.webmanifest","service-worker.js","app-icon.svg","app-icon-192.png","app-icon-512.png"]);
const mime = { ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8", ".css":"text/css; charset=utf-8", ".webmanifest":"application/manifest+json; charset=utf-8", ".svg":"image/svg+xml; charset=utf-8", ".png":"image/png" };
const server = http.createServer(async(req,res)=>{try{const url=new URL(req.url,"http://localhost");if(req.method!=="GET"&&req.headers.origin&&new URL(req.headers.origin).host!==req.headers.host)throw appError("Invalid origin",403);if(url.pathname.startsWith("/api/"))return await api(req,res,url.pathname);if(req.method!=="GET")throw appError("Method not allowed",405);const file=url.pathname==="/"?"index.html":url.pathname.slice(1);if(!allowed.has(file))throw appError("Not found",404);res.writeHead(200,{"content-type":mime[extname(file)],"x-content-type-options":"nosniff"});res.end(readFileSync(join(webRoot,file)));}catch(error){const status=Number.isInteger(error.code)?error.code:error.code==="23505"?409:500;if(!res.headersSent)json(res,status,{error:status===500?"Internal server error":error.message});if(status===500)console.error(error);}});
const host=process.env.HOST||"0.0.0.0", port=Number(process.env.PORT||3000);
server.listen(port,host,()=>console.log(`Canteen PostgreSQL server running at http://${host}:${port}`));
