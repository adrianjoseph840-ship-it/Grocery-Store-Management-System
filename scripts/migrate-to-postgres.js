import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import pg from "pg";

if (!process.env.DATABASE_URL)
  throw new Error("Set DATABASE_URL to the Supabase session-pooler connection string first.");

const sqlite = new DatabaseSync(
  join(process.env.CANTEEN_DATA_DIR || join(process.cwd(), "data"), "canteen.sqlite"),
  { readOnly: true },
);
const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "0" ? false : { rejectUnauthorized: false },
});
const client = await pool.connect();
const local = (sql, ...values) => sqlite.prepare(sql).all(...values);

try {
  await client.query("BEGIN");
  const sectionMap = new Map();
  for (const section of local("SELECT * FROM sections")) {
    const result = await client.query(
      "INSERT INTO sections(id,name) VALUES($1,$2) ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name RETURNING id",
      [section.id, section.name],
    );
    sectionMap.set(section.id, result.rows[0].id);
  }

  const userMap = new Map();
  for (const user of local("SELECT * FROM users")) {
    const existing = await client.query(
      "SELECT id FROM users WHERE lower(username)=lower($1)",
      [user.username],
    );
    if (existing.rows[0]) {
      userMap.set(user.id, existing.rows[0].id);
      console.log(`users: kept hosted account ${user.username}`);
      continue;
    }
    await client.query(
      `INSERT INTO users(id,name,username,password_hash,role,section_id,credit_limit,credit_allowed,restricted,active,must_change_password,profile_details,profile_picture)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [user.id, user.name, user.username, user.password_hash, user.role,
       sectionMap.get(user.section_id) || null, user.credit_limit, user.credit_allowed,
       user.restricted, user.active, user.must_change_password,
       user.profile_details || "", user.profile_picture || ""],
    );
    userMap.set(user.id, user.id);
  }

  const fieldMap = new Map();
  for (const field of local("SELECT * FROM paper_fields")) {
    const result = await client.query(
      "INSERT INTO paper_fields(id,name,kind,created_at) VALUES($1,$2,$3,$4) ON CONFLICT(name) DO UPDATE SET kind=EXCLUDED.kind RETURNING id",
      [field.id, field.name, field.kind, field.created_at],
    );
    fieldMap.set(field.id, result.rows[0].id);
  }

  for (const person of local("SELECT * FROM paper_people"))
    await client.query(
      `INSERT INTO paper_people(id,name,employee_code,field_id,created_at,owner_id)
       VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`,
      [person.id, person.name, person.employee_code, fieldMap.get(person.field_id),
       person.created_at, userMap.get(person.owner_id)],
    );

  for (const slip of local("SELECT * FROM paper_slips"))
    await client.query(
      `INSERT INTO paper_slips(id,person_id,field_id,amount_minor,slip_date,reference,recorded_by,created_at,request_key,person_name)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(id) DO NOTHING`,
      [slip.id, slip.person_id, fieldMap.get(slip.field_id), slip.amount_minor,
       slip.slip_date, slip.reference, userMap.get(slip.recorded_by), slip.created_at,
       slip.request_key, slip.person_name],
    );

  for (const collection of local("SELECT * FROM paper_collections"))
    await client.query(
      `INSERT INTO paper_collections(id,slip_id,amount_minor,method,collection_date,reference,recorded_by,created_at,request_key)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING`,
      [collection.id, collection.slip_id, collection.amount_minor, collection.method,
       collection.collection_date, collection.reference, userMap.get(collection.recorded_by),
       collection.created_at, collection.request_key],
    );

  for (const entry of local("SELECT * FROM audit"))
    await client.query(
      `INSERT INTO audit(id,actor_id,action,subject_id,details,created_at)
       VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO NOTHING`,
      [entry.id, userMap.get(entry.actor_id) || null, entry.action,
       userMap.get(entry.subject_id) || entry.subject_id, entry.details, entry.created_at],
    );

  await client.query("COMMIT");
  console.log("Migration completed. Hosted admin credentials were kept; all dependent IDs were mapped safely.");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
  sqlite.close();
}
