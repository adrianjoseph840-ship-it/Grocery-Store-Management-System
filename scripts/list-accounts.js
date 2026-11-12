import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

const dataDir = process.env.CANTEEN_DATA_DIR || join(process.cwd(), "data");
const db = new DatabaseSync(join(dataDir, "canteen.sqlite"), { readOnly: true });
try {
  const accounts = db.prepare(
    "SELECT name, username AS email, role, active, must_change_password FROM users ORDER BY name",
  ).all();
  console.table(accounts.map(({ name, email, role, active, must_change_password }) => ({
    name,
    email,
    role,
    status: active ? "Active" : "Inactive",
    password: must_change_password ? "Change required" : "Set",
  })));
} finally {
  db.close();
}
