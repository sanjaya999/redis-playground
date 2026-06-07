import { Database } from "bun:sqlite";

const db = new Database("app.db");

db.run(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT,
    email TEXT
  )
`);

db.run(`INSERT OR IGNORE INTO users VALUES ('42', 'Sanjaya', 'sanjaya@example.com')`);
db.run(`INSERT OR IGNORE INTO users VALUES ('7', 'Alice', 'alice@example.com')`);
db.run(`INSERT OR IGNORE INTO users VALUES ('99', 'Bob', 'bob@example.com')`);

export default db;