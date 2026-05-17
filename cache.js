const Database = require('better-sqlite3');
const path     = require('path');
const fs       = require('fs');

// ── Setup ─────────────────────────────────────────────────────────────────────
const DB_PATH = path.join(__dirname, 'data', 'cache.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // safe concurrent reads

// ── Schema ────────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS refusal_orders (
    order_id      TEXT PRIMARY KEY,
    order_number  TEXT NOT NULL,
    phone         TEXT,
    address       TEXT,
    email         TEXT,
    cached_at     INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cache_meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_phone   ON refusal_orders(phone);
  CREATE INDEX IF NOT EXISTS idx_address ON refusal_orders(address);
`);

// ── Prepared statements ───────────────────────────────────────────────────────
const stmts = {
  upsert: db.prepare(`
    INSERT INTO refusal_orders (order_id, order_number, phone, address, email, cached_at)
    VALUES (@order_id, @order_number, @phone, @address, @email, @cached_at)
    ON CONFLICT(order_id) DO UPDATE SET
      order_number = excluded.order_number,
      phone        = excluded.phone,
      address      = excluded.address,
      email        = excluded.email,
      cached_at    = excluded.cached_at
  `),
  deleteOrder:  db.prepare(`DELETE FROM refusal_orders WHERE order_id = ?`),
  getAll:       db.prepare(`SELECT * FROM refusal_orders`),
  count:        db.prepare(`SELECT COUNT(*) as n FROM refusal_orders`),
  getMeta:      db.prepare(`SELECT value FROM cache_meta WHERE key = ?`),
  setMeta:      db.prepare(`INSERT INTO cache_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`),
};

// ── Public API ────────────────────────────────────────────────────────────────

/** Replace the entire cache with a fresh list of refusal orders */
function replaceAll(orders) {
  const now = Date.now();
  const run = db.transaction(() => {
    db.prepare(`DELETE FROM refusal_orders`).run();
    for (const o of orders) {
      stmts.upsert.run({
        order_id:     String(o.id),
        order_number: String(o.order_number),
        phone:        o.phone   || null,
        address:      o.address || null,
        email:        o.email   || null,
        cached_at:    now,
      });
    }
    stmts.setMeta.run('last_full_refresh', String(now));
  });
  run();
  console.log(`   💾 Cache refreshed — ${orders.length} refusal orders stored`);
}

/** Add or update a single order in the cache */
function upsertOrder(order) {
  stmts.upsert.run({
    order_id:     String(order.id),
    order_number: String(order.order_number),
    phone:        order.phone   || null,
    address:      order.address || null,
    email:        order.email   || null,
    cached_at:    Date.now(),
  });
}

/** Remove a single order from the cache (e.g. Refusal tag was removed) */
function removeOrder(orderId) {
  stmts.deleteOrder.run(String(orderId));
}

/** Return all cached refusal orders */
function getAll() {
  return stmts.getAll.all();
}

/** Return cache stats */
function stats() {
  const count       = stmts.count.get().n;
  const lastRefresh = stmts.getMeta.get('last_full_refresh');
  return {
    count,
    lastFullRefresh: lastRefresh ? new Date(Number(lastRefresh.value)).toISOString() : 'never',
    dbPath: DB_PATH,
  };
}

module.exports = { replaceAll, upsertOrder, removeOrder, getAll, stats };
