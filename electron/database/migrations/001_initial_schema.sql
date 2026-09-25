CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE works (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'PAUSED', 'COMPLETED')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE episodes (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE RESTRICT,
  episode_number INTEGER NOT NULL CHECK (episode_number > 0),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('DRAFT', 'IN_PROGRESS', 'COMPLETED')),
  storage_key TEXT NOT NULL UNIQUE,
  content_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (work_id, episode_number)
);

CREATE TABLE worlds (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (work_id, name)
);

CREATE TABLE locations (
  id TEXT PRIMARY KEY,
  world_id TEXT NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (world_id, name),
  UNIQUE (id, world_id)
);

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (location_id, name)
);

CREATE TABLE characters (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  description TEXT,
  origin_world_id TEXT REFERENCES worlds(id) ON DELETE RESTRICT,
  origin_location_id TEXT REFERENCES locations(id) ON DELETE RESTRICT,
  current_location_id TEXT REFERENCES locations(id) ON DELETE RESTRICT,
  organization_id TEXT REFERENCES organizations(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (origin_location_id IS NULL OR origin_world_id IS NOT NULL),
  FOREIGN KEY (origin_location_id, origin_world_id)
    REFERENCES locations(id, world_id) ON DELETE RESTRICT
);

CREATE TABLE attributes (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (work_id, name)
);

CREATE TABLE character_attributes (
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  attribute_id TEXT NOT NULL REFERENCES attributes(id) ON DELETE RESTRICT,
  PRIMARY KEY (character_id, attribute_id)
);

CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (work_id, name)
);

CREATE TABLE character_skills (
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  PRIMARY KEY (character_id, skill_id)
);

CREATE TABLE authorities (
  id TEXT PRIMARY KEY,
  owner_character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  base_skill_id TEXT REFERENCES skills(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE servants (
  id TEXT PRIMARY KEY,
  owner_character_id TEXT NOT NULL UNIQUE REFERENCES characters(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE contracts (
  id TEXT PRIMARY KEY,
  grantor_character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  grantee_character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'ENDED')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (grantor_character_id <> grantee_character_id)
);

CREATE TABLE passives (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL REFERENCES works(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('COMMON', 'UNIQUE')),
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (work_id, name)
);

CREATE TABLE character_passives (
  character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  passive_id TEXT NOT NULL REFERENCES passives(id) ON DELETE RESTRICT,
  PRIMARY KEY (character_id, passive_id)
);

CREATE TABLE character_relationships (
  id TEXT PRIMARY KEY,
  from_character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  to_character_id TEXT NOT NULL REFERENCES characters(id) ON DELETE RESTRICT,
  relationship_type TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (from_character_id <> to_character_id)
);

CREATE UNIQUE INDEX contracts_one_active_direction
  ON contracts (grantor_character_id, grantee_character_id)
  WHERE status = 'ACTIVE';

CREATE INDEX characters_by_work_id ON characters (work_id);
CREATE INDEX authorities_by_owner_character_id ON authorities (owner_character_id);
CREATE INDEX authorities_by_base_skill_id ON authorities (base_skill_id);
CREATE INDEX contracts_by_grantor_character_id ON contracts (grantor_character_id);
CREATE INDEX contracts_by_grantee_character_id ON contracts (grantee_character_id);
CREATE INDEX character_relationships_by_from_character_id
  ON character_relationships (from_character_id);
CREATE INDEX character_relationships_by_to_character_id
  ON character_relationships (to_character_id);

CREATE TRIGGER character_passives_unique_insert
BEFORE INSERT ON character_passives
WHEN (SELECT type FROM passives WHERE id = NEW.passive_id) = 'UNIQUE'
  AND EXISTS (
    SELECT 1
    FROM character_passives
    WHERE passive_id = NEW.passive_id
      AND character_id <> NEW.character_id
  )
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE passive is already assigned to another character');
END;

CREATE TRIGGER character_passives_unique_update
BEFORE UPDATE OF character_id, passive_id ON character_passives
WHEN (SELECT type FROM passives WHERE id = NEW.passive_id) = 'UNIQUE'
  AND EXISTS (
    SELECT 1
    FROM character_passives
    WHERE passive_id = NEW.passive_id
      AND character_id <> NEW.character_id
  )
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE passive is already assigned to another character');
END;

CREATE TRIGGER passives_prevent_duplicate_unique_type
BEFORE UPDATE OF type ON passives
WHEN NEW.type = 'UNIQUE'
  AND (
    SELECT COUNT(*)
    FROM character_passives
    WHERE passive_id = NEW.id
  ) > 1
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE passive cannot have multiple owners');
END;

