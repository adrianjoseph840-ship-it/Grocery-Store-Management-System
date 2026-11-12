import { randomUUID } from "node:crypto";

/** Paper-slip ledger. It lives beside the older POS tables so existing data survives. */
export function createPaperService(db, { audit, transactional, appError }) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS paper_fields (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      kind TEXT NOT NULL CHECK(kind IN ('CREDIT','CASH')), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS paper_people (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, employee_code TEXT UNIQUE,
      field_id TEXT NOT NULL REFERENCES paper_fields(id), created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS paper_slips (
      id TEXT PRIMARY KEY, person_id TEXT REFERENCES paper_people(id),
      field_id TEXT NOT NULL REFERENCES paper_fields(id), amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
      slip_date TEXT NOT NULL, reference TEXT, recorded_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL, request_key TEXT NOT NULL UNIQUE, person_name TEXT
    );
    CREATE TABLE IF NOT EXISTS paper_collections (
      id TEXT PRIMARY KEY, slip_id TEXT NOT NULL REFERENCES paper_slips(id),
      amount_minor INTEGER NOT NULL CHECK(amount_minor > 0),
      method TEXT NOT NULL CHECK(method IN ('PAYROLL','CASH')),
      collection_date TEXT NOT NULL, reference TEXT, recorded_by TEXT NOT NULL REFERENCES users(id),
      created_at TEXT NOT NULL, request_key TEXT NOT NULL UNIQUE
    );
    CREATE INDEX IF NOT EXISTS paper_slips_person_idx ON paper_slips(person_id,slip_date);
    CREATE INDEX IF NOT EXISTS paper_collections_slip_idx ON paper_collections(slip_id);
  `);
  // Existing local databases predate free-text names; add the column in place.
  if (
    !db
      .prepare("PRAGMA table_info(paper_slips)")
      .all()
      .some((column) => column.name === "person_name")
  )
    db.exec("ALTER TABLE paper_slips ADD COLUMN person_name TEXT");
  if (
    !db
      .prepare("PRAGMA table_info(paper_people)")
      .all()
      .some((column) => column.name === "owner_id")
  ) {
    db.exec("ALTER TABLE paper_people ADD COLUMN owner_id TEXT REFERENCES users(id)");
    const existingOwner = db
      .prepare("SELECT id FROM users WHERE username='admin' COLLATE NOCASE LIMIT 1")
      .get()?.id || db.prepare("SELECT id FROM users ORDER BY rowid LIMIT 1").get()?.id;
    if (existingOwner)
      db.prepare("UPDATE paper_people SET owner_id=? WHERE owner_id IS NULL").run(existingOwner);
  }
  db.exec("CREATE INDEX IF NOT EXISTS paper_people_owner_idx ON paper_people(owner_id,field_id,name)");

  // Default fields match the paper piles used at the counter. Custom fields are credit.
  for (const [name, kind] of [
    ["Guards", "CREDIT"],
    ["Admin", "CREDIT"],
    ["Operation", "CREDIT"],
    ["Extra", "CREDIT"],
    ["Agency", "CREDIT"],
    ["Driver", "CREDIT"],
    ["Cash", "CASH"],
  ]) {
    db.prepare("INSERT OR IGNORE INTO paper_fields VALUES(?,?,?,?)").run(
      randomUUID(),
      name,
      kind,
      new Date().toISOString(),
    );
  }

  const date = (value) => {
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      Number.isNaN(Date.parse(`${value}T00:00:00Z`)) ||
      new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
    )
      throw appError("Use a valid date in YYYY-MM-DD format");
    return value;
  };
  const amount = (value) => {
    if (!Number.isSafeInteger(value) || value <= 0)
      throw appError("Amount must be positive centavos");
    return value;
  };
  const key = (value) => {
    if (typeof value !== "string" || value.length < 8 || value.length > 200)
      throw appError("Idempotency-Key header required");
    return value;
  };
  const field = (fieldId) => {
    const row = db
      .prepare("SELECT * FROM paper_fields WHERE id=?")
      .get(fieldId);
    if (!row) throw appError("Field not found", 404);
    return row;
  };
  const slip = (slipId) => {
    const row = db.prepare("SELECT * FROM paper_slips WHERE id=?").get(slipId);
    if (!row) throw appError("Paper slip not found", 404);
    return row;
  };

  function listFields() {
    return db
      .prepare(
        "SELECT * FROM paper_fields ORDER BY CASE WHEN kind='CASH' THEN 1 ELSE 0 END,name",
      )
      .all();
  }
  function addField(input, actor) {
    const name = input.name?.trim();
    if (!name || name.length > 80)
      throw appError("Field name must be 1–80 characters");
    if (db.prepare("SELECT id FROM paper_fields WHERE name=?").get(name))
      throw appError("Field already exists", 409);
    const id = randomUUID();
    db.prepare("INSERT INTO paper_fields VALUES(?,?,?,?)").run(
      id,
      name,
      "CREDIT",
      new Date().toISOString(),
    );
    audit(actor, "ADD_PAPER_FIELD", id, { name });
    return { id, name, kind: "CREDIT" };
  }
  function updateField(fieldId, input, actor) {
    const current = field(fieldId);
    if (current.kind === "CASH") throw appError("The Cash field cannot be changed");
    const name = input.name?.trim();
    if (!name || name.length > 80)
      throw appError("Field name must be 1–80 characters");
    const duplicate = db
      .prepare("SELECT id FROM paper_fields WHERE name=? COLLATE NOCASE AND id<>?")
      .get(name, fieldId);
    if (duplicate) throw appError("Field already exists", 409);
    db.prepare("UPDATE paper_fields SET name=? WHERE id=?").run(name, fieldId);
    audit(actor, "UPDATE_PAPER_FIELD", fieldId, { before: current.name, after: name });
    return { ...current, name };
  }
  function deleteField(fieldId, actor) {
    const current = field(fieldId);
    if (current.kind === "CASH") throw appError("The Cash field cannot be deleted");
    const people = db.prepare("SELECT COUNT(*) count FROM paper_people WHERE field_id=?").get(fieldId).count;
    const slips = db.prepare("SELECT COUNT(*) count FROM paper_slips WHERE field_id=?").get(fieldId).count;
    if (people || slips)
      throw appError("Move or delete this field's workers first; fields with slip history cannot be deleted");
    db.prepare("DELETE FROM paper_fields WHERE id=?").run(fieldId);
    audit(actor, "DELETE_PAPER_FIELD", fieldId, { name: current.name });
    return { ok: true };
  }
  function listPeople(owner) {
    return db
      .prepare(
        `SELECT p.*,f.name field_name,
        COALESCE((SELECT SUM(s.amount_minor) FROM paper_slips s
          WHERE s.recorded_by=p.owner_id AND (s.person_id=p.id OR (s.person_id IS NULL AND s.person_name=p.name COLLATE NOCASE AND s.field_id=p.field_id))),0) -
        COALESCE((SELECT SUM(c.amount_minor) FROM paper_collections c JOIN paper_slips s ON s.id=c.slip_id
          WHERE s.recorded_by=p.owner_id AND (s.person_id=p.id OR (s.person_id IS NULL AND s.person_name=p.name COLLATE NOCASE AND s.field_id=p.field_id))),0) outstanding_minor
        FROM paper_people p JOIN paper_fields f ON f.id=p.field_id
        WHERE p.owner_id=?
        ORDER BY f.name,p.name`,
      )
      .all(owner);
  }
  function addPerson(input, actor) {
    const name = input.name?.trim();
    if (!name || name.length > 120)
      throw appError("Person name must be 1–120 characters");
    if (field(input.fieldId).kind !== "CREDIT")
      throw appError("Cash slips do not need a person");
    const employeeCode = input.employeeCode?.trim() || null;
    if (
      employeeCode &&
      db
        .prepare("SELECT id FROM paper_people WHERE employee_code=? AND owner_id=?")
        .get(employeeCode, actor)
    )
      throw appError("Employee code already exists", 409);
    const id = randomUUID();
    db.prepare("INSERT INTO paper_people(id,name,employee_code,field_id,created_at,owner_id) VALUES(?,?,?,?,?,?)").run(
      id,
      name,
      employeeCode,
      input.fieldId,
      new Date().toISOString(),
      actor,
    );
    audit(actor, "ADD_PAPER_PERSON", id, { name, fieldId: input.fieldId });
    return { id, name, employeeCode, fieldId: input.fieldId };
  }
  function updatePerson(personId, input, actor) {
    const current = db.prepare("SELECT * FROM paper_people WHERE id=? AND owner_id=?").get(personId, actor);
    if (!current) throw appError("Person not found", 404);
    const name = input.name?.trim();
    const employeeCode = input.employeeCode?.trim() || null;
    if (!name || name.length > 120)
      throw appError("Person name must be 1–120 characters");
    if (field(input.fieldId).kind !== "CREDIT")
      throw appError("Choose a payroll field");
    const duplicate = employeeCode && db
      .prepare("SELECT id FROM paper_people WHERE employee_code=? AND id<>? AND owner_id=?")
      .get(employeeCode, personId, actor);
    if (duplicate) throw appError("Employee code already exists", 409);
    db.prepare("UPDATE paper_people SET name=?,employee_code=?,field_id=? WHERE id=?")
      .run(name, employeeCode, input.fieldId, personId);
    audit(actor, "UPDATE_PAPER_PERSON", personId, { name, employeeCode, fieldId: input.fieldId });
    return { id: personId, name, employeeCode, fieldId: input.fieldId };
  }
  function deletePerson(personId, actor) {
    const current = db.prepare("SELECT * FROM paper_people WHERE id=? AND owner_id=?").get(personId, actor);
    if (!current) throw appError("Person not found", 404);
    transactional(() => {
      db.prepare("UPDATE paper_slips SET person_name=COALESCE(person_name,?),person_id=NULL WHERE person_id=?")
        .run(current.name, personId);
      db.prepare("DELETE FROM paper_people WHERE id=?").run(personId);
      audit(actor, "DELETE_PAPER_PERSON", personId, { name: current.name });
    });
    return { ok: true };
  }
  function listSlips(owner) {
    return db
      .prepare(
        `SELECT s.*,f.name field_name,f.kind field_kind,COALESCE(s.person_name,p.name) display_name,
      COALESCE((SELECT SUM(c.amount_minor) FROM paper_collections c WHERE c.slip_id=s.id),0) collected_minor
      FROM paper_slips s JOIN paper_fields f ON f.id=s.field_id
      LEFT JOIN paper_people p ON p.id=s.person_id
      WHERE s.recorded_by=?
      ORDER BY s.slip_date DESC,s.created_at DESC LIMIT 500`,
      )
      .all(owner);
  }
  function addSlip(input, actor, requestKey) {
    return transactional(() => insertSlip(input, actor, requestKey));
  }
  function addSlips(inputs, actor, batchKey) {
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 100)
      throw appError("Enter between 1 and 100 slips at a time");
    if (
      typeof batchKey !== "string" ||
      batchKey.length < 8 ||
      batchKey.length > 180
    )
      throw appError("Idempotency-Key header required");
    // One database transaction makes the spreadsheet Save All operation atomic.
    return transactional(() =>
      inputs.map((input, index) =>
        insertSlip(input, actor, `${batchKey}:${index}`),
      ),
    );
  }
  function insertSlip(input, actor, requestKey) {
    amount(input.amountMinor);
    date(input.slipDate);
    key(requestKey);
    const existing = db
      .prepare("SELECT id FROM paper_slips WHERE request_key=?")
      .get(requestKey);
    if (existing) return { id: existing.id, duplicate: true };
    const selected = field(input.fieldId);
    let personId = null;
    let personName = typeof input.name === "string" ? input.name.trim() : "";
    if (personName.length > 120)
      throw appError("Name must be 120 characters or less");
    if (input.personId) {
      const person = db
        .prepare("SELECT * FROM paper_people WHERE id=? AND owner_id=?")
        .get(input.personId, actor);
      if (!person || person.field_id !== selected.id)
        throw appError("Choose a person in this field");
      personId = person.id;
      if (!personName) personName = person.name;
    }
    const id = randomUUID();
    db.prepare(
      "INSERT INTO paper_slips(id,person_id,field_id,amount_minor,slip_date,reference,recorded_by,created_at,request_key,person_name) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      personId,
      selected.id,
      input.amountMinor,
      input.slipDate,
      input.reference?.trim() || null,
      actor,
      new Date().toISOString(),
      requestKey,
      personName || null,
    );
    audit(actor, "ADD_PAPER_SLIP", id, {
      amountMinor: input.amountMinor,
      fieldId: selected.id,
      personId,
      personName: personName || null,
    });
    return {
      id,
      amountMinor: input.amountMinor,
      fieldId: selected.id,
      personId,
      personName: personName || null,
    };
  }
  function addCollection(input, actor, requestKey) {
    amount(input.amountMinor);
    date(input.collectionDate);
    key(requestKey);
    if (!["PAYROLL", "CASH"].includes(input.method))
      throw appError("Collection method must be PAYROLL or CASH");
    return transactional(() => {
      const existing = db
        .prepare("SELECT id FROM paper_collections WHERE request_key=?")
        .get(requestKey);
      if (existing) return { id: existing.id, duplicate: true };
      const original = slip(input.slipId);
      if (original.recorded_by !== actor)
        throw appError("Paper slip not found", 404);
      if (field(original.field_id).kind === "CASH")
        throw appError("Cash slip is already collected");
      if (input.collectionDate < original.slip_date)
        throw appError("Collection date cannot precede the slip date");
      const paid = db
        .prepare(
          "SELECT COALESCE(SUM(amount_minor),0) amount FROM paper_collections WHERE slip_id=?",
        )
        .get(original.id).amount;
      if (input.amountMinor > original.amount_minor - paid)
        throw appError("Collection exceeds remaining slip balance");
      const id = randomUUID();
      db.prepare("INSERT INTO paper_collections VALUES(?,?,?,?,?,?,?,?,?)").run(
        id,
        original.id,
        input.amountMinor,
        input.method,
        input.collectionDate,
        input.reference?.trim() || null,
        actor,
        new Date().toISOString(),
        requestKey,
      );
      audit(actor, "ADD_PAPER_COLLECTION", id, {
        slipId: original.id,
        amountMinor: input.amountMinor,
        method: input.method,
      });
      return {
        id,
        remainingMinor: original.amount_minor - paid - input.amountMinor,
      };
    });
  }
  function report(from, to, owner) {
    // Sales and collections are period flows; outstanding is the balance as of
    // the selected end date, including slips from earlier weeks.
    if (from) date(from);
    if (to) date(to);
    if (from && to && from > to)
      throw appError("From date must be before to date");
    const fields = listFields().map((f) => ({
      id: f.id,
      name: f.name,
      kind: f.kind,
      salesMinor: 0,
      collectedMinor: 0,
      outstandingMinor: 0,
    }));
    const byId = new Map(fields.map((f) => [f.id, f]));
    const slips = db
      .prepare("SELECT id,field_id,amount_minor,slip_date FROM paper_slips WHERE recorded_by=?")
      .all(owner);
    const collections = db
      .prepare(
        "SELECT c.slip_id,c.amount_minor,c.method,c.collection_date,s.field_id FROM paper_collections c JOIN paper_slips s ON s.id=c.slip_id WHERE s.recorded_by=?",
      )
      .all(owner);
    const inRange = (day) => (!from || day >= from) && (!to || day <= to);
    for (const s of slips) {
      const f = byId.get(s.field_id);
      if (inRange(s.slip_date)) {
        f.salesMinor += s.amount_minor;
        // Cash slips are both sold and collected on their slip date.
        if (f.kind === "CASH") f.collectedMinor += s.amount_minor;
      }
      if (f.kind === "CREDIT" && (!to || s.slip_date <= to))
        f.outstandingMinor += s.amount_minor;
    }
    let payrollMinor = 0,
      cashMinor = 0;
    for (const c of collections) {
      const f = byId.get(c.field_id);
      if (inRange(c.collection_date)) {
        f.collectedMinor += c.amount_minor;
        if (c.method === "PAYROLL") payrollMinor += c.amount_minor;
        else cashMinor += c.amount_minor;
      }
      if (!to || c.collection_date <= to) f.outstandingMinor -= c.amount_minor;
    }
    const total = (name) => fields.reduce((sum, f) => sum + f[name], 0);
    return {
      from: from || null,
      to: to || null,
      salesMinor: total("salesMinor"),
      collectedMinor: total("collectedMinor"),
      outstandingMinor: total("outstandingMinor"),
      payrollMinor,
      cashMinor:
        cashMinor + fields.find((f) => f.kind === "CASH").collectedMinor,
      fields,
    };
  }
  return {
    listFields,
    addField,
    updateField,
    deleteField,
    listPeople,
    addPerson,
    updatePerson,
    deletePerson,
    listSlips,
    addSlip,
    addSlips,
    addCollection,
    report,
  };
}
