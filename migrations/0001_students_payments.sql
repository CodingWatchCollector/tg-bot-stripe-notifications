CREATE TABLE students (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  name_key TEXT NOT NULL UNIQUE,
  telegram_username TEXT,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE TABLE payer_emails (
  email TEXT PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id)
);

CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  checkout_session_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('unassigned', 'assigned', 'dismissed')),
  student_id INTEGER REFERENCES students(id),
  amount_minor INTEGER,
  currency TEXT,
  customer_name TEXT,
  customer_email TEXT,
  payment_intent_id TEXT,
  payment_link_id TEXT,
  livemode INTEGER NOT NULL CHECK (livemode IN (0, 1)),
  message_id INTEGER,
  notified_at TEXT,
  created_at TEXT NOT NULL,
  CHECK ((status = 'assigned') = (student_id IS NOT NULL))
);
