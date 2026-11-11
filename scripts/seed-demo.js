// Optional local-only sample data. Existing usernames and passwords are never overwritten.
import { DatabaseSync } from "node:sqlite";
import { scryptSync, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";

const password = process.env.CANTEEN_DEMO_PASSWORD;
if (!password || password.length < 12) {
  console.error("Set CANTEEN_DEMO_PASSWORD to at least 12 characters first.");
  process.exit(1);
}

const dataDir = process.env.CANTEEN_DATA_DIR || join(process.cwd(), "data");
const db = new DatabaseSync(join(dataDir, "canteen.sqlite"));
db.exec("PRAGMA foreign_keys=ON");
const salt = () => randomBytes(16).toString("hex");
const hash = (value) => {
  const s = salt();
  return `${s}:${scryptSync(value, s, 64).toString("hex")}`;
};
const users = [
  ["demo.admin", "Demo Administrator", "ADMIN", 0, 0],
  ["demo.cashier", "Demo Cashier", "CASHIER", 0, 0],
  ["demo.guard", "Demo Guard", "GUARD", 0, 0],
  ["demo.buyer", "Demo Buyer", "BUYER", 20000, 1],
];

db.exec("BEGIN IMMEDIATE");
try {
  let section = db
    .prepare("SELECT id FROM sections WHERE name=?")
    .get("Demo Section")?.id;
  if (!section) {
    section = randomUUID();
    db.prepare("INSERT INTO sections VALUES(?,?)").run(section, "Demo Section");
  }
  for (const [username, name, role, limit, allowed] of users) {
    if (db.prepare("SELECT id FROM users WHERE username=?").get(username))
      continue;
    const userId = randomUUID();
    db.prepare(
      "INSERT INTO users(id,name,username,password_hash,role,section_id,credit_limit,credit_allowed) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      userId,
      name,
      username,
      hash(password),
      role,
      section,
      limit,
      allowed,
    );
    db.prepare("INSERT INTO audit VALUES(?,?,?,?,?,?)").run(
      randomUUID(),
      userId,
      "CREATE_DEMO_USER",
      userId,
      "{}",
      new Date().toISOString(),
    );
  }
  for (const [name, price] of [
    ["Chicken rice", 8500],
    ["Vegetable bowl", 6500],
    ["Coffee", 3000],
  ]) {
    if (!db.prepare("SELECT id FROM items WHERE name=?").get(name))
      db.prepare("INSERT INTO items VALUES(?,?,?,1)").run(
        randomUUID(),
        name,
        price,
      );
  }
  db.exec("COMMIT");
  console.log(
    "Demo accounts ready: demo.admin, demo.cashier, demo.guard, demo.buyer",
  );
  console.log(
    "Use the password supplied through CANTEEN_DEMO_PASSWORD. Existing accounts were not changed.",
  );
} catch (error) {
  db.exec("ROLLBACK");
  throw error;
} finally {
  db.close();
}
