import path from "node:path";
import fs from "node:fs";
import Database from "better-sqlite3";

const DATA_DIR = path.resolve(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "lab.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shopify_id TEXT UNIQUE,
  title TEXT NOT NULL,
  price REAL,
  image_url TEXT,
  url TEXT,
  component_id TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  started_at REAL NOT NULL,
  ended_at REAL,
  experiment_id TEXT,
  place_version INTEGER,
  source TEXT NOT NULL DEFAULT 'live'
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  ts REAL NOT NULL,
  type TEXT NOT NULL,
  surface TEXT,
  component_id TEXT,
  product_id TEXT,
  x REAL, y REAL, z REAL,
  lx REAL, ly REAL, lz REAL,
  meta_json TEXT,
  experiment_id TEXT,
  source TEXT NOT NULL DEFAULT 'live'
);

CREATE INDEX IF NOT EXISTS idx_events_exp_comp_type ON events(experiment_id, component_id, type);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);

CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  name TEXT,
  hypothesis TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at REAL NOT NULL,
  snapshot_before_json TEXT,
  plan_json TEXT,
  result_json TEXT,
  image_before TEXT,
  image_after TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shopify_order_id TEXT UNIQUE,
  session_id TEXT,
  product_id TEXT,
  total REAL,
  created_at REAL,
  discount_code TEXT,
  source TEXT NOT NULL DEFAULT 'live'
);

CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS claim_codes (
  code TEXT PRIMARY KEY,
  session_id TEXT,
  product_id TEXT,
  created_at REAL
);
`;

let instance: Database.Database | null = null;

export function db(): Database.Database {
  if (instance) return instance;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const handle = new Database(DB_PATH);
  handle.pragma("journal_mode = WAL");
  handle.exec(SCHEMA);
  instance = handle;
  return handle;
}
