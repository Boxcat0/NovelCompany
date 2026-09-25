CREATE TEMP TABLE canon_space_migration_guard (
  is_safe INTEGER NOT NULL CHECK (is_safe = 1)
);

INSERT INTO canon_space_migration_guard (is_safe)
SELECT CASE WHEN EXISTS (
  SELECT 1 FROM worlds
  UNION ALL SELECT 1 FROM locations
  UNION ALL SELECT 1 FROM organizations
  UNION ALL SELECT 1 FROM characters
  UNION ALL SELECT 1 FROM attributes
  UNION ALL SELECT 1 FROM character_attributes
  UNION ALL SELECT 1 FROM skills
  UNION ALL SELECT 1 FROM character_skills
  UNION ALL SELECT 1 FROM authorities
  UNION ALL SELECT 1 FROM servants
  UNION ALL SELECT 1 FROM contracts
  UNION ALL SELECT 1 FROM passives
  UNION ALL SELECT 1 FROM character_passives
  UNION ALL SELECT 1 FROM character_relationships
) THEN 0 ELSE 1 END;

DROP TABLE character_attributes;
DROP TABLE character_skills;
DROP TABLE character_passives;
DROP TABLE character_relationships;
DROP TABLE contracts;
DROP TABLE servants;
DROP TABLE authorities;
DROP TABLE characters;
DROP TABLE organizations;
DROP TABLE locations;
DROP TABLE worlds;
DROP TABLE attributes;
DROP TABLE skills;
DROP TABLE passives;

CREATE TABLE canon_spaces (
  id TEXT PRIMARY KEY,
  work_id TEXT NOT NULL UNIQUE REFERENCES works(id) ON DELETE RESTRICT,
  template_key TEXT NOT NULL CHECK (template_key = 'MODERN_FANTASY_V1'),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE worlds (
  id TEXT PRIMARY KEY,
  canon_space_id TEXT NOT NULL REFERENCES canon_spaces(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (canon_space_id, name),
  UNIQUE (canon_space_id, id)
);

CREATE TABLE locations (
  id TEXT PRIMARY KEY,
  canon_space_id TEXT NOT NULL REFERENCES canon_spaces(id) ON DELETE RESTRICT,
  world_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (canon_space_id, world_id, name),
  UNIQUE (canon_space_id, id),
  UNIQUE (canon_space_id, id, world_id),
  FOREIGN KEY (canon_space_id, world_id)
    REFERENCES worlds(canon_space_id, id) ON DELETE RESTRICT
);

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  canon_space_id TEXT NOT NULL REFERENCES canon_spaces(id) ON DELETE RESTRICT,
  location_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (canon_space_id, location_id, name),
  UNIQUE (canon_space_id, id),
  FOREIGN KEY (canon_space_id, location_id)
    REFERENCES locations(canon_space_id, id) ON DELETE RESTRICT
);

CREATE TABLE characters (
  id TEXT PRIMARY KEY,
  canon_space_id TEXT NOT NULL REFERENCES canon_spaces(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  description TEXT,
  origin_world_id TEXT,
  origin_location_id TEXT,
  current_location_id TEXT,
  organization_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (origin_location_id IS NULL OR origin_world_id IS NOT NULL),
  UNIQUE (canon_space_id, name),
  UNIQUE (canon_space_id, id),
  FOREIGN KEY (canon_space_id, origin_world_id)
    REFERENCES worlds(canon_space_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (canon_space_id, origin_location_id)
    REFERENCES locations(canon_space_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (canon_space_id, origin_location_id, origin_world_id)
    REFERENCES locations(canon_space_id, id, world_id) ON DELETE RESTRICT,
  FOREIGN KEY (canon_space_id, current_location_id)
    REFERENCES locations(canon_space_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (canon_space_id, organization_id)
    REFERENCES organizations(canon_space_id, id) ON DELETE RESTRICT
);

CREATE TABLE attributes (
  id TEXT PRIMARY KEY,
  canon_space_id TEXT NOT NULL REFERENCES canon_spaces(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (canon_space_id, name),
  UNIQUE (canon_space_id, id)
);

CREATE TABLE character_attributes (
  canon_space_id TEXT NOT NULL REFERENCES canon_spaces(id) ON DELETE RESTRICT,
  character_id TEXT NOT NULL,
  attribute_id TEXT NOT NULL,
  PRIMARY KEY (canon_space_id, character_id, attribute_id),
  FOREIGN KEY (canon_space_id, character_id)
    REFERENCES characters(canon_space_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (canon_space_id, attribute_id)
    REFERENCES attributes(canon_space_id, id) ON DELETE RESTRICT
);

CREATE TABLE skills (
  id TEXT PRIMARY KEY,
  canon_space_id TEXT NOT NULL REFERENCES canon_spaces(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (canon_space_id, name),
  UNIQUE (canon_space_id, id)
);

CREATE TABLE character_skills (
  canon_space_id TEXT NOT NULL REFERENCES canon_spaces(id) ON DELETE RESTRICT,
  character_id TEXT NOT NULL,
  skill_id TEXT NOT NULL,
  PRIMARY KEY (canon_space_id, character_id, skill_id),
  FOREIGN KEY (canon_space_id, character_id)
    REFERENCES characters(canon_space_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (canon_space_id, skill_id)
    REFERENCES skills(canon_space_id, id) ON DELETE RESTRICT
);

CREATE TABLE authorities (
  id TEXT PRIMARY KEY,
  canon_space_id TEXT NOT NULL REFERENCES canon_spaces(id) ON DELETE RESTRICT,
  owner_character_id TEXT NOT NULL,
  base_skill_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (canon_space_id, id),
  FOREIGN KEY (canon_space_id, owner_character_id)
    REFERENCES characters(canon_space_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (canon_space_id, base_skill_id)
    REFERENCES skills(canon_space_id, id) ON DELETE RESTRICT
);

CREATE TABLE servants (
  id TEXT PRIMARY KEY,
  canon_space_id TEXT NOT NULL REFERENCES canon_spaces(id) ON DELETE RESTRICT,
  owner_character_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (canon_space_id, id),
  FOREIGN KEY (canon_space_id, owner_character_id)
    REFERENCES characters(canon_space_id, id) ON DELETE RESTRICT
);

CREATE TABLE contracts (
  id TEXT PRIMARY KEY,
  canon_space_id TEXT NOT NULL REFERENCES canon_spaces(id) ON DELETE RESTRICT,
  grantor_character_id TEXT NOT NULL,
  grantee_character_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'ENDED')),
  started_at TEXT NOT NULL,
  ended_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (grantor_character_id <> grantee_character_id),
  UNIQUE (canon_space_id, id),
  FOREIGN KEY (canon_space_id, grantor_character_id)
    REFERENCES characters(canon_space_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (canon_space_id, grantee_character_id)
    REFERENCES characters(canon_space_id, id) ON DELETE RESTRICT
);

CREATE TABLE passives (
  id TEXT PRIMARY KEY,
  canon_space_id TEXT NOT NULL REFERENCES canon_spaces(id) ON DELETE RESTRICT,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('COMMON', 'UNIQUE')),
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (canon_space_id, name),
  UNIQUE (canon_space_id, id)
);

CREATE TABLE character_passives (
  canon_space_id TEXT NOT NULL REFERENCES canon_spaces(id) ON DELETE RESTRICT,
  character_id TEXT NOT NULL,
  passive_id TEXT NOT NULL,
  PRIMARY KEY (canon_space_id, character_id, passive_id),
  FOREIGN KEY (canon_space_id, character_id)
    REFERENCES characters(canon_space_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (canon_space_id, passive_id)
    REFERENCES passives(canon_space_id, id) ON DELETE RESTRICT
);

CREATE TABLE character_relationships (
  id TEXT PRIMARY KEY,
  canon_space_id TEXT NOT NULL REFERENCES canon_spaces(id) ON DELETE RESTRICT,
  from_character_id TEXT NOT NULL,
  to_character_id TEXT NOT NULL,
  relationship_type TEXT NOT NULL,
  description TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (from_character_id <> to_character_id),
  UNIQUE (canon_space_id, id),
  FOREIGN KEY (canon_space_id, from_character_id)
    REFERENCES characters(canon_space_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (canon_space_id, to_character_id)
    REFERENCES characters(canon_space_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX contracts_one_active_direction
  ON contracts (canon_space_id, grantor_character_id, grantee_character_id)
  WHERE status = 'ACTIVE';

CREATE INDEX worlds_by_canon_space_id ON worlds (canon_space_id);
CREATE INDEX locations_by_canon_space_id_and_world_id
  ON locations (canon_space_id, world_id);
CREATE INDEX organizations_by_canon_space_id_and_location_id
  ON organizations (canon_space_id, location_id);
CREATE INDEX characters_by_canon_space_id ON characters (canon_space_id);
CREATE INDEX authorities_by_canon_space_id_and_owner_character_id
  ON authorities (canon_space_id, owner_character_id);
CREATE INDEX authorities_by_canon_space_id_and_base_skill_id
  ON authorities (canon_space_id, base_skill_id);
CREATE INDEX contracts_by_canon_space_id_and_grantor_character_id
  ON contracts (canon_space_id, grantor_character_id);
CREATE INDEX contracts_by_canon_space_id_and_grantee_character_id
  ON contracts (canon_space_id, grantee_character_id);
CREATE INDEX character_relationships_by_canon_space_id_and_from_character_id
  ON character_relationships (canon_space_id, from_character_id);
CREATE INDEX character_relationships_by_canon_space_id_and_to_character_id
  ON character_relationships (canon_space_id, to_character_id);

CREATE TRIGGER character_passives_unique_insert
BEFORE INSERT ON character_passives
WHEN (
  SELECT type
  FROM passives
  WHERE id = NEW.passive_id
    AND canon_space_id = NEW.canon_space_id
) = 'UNIQUE'
  AND EXISTS (
    SELECT 1
    FROM character_passives
    WHERE canon_space_id = NEW.canon_space_id
      AND passive_id = NEW.passive_id
      AND character_id <> NEW.character_id
  )
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE passive is already assigned to another character');
END;

CREATE TRIGGER character_passives_unique_update
BEFORE UPDATE OF canon_space_id, character_id, passive_id ON character_passives
WHEN (
  SELECT type
  FROM passives
  WHERE id = NEW.passive_id
    AND canon_space_id = NEW.canon_space_id
) = 'UNIQUE'
  AND EXISTS (
    SELECT 1
    FROM character_passives
    WHERE canon_space_id = NEW.canon_space_id
      AND passive_id = NEW.passive_id
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
    WHERE canon_space_id = NEW.canon_space_id
      AND passive_id = NEW.id
  ) > 1
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE passive cannot have multiple owners');
END;

DROP TABLE canon_space_migration_guard;
