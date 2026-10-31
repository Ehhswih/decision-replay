import "server-only";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cache (
  key        TEXT PRIMARY KEY,
  source     TEXT NOT NULL,
  endpoint   TEXT NOT NULL,
  params     TEXT NOT NULL,
  payload    TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS call_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  source     TEXT NOT NULL,
  endpoint   TEXT NOT NULL,
  params     TEXT NOT NULL,
  status     TEXT NOT NULL,
  code       TEXT,
  message    TEXT,
  latency_ms INTEGER,
  from_cache INTEGER NOT NULL DEFAULT 0,
  at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trades (
  id          TEXT PRIMARY KEY,
  workspace   TEXT NOT NULL,
  row_no      INTEGER NOT NULL,
  ts          INTEGER NOT NULL,
  time_known  INTEGER NOT NULL,
  code        TEXT NOT NULL,
  name        TEXT,
  side        TEXT NOT NULL,
  price       REAL NOT NULL,
  qty         REAL NOT NULL,
  fee         REAL NOT NULL DEFAULT 0,
  reason      TEXT,
  plan_stop   REAL,
  plan_target REAL
);
CREATE INDEX IF NOT EXISTS trades_ws ON trades(workspace, code, ts);

CREATE TABLE IF NOT EXISTS evidence_sets (
  episode_id TEXT PRIMARY KEY,
  workspace  TEXT NOT NULL,
  json       TEXT NOT NULL,
  built_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS reviews (
  episode_id TEXT PRIMARY KEY,
  workspace  TEXT NOT NULL,
  status     TEXT NOT NULL,
  json       TEXT,
  error      TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS checklist (
  id                TEXT PRIMARY KEY,
  workspace         TEXT NOT NULL,
  text              TEXT NOT NULL,
  source_episode_id TEXT,
  source_lesson_id  TEXT,
  rule              TEXT,
  enabled           INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL
);

-- 揭晓前写下的判断：按访客保存，写下后不能修改
CREATE TABLE IF NOT EXISTS prejudgments (
  visitor      TEXT NOT NULL,
  workspace    TEXT NOT NULL,
  episode_id   TEXT NOT NULL,
  trade_id     TEXT NOT NULL,
  verdict      TEXT NOT NULL,
  worry        TEXT,
  after_reveal INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  PRIMARY KEY (visitor, workspace, trade_id)
);

-- 决策前检查存下的记录：补充理由时新增一个版本，原版本保留
CREATE TABLE IF NOT EXISTS decision_notes (
  id          TEXT PRIMARY KEY,
  root_id     TEXT NOT NULL,
  version     INTEGER NOT NULL,
  visitor     TEXT NOT NULL,
  code        TEXT NOT NULL,
  name        TEXT,
  side        TEXT NOT NULL,
  reason      TEXT NOT NULL,
  plan_stop   REAL,
  plan_target REAL,
  snapshot    TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS notes_visitor ON decision_notes(visitor, code, created_at);
`;

const globalForDb = globalThis as unknown as { __db?: DatabaseSync };

export function db(): DatabaseSync {
  if (!globalForDb.__db) {
    const dir = process.env.DATA_DIR ?? join(process.cwd(), "data");
    mkdirSync(dir, { recursive: true });
    const conn = new DatabaseSync(join(dir, "app.db"));
    conn.exec("PRAGMA journal_mode = WAL;");
    conn.exec(SCHEMA);
    // 迁移：导入时间（用于导入数据的保留期限）
    const cols = conn.prepare("PRAGMA table_info(trades)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "imported_at")) conn.exec("ALTER TABLE trades ADD COLUMN imported_at INTEGER");
    globalForDb.__db = conn;
  }
  return globalForDb.__db;
}
