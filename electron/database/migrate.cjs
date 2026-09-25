const fs = require("node:fs");
const path = require("node:path");

const MIGRATION_FILE_PATTERN = /^(\d{3})_(.+)\.sql$/;

function ensureMigrationTable(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT NOT NULL
    )
  `);
}

function readMigrationFiles(migrationsDirectory) {
  const migrations = [];
  const versions = new Set();

  for (const fileName of fs.readdirSync(migrationsDirectory)) {
    if (!fileName.endsWith(".sql")) {
      continue;
    }

    const match = MIGRATION_FILE_PATTERN.exec(fileName);
    if (!match) {
      throw new Error(`Malformed migration filename: ${fileName}`);
    }

    const version = Number(match[1]);
    if (versions.has(version)) {
      throw new Error(`Duplicate migration version: ${match[1]}`);
    }

    versions.add(version);
    migrations.push({
      version,
      name: fileName,
      sql: fs.readFileSync(path.join(migrationsDirectory, fileName), "utf8"),
    });
  }

  return migrations.sort((left, right) => left.version - right.version);
}

function runMigrations(database, migrationsDirectory) {
  ensureMigrationTable(database);

  const appliedMigrations = new Map(
    database
      .prepare("SELECT version, name FROM schema_migrations")
      .all()
      .map((migration) => [migration.version, migration.name]),
  );

  for (const migration of readMigrationFiles(migrationsDirectory)) {
    const appliedName = appliedMigrations.get(migration.version);

    if (appliedName) {
      if (appliedName !== migration.name) {
        throw new Error(
          `Applied migration ${migration.version} has a different filename: ${appliedName}`,
        );
      }
      continue;
    }

    database.exec("BEGIN IMMEDIATE");

    try {
      database.exec(migration.sql);
      database
        .prepare(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
        )
        .run(migration.version, migration.name, new Date().toISOString());
      database.exec("COMMIT");
    } catch (error) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The migration transaction may not have started successfully.
      }
      throw error;
    }
  }
}

module.exports = { runMigrations };

