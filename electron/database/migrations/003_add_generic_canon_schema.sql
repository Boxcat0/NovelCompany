CREATE TABLE canon_sets (
  id TEXT PRIMARY KEY,
  canon_space_id TEXT NOT NULL REFERENCES canon_spaces(id) ON DELETE RESTRICT,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  record_name_label TEXT NOT NULL,
  description TEXT,
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (canon_space_id, key),
  UNIQUE (canon_space_id, id)
);

CREATE TABLE canon_fields (
  id TEXT PRIMARY KEY,
  canon_space_id TEXT NOT NULL,
  canon_set_id TEXT NOT NULL,
  key TEXT NOT NULL,
  label TEXT NOT NULL,
  value_type TEXT NOT NULL CHECK (value_type IN ('TEXT', 'LONG_TEXT', 'NUMBER', 'BOOLEAN', 'OPTION_ONE', 'OPTION_MANY', 'REFERENCE_ONE', 'REFERENCE_MANY')),
  input_control TEXT NOT NULL CHECK (input_control IN ('TEXT_INPUT', 'TEXTAREA', 'NUMBER_INPUT', 'CHECKBOX', 'COMBOBOX', 'CHECKBOX_GROUP', 'MULTI_SELECT')),
  reference_set_id TEXT,
  required INTEGER NOT NULL CHECK (required IN (0, 1)),
  help_text TEXT,
  sort_order INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (value_type = 'TEXT' AND input_control = 'TEXT_INPUT') OR
    (value_type = 'LONG_TEXT' AND input_control = 'TEXTAREA') OR
    (value_type = 'NUMBER' AND input_control = 'NUMBER_INPUT') OR
    (value_type = 'BOOLEAN' AND input_control = 'CHECKBOX') OR
    (value_type = 'OPTION_ONE' AND input_control = 'COMBOBOX') OR
    (value_type IN ('OPTION_MANY', 'REFERENCE_MANY') AND input_control IN ('CHECKBOX_GROUP', 'MULTI_SELECT')) OR
    (value_type = 'REFERENCE_ONE' AND input_control = 'COMBOBOX')
  ),
  CHECK (
    (value_type IN ('REFERENCE_ONE', 'REFERENCE_MANY') AND reference_set_id IS NOT NULL) OR
    (value_type NOT IN ('REFERENCE_ONE', 'REFERENCE_MANY') AND reference_set_id IS NULL)
  ),
  UNIQUE (canon_set_id, key),
  UNIQUE (canon_space_id, id),
  UNIQUE (canon_space_id, id, canon_set_id),
  UNIQUE (canon_space_id, id, reference_set_id),
  FOREIGN KEY (canon_space_id, canon_set_id) REFERENCES canon_sets(canon_space_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (canon_space_id, reference_set_id) REFERENCES canon_sets(canon_space_id, id) ON DELETE RESTRICT
);

CREATE TABLE canon_field_options (
  id TEXT PRIMARY KEY,
  canon_space_id TEXT NOT NULL,
  canon_set_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  value TEXT NOT NULL,
  label TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  UNIQUE (field_id, value),
  UNIQUE (canon_space_id, id),
  UNIQUE (canon_space_id, id, field_id),
  FOREIGN KEY (canon_space_id, field_id, canon_set_id) REFERENCES canon_fields(canon_space_id, id, canon_set_id) ON DELETE RESTRICT
);

CREATE TABLE canon_records (
  id TEXT PRIMARY KEY,
  canon_space_id TEXT NOT NULL,
  canon_set_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (canon_space_id, id),
  UNIQUE (canon_space_id, id, canon_set_id),
  FOREIGN KEY (canon_space_id, canon_set_id) REFERENCES canon_sets(canon_space_id, id) ON DELETE RESTRICT
);

CREATE TABLE canon_field_values (
  canon_space_id TEXT NOT NULL,
  canon_set_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  text_value TEXT,
  number_value REAL,
  boolean_value INTEGER CHECK (boolean_value IN (0, 1)),
  PRIMARY KEY (record_id, field_id),
  CHECK ((text_value IS NOT NULL) + (number_value IS NOT NULL) + (boolean_value IS NOT NULL) = 1),
  FOREIGN KEY (canon_space_id, record_id, canon_set_id) REFERENCES canon_records(canon_space_id, id, canon_set_id) ON DELETE RESTRICT,
  FOREIGN KEY (canon_space_id, field_id, canon_set_id) REFERENCES canon_fields(canon_space_id, id, canon_set_id) ON DELETE RESTRICT
);

CREATE TABLE canon_record_option_values (
  canon_space_id TEXT NOT NULL,
  canon_set_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  option_id TEXT NOT NULL,
  PRIMARY KEY (record_id, field_id, option_id),
  FOREIGN KEY (canon_space_id, record_id, canon_set_id) REFERENCES canon_records(canon_space_id, id, canon_set_id) ON DELETE RESTRICT,
  FOREIGN KEY (canon_space_id, field_id, canon_set_id) REFERENCES canon_fields(canon_space_id, id, canon_set_id) ON DELETE RESTRICT,
  FOREIGN KEY (canon_space_id, option_id, field_id) REFERENCES canon_field_options(canon_space_id, id, field_id) ON DELETE RESTRICT
);

CREATE TABLE canon_record_references (
  canon_space_id TEXT NOT NULL,
  canon_set_id TEXT NOT NULL,
  record_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  target_set_id TEXT NOT NULL,
  target_record_id TEXT NOT NULL,
  PRIMARY KEY (record_id, field_id, target_record_id),
  FOREIGN KEY (canon_space_id, record_id, canon_set_id) REFERENCES canon_records(canon_space_id, id, canon_set_id) ON DELETE RESTRICT,
  FOREIGN KEY (canon_space_id, field_id, canon_set_id) REFERENCES canon_fields(canon_space_id, id, canon_set_id) ON DELETE RESTRICT,
  FOREIGN KEY (canon_space_id, field_id, target_set_id) REFERENCES canon_fields(canon_space_id, id, reference_set_id) ON DELETE RESTRICT,
  FOREIGN KEY (canon_space_id, target_record_id, target_set_id) REFERENCES canon_records(canon_space_id, id, canon_set_id) ON DELETE RESTRICT
);

CREATE TRIGGER canon_option_one_limit
BEFORE INSERT ON canon_record_option_values
WHEN (SELECT value_type FROM canon_fields WHERE id = NEW.field_id) = 'OPTION_ONE'
  AND EXISTS (SELECT 1 FROM canon_record_option_values WHERE record_id = NEW.record_id AND field_id = NEW.field_id)
BEGIN
  SELECT RAISE(ABORT, 'OPTION_ONE field accepts one option');
END;

CREATE TRIGGER canon_reference_one_limit
BEFORE INSERT ON canon_record_references
WHEN (SELECT value_type FROM canon_fields WHERE id = NEW.field_id) = 'REFERENCE_ONE'
  AND EXISTS (SELECT 1 FROM canon_record_references WHERE record_id = NEW.record_id AND field_id = NEW.field_id)
BEGIN
  SELECT RAISE(ABORT, 'REFERENCE_ONE field accepts one target');
END;

CREATE INDEX canon_sets_by_canon_space_id ON canon_sets (canon_space_id, sort_order);
CREATE INDEX canon_fields_by_canon_set_id ON canon_fields (canon_set_id, sort_order);
CREATE INDEX canon_records_by_canon_set_id ON canon_records (canon_set_id, display_name);
