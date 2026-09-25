const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { getDatabaseFilePath } = require("../storage/storage-paths.cjs");
const { runMigrations } = require("./migrate.cjs");

const migrationsDirectory = path.join(__dirname, "migrations");
let database;

function initializeDatabase(databasePath = getDatabaseFilePath()) {
  if (database) {
    return database;
  }

  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const connection = new DatabaseSync(databasePath);

  try {
    connection.exec("PRAGMA foreign_keys = ON");
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

