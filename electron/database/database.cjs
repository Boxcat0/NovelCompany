const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { getDatabaseFilePath } = require("../storage/storage-paths.cjs");
const { runMigrations } = require("./migrate.cjs");

const migrationsDirectory = path.join(__dirname, "migrations");
let database;

/** 연결을 열고 기존 DB의 Definition refinement(004/005) 전에 SQLite 백업을 보관한다. */
function initializeDatabase(databasePath = getDatabaseFilePath()) {
  if (database) {
    return database;
  }

  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const connection = new DatabaseSync(databasePath);

  try {
    connection.exec("PRAGMA foreign_keys = ON");
    const hasMigrations = connection.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
    const needsTask017 = hasMigrations && connection.prepare("SELECT 1 FROM schema_migrations WHERE version = 3").get() && !connection.prepare("SELECT 1 FROM schema_migrations WHERE version = 4").get();
    const needsTask022 = hasMigrations && connection.prepare("SELECT 1 FROM schema_migrations WHERE version = 3").get() && !connection.prepare("SELECT 1 FROM schema_migrations WHERE version = 5").get();
    const needsTask024 = hasMigrations && connection.prepare("SELECT 1 FROM schema_migrations WHERE version = 5").get() && !connection.prepare("SELECT 1 FROM schema_migrations WHERE version = 6").get();
    if (needsTask017 || needsTask022 || needsTask024) {
      const backupDirectory = path.join(path.dirname(databasePath), "backups");
      fs.mkdirSync(backupDirectory, { recursive: true });
      const backupPrefix = needsTask017 ? "before-task017-" : needsTask022 ? "before-task022-" : "before-task024-";
      const backupPath = path.join(backupDirectory, backupPrefix + require("node:crypto").randomUUID() + ".db");
      connection.exec("VACUUM INTO '" + backupPath.replace(/'/g, "''") + "'");
    }
    runMigrations(connection, migrationsDirectory);
    database = connection;
    return database;
  } catch (error) {
    connection.close();
    throw error;
  }
}

function getDatabase() {
  if (!database) {
    throw new Error("Database has not been initialized.");
  }

  return database;
}

function closeDatabase() {
  if (database) {
    database.close();
    database = undefined;
  }
}

module.exports = { closeDatabase, getDatabase, initializeDatabase };

