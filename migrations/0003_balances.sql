ALTER TABLE payments ADD COLUMN lessons INTEGER NOT NULL DEFAULT 0 CHECK (typeof(lessons) = 'integer' AND lessons >= 0);
ALTER TABLE payments ADD COLUMN product_name TEXT;

CREATE TABLE adjustments (
  id INTEGER PRIMARY KEY,
  student_id INTEGER NOT NULL REFERENCES students(id),
  delta INTEGER NOT NULL CHECK (typeof(delta) = 'integer' AND delta <> 0),
  reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
  payment_id INTEGER REFERENCES payments(id),
  created_at TEXT NOT NULL
);
CREATE INDEX adjustments_student_id ON adjustments(student_id);
CREATE INDEX adjustments_payment_id ON adjustments(payment_id);
