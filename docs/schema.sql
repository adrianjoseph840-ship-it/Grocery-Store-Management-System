-- PostgreSQL reference schema. Adapt naming to the selected ORM migration format.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TYPE user_status AS ENUM ('ACTIVE', 'SUSPENDED', 'ARCHIVED');
CREATE TYPE sale_status AS ENUM ('POSTED', 'VOIDED', 'REFUNDED');
CREATE TYPE tender_type AS ENUM ('CASH', 'DEBT', 'PREPAID');
CREATE TYPE ledger_entry_type AS ENUM
  ('CHARGE', 'PAYMENT', 'OPENING_BALANCE', 'ADJUSTMENT', 'REVERSAL');
CREATE TYPE posting_status AS ENUM ('PENDING', 'POSTED', 'REJECTED', 'REVERSED');
CREATE TYPE drawer_status AS ENUM ('OPEN', 'CLOSED', 'REVIEWED');

CREATE TABLE sections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE buyer_tiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  credit_allowed boolean NOT NULL DEFAULT false,
  default_credit_limit_minor bigint NOT NULL DEFAULT 0 CHECK (default_credit_limit_minor >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_code text UNIQUE,
  email text UNIQUE,
  password_hash text NOT NULL,
  display_name text NOT NULL,
  status user_status NOT NULL DEFAULT 'ACTIVE',
  section_id uuid REFERENCES sections(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL
);

CREATE TABLE user_roles (
  user_id uuid NOT NULL REFERENCES users(id),
  role_id uuid NOT NULL REFERENCES roles(id),
  granted_by uuid REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE buyer_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES users(id),
  tier_id uuid NOT NULL REFERENCES buyer_tiers(id),
  public_code text NOT NULL UNIQUE,
  credit_limit_minor bigint CHECK (credit_limit_minor IS NULL OR credit_limit_minor >= 0),
  debt_restricted boolean NOT NULL DEFAULT false,
  restriction_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE menu_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  sort_order integer NOT NULL DEFAULT 0
);

CREATE TABLE menu_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku text NOT NULL UNIQUE,
  category_id uuid REFERENCES menu_categories(id),
  name text NOT NULL,
  current_price_minor bigint NOT NULL CHECK (current_price_minor >= 0),
  is_available boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE drawer_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cashier_id uuid NOT NULL REFERENCES users(id),
  status drawer_status NOT NULL DEFAULT 'OPEN',
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  opening_float_minor bigint NOT NULL CHECK (opening_float_minor >= 0),
  expected_cash_minor bigint,
  counted_cash_minor bigint,
  variance_minor bigint,
  reviewed_by uuid REFERENCES users(id),
  CHECK ((status = 'OPEN' AND closed_at IS NULL) OR status <> 'OPEN')
);

CREATE UNIQUE INDEX one_open_drawer_per_cashier
  ON drawer_sessions(cashier_id) WHERE status = 'OPEN';

CREATE TABLE sales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_number text NOT NULL UNIQUE,
  buyer_account_id uuid REFERENCES buyer_accounts(id),
  buyer_section_id_snapshot uuid REFERENCES sections(id),
  cashier_id uuid NOT NULL REFERENCES users(id),
  drawer_session_id uuid NOT NULL REFERENCES drawer_sessions(id),
  status sale_status NOT NULL DEFAULT 'POSTED',
  subtotal_minor bigint NOT NULL CHECK (subtotal_minor >= 0),
  discount_minor bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  total_minor bigint NOT NULL CHECK (total_minor >= 0),
  currency char(3) NOT NULL DEFAULT 'PHP',
  posted_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key text NOT NULL UNIQUE,
  CHECK (total_minor = subtotal_minor - discount_minor)
);

CREATE TABLE sale_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL REFERENCES sales(id),
  menu_item_id uuid NOT NULL REFERENCES menu_items(id),
  item_name_snapshot text NOT NULL,
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  quantity numeric(12,3) NOT NULL CHECK (quantity > 0),
  line_total_minor bigint NOT NULL CHECK (line_total_minor >= 0)
);

CREATE TABLE sale_tenders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id uuid NOT NULL REFERENCES sales(id),
  type tender_type NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  reference text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE debt_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_account_id uuid NOT NULL REFERENCES buyer_accounts(id),
  type ledger_entry_type NOT NULL,
  status posting_status NOT NULL DEFAULT 'PENDING',
  -- Positive increases amount due; negative decreases it.
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0),
  sale_id uuid REFERENCES sales(id),
  reverses_entry_id uuid UNIQUE REFERENCES debt_ledger_entries(id),
  source text NOT NULL,
  source_reference text,
  effective_at timestamptz NOT NULL DEFAULT now(),
  posted_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  approved_by uuid REFERENCES users(id),
  notes text,
  idempotency_key text NOT NULL UNIQUE,
  CHECK ((status = 'POSTED' AND posted_at IS NOT NULL) OR status <> 'POSTED')
);

CREATE INDEX debt_ledger_buyer_posted_idx
  ON debt_ledger_entries(buyer_account_id, effective_at)
  WHERE status = 'POSTED';

CREATE TABLE debt_payment_allocations (
  payment_entry_id uuid NOT NULL REFERENCES debt_ledger_entries(id),
  charge_entry_id uuid NOT NULL REFERENCES debt_ledger_entries(id),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  PRIMARY KEY (payment_entry_id, charge_entry_id),
  CHECK (payment_entry_id <> charge_entry_id)
);

CREATE TABLE drawer_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drawer_session_id uuid NOT NULL REFERENCES drawer_sessions(id),
  movement_type text NOT NULL,
  -- Positive adds physical cash; negative removes it.
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0),
  sale_id uuid REFERENCES sales(id),
  ledger_entry_id uuid REFERENCES debt_ledger_entries(id),
  reference text,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  recorded_by uuid NOT NULL REFERENCES users(id),
  idempotency_key text NOT NULL UNIQUE
);

CREATE TABLE prepaid_ledger_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  buyer_account_id uuid NOT NULL REFERENCES buyer_accounts(id),
  -- Positive adds prepaid value; negative spends it.
  amount_minor bigint NOT NULL CHECK (amount_minor <> 0),
  status posting_status NOT NULL DEFAULT 'POSTED',
  source text NOT NULL,
  reference text,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  idempotency_key text NOT NULL UNIQUE
);

CREATE TABLE approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  action text NOT NULL,
  status posting_status NOT NULL DEFAULT 'PENDING',
  requested_by uuid NOT NULL REFERENCES users(id),
  decided_by uuid REFERENCES users(id),
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  reason text
);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid REFERENCES users(id),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id uuid,
  request_id text,
  ip_address inet,
  before_data jsonb,
  after_data jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX audit_entity_idx ON audit_events(entity_type, entity_id, occurred_at);

-- Balance query; materialize/cache only when scale requires it.
CREATE VIEW buyer_debt_balances AS
SELECT buyer_account_id, COALESCE(sum(amount_minor), 0)::bigint AS balance_minor
FROM debt_ledger_entries
WHERE status = 'POSTED'
GROUP BY buyer_account_id;

