CREATE TABLE calendar_names (
  title_key TEXT NOT NULL CHECK (length(title_key) > 0),
  student_id INTEGER NOT NULL REFERENCES students(id),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (title_key, student_id)
);
CREATE INDEX calendar_names_student_id ON calendar_names(student_id);

CREATE TABLE ignored_titles (
  title_key TEXT NOT NULL PRIMARY KEY CHECK (length(title_key) > 0),
  title TEXT NOT NULL CHECK (length(trim(title)) > 0),
  created_at TEXT NOT NULL
);
