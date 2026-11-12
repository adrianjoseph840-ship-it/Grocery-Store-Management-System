import { DatabaseSync } from "node:sqlite";
import { randomBytes, randomUUID, scryptSync } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { join } from "node:path";

const terminal = createInterface({ input: stdin, output: stdout });
try {
  const username = (await terminal.question("Account username: ")).trim();
  const password = await terminal.question("New temporary password (12+ characters): ");
  const confirmation = await terminal.question("Enter the new password again: ");
  if (!username || password.length < 12)
    throw new Error("Enter a username and a password of at least 12 characters.");
  if (password !== confirmation) throw new Error("The passwords do not match.");

  const dataDir = process.env.CANTEEN_DATA_DIR || join(process.cwd(), "data");
  const db = new DatabaseSync(join(dataDir, "canteen.sqlite"));
  try {
    const account = db
      .prepare("SELECT id,username FROM users WHERE username=? COLLATE NOCASE")
      .get(username);
    if (!account) throw new Error("Account not found.");
    const salt = randomBytes(16).toString("hex");
    const hash = `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        "UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?",
      ).run(hash, account.id);
      db.prepare("DELETE FROM sessions WHERE user_id=?").run(account.id);
      db.prepare("INSERT INTO audit VALUES(?,?,?,?,?,?)").run(
        randomUUID(),
        null,
        "LOCAL_PASSWORD_RESET",
        account.id,
        JSON.stringify({ username: account.username }),
        new Date().toISOString(),
      );
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    console.log(`Password reset for ${account.username}. You can now log in with the password you entered.`);
  } finally {
    db.close();
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  terminal.close();
}
