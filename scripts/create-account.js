import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { join } from "node:path";

const terminal = createInterface({ input: stdin, output: stdout });
try {
  const email = (await terminal.question("Account email or username: ")).trim().toLowerCase();
  const name = (await terminal.question("Person's full name: ")).trim();
  const role = (await terminal.question("Role (press Enter for CASHIER; or ADMIN, GUARD, BUYER): ")).trim().toUpperCase() || "CASHIER";
  const password = await terminal.question("Temporary password (12+ characters): ");
  if (!/^[^\s@]+(?:@[^\s@]+\.[^\s@]+)?$/.test(email) || !name || !["ADMIN", "CASHIER", "GUARD", "BUYER"].includes(role) || password.length < 12)
    throw new Error("Enter an email or username, full name, valid role, and password of at least 12 characters.");

  const dataDir = process.env.CANTEEN_DATA_DIR || join(process.cwd(), "data");
  const db = new DatabaseSync(join(dataDir, "canteen.sqlite"));
  try {
    if (!db.prepare("PRAGMA table_info(users)").all().some((column) => column.name === "must_change_password"))
      throw new Error("Start the server once to initialize or update the database first.");
    if (db.prepare("SELECT id FROM users WHERE username=? COLLATE NOCASE").get(email))
      throw new Error("An account with this email already exists.");
    const salt = randomBytes(16).toString("hex");
    const hash = `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
    const id = randomUUID();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO users(id,name,username,password_hash,role,must_change_password) VALUES(?,?,?,?,?,1)").run(id, name, email, hash, role);
      db.prepare("INSERT INTO audit VALUES(?,?,?,?,?,?)").run(randomUUID(), null, "PROVISION_USER", id, JSON.stringify({ email, role }), new Date().toISOString());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    console.log(`Created ${email}. Give this person the email and temporary password you entered. They must change it at first sign-in.`);
  } finally {
    db.close();
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  terminal.close();
}
