const rawDb = require('../db');
const db = rawDb.promise ? rawDb.promise() : rawDb;

function getDbName() {
  return (
    (rawDb.config && rawDb.config.connectionConfig && rawDb.config.connectionConfig.database) ||
    (rawDb.config && rawDb.config.database) ||
    process.env.DB_NAME
  );
}

let refundTableReady;
let refundItemsTableReady;

async function ensureRefundsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS refunds (
      id INT AUTO_INCREMENT PRIMARY KEY,
      orderId INT NOT NULL,
      userId INT NOT NULL,
      reason TEXT NOT NULL,
      documentPath VARCHAR(255) DEFAULT NULL,
      total_amount DECIMAL(10,2) DEFAULT 0,
      destination VARCHAR(30) DEFAULT 'E_WALLET',
      status VARCHAR(20) DEFAULT 'pending',
      adminNote TEXT DEFAULT NULL,
      createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  const dbName = getDbName();
  const [rows] = await db.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'refunds'`,
    [dbName]
  );
  const columns = rows.map(r => r.COLUMN_NAME);

  async function ensureColumn(column, ddl) {
    if (columns.includes(column)) return;
    try {
      await db.query(`ALTER TABLE refunds ADD COLUMN ${ddl}`);
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') {
        console.warn(`refunds table migration (${column}) skipped:`, err.message);
      }
    }
  }

  await ensureColumn('total_amount', 'total_amount DECIMAL(10,2) DEFAULT 0');
  await ensureColumn('destination', "destination VARCHAR(30) DEFAULT 'E_WALLET'");

  const [finalRows] = await db.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'refunds'`,
    [dbName]
  );
  return finalRows.map(r => r.COLUMN_NAME);
}

async function tableReady() {
  if (!refundTableReady) {
    refundTableReady = ensureRefundsTable().catch(err => {
      console.error('Failed to ensure refunds table:', err.message);
    });
  }
  return refundTableReady;
}

async function ensureRefundItemsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS refund_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      refund_id INT NOT NULL,
      order_item_id INT NOT NULL,
      refund_qty INT NOT NULL,
      refund_amount DECIMAL(10,2) NOT NULL,
      createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
}

async function refundItemsReady() {
  if (!refundItemsTableReady) {
    refundItemsTableReady = ensureRefundItemsTable().catch(err => {
      console.error('Failed to ensure refund_items table:', err.message);
    });
  }
  return refundItemsTableReady;
}

async function createRefund({ orderId, userId, reason, documentPath, totalAmount = 0, destination = 'E_WALLET' }) {
  await tableReady();
  const [result] = await db.query(
    'INSERT INTO refunds (orderId, userId, reason, documentPath, total_amount, destination, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [orderId, userId, reason, documentPath || null, totalAmount || 0, destination || 'E_WALLET', 'pending']
  );
  return result.insertId;
}

async function getById(id) {
  await tableReady();
  const [rows] = await db.query('SELECT * FROM refunds WHERE id = ?', [id]);
  return rows[0] || null;
}

async function getByOrderId(orderId) {
  await tableReady();
  const [rows] = await db.query('SELECT * FROM refunds WHERE orderId = ? ORDER BY id DESC', [orderId]);
  return rows;
}

async function getByUserId(userId) {
  await tableReady();
  const [rows] = await db.query('SELECT * FROM refunds WHERE userId = ? ORDER BY id DESC', [userId]);
  return rows;
}

async function countRecentByUserId(userId, hours = 24) {
  await tableReady();
  const safeHours = Number.isFinite(Number(hours)) ? Number(hours) : 24;
  const [rows] = await db.query(
    'SELECT COUNT(*) AS total FROM refunds WHERE userId = ? AND createdAt >= (NOW() - INTERVAL ? HOUR)',
    [userId, safeHours]
  );
  return rows[0] ? Number(rows[0].total) || 0 : 0;
}

async function listAll() {
  await tableReady();
  const [rows] = await db.query(`
    SELECT r.*, o.total AS orderTotal, o.paymentMethod, o.paymentRef, u.username AS userName, u.email AS userEmail
    FROM refunds r
    LEFT JOIN orders o ON o.id = r.orderId
    LEFT JOIN users u ON u.id = r.userId
    ORDER BY r.id DESC
  `);
  return rows;
}

async function countAll() {
  await tableReady();
  const [rows] = await db.query('SELECT COUNT(*) AS total FROM refunds');
  return rows[0] ? Number(rows[0].total) || 0 : 0;
}

async function listAllPaged(limit = 20, offset = 0) {
  await tableReady();
  const safeLimit = Number.isFinite(Number(limit)) ? Number(limit) : 20;
  const safeOffset = Number.isFinite(Number(offset)) ? Number(offset) : 0;
  const [rows] = await db.query(
    `
    SELECT r.*, o.total AS orderTotal, o.paymentMethod, o.paymentRef, u.username AS userName, u.email AS userEmail
    FROM refunds r
    LEFT JOIN orders o ON o.id = r.orderId
    LEFT JOIN users u ON u.id = r.userId
    ORDER BY r.id DESC
    LIMIT ? OFFSET ?
    `,
    [safeLimit, safeOffset]
  );
  return rows;
}

async function updateStatus(id, { status, adminNote }) {
  await tableReady();
  const [result] = await db.query(
    'UPDATE refunds SET status = ?, adminNote = ? WHERE id = ?',
    [status, adminNote || null, id]
  );
  return result;
}

async function createRefundItems(refundId, items = []) {
  await refundItemsReady();
  const rows = Array.isArray(items) ? items : [];
  for (const item of rows) {
    await db.query(
      'INSERT INTO refund_items (refund_id, order_item_id, refund_qty, refund_amount) VALUES (?, ?, ?, ?)',
      [refundId, item.orderItemId, item.refundQty, item.refundAmount]
    );
  }
}

async function getRefundItemsByRefundId(refundId) {
  await refundItemsReady();
  const [rows] = await db.query(
    'SELECT * FROM refund_items WHERE refund_id = ? ORDER BY id ASC',
    [refundId]
  );
  return rows;
}

async function getApprovedRefundedQtyByOrderItemIds(orderItemIds = []) {
  await refundItemsReady();
  const ids = Array.isArray(orderItemIds) ? orderItemIds.filter(Boolean) : [];
  if (!ids.length) return {};
  const [rows] = await db.query(
    `
    SELECT ri.order_item_id AS orderItemId, SUM(ri.refund_qty) AS refundedQty
    FROM refund_items ri
    INNER JOIN refunds r ON r.id = ri.refund_id
    WHERE ri.order_item_id IN (?) AND r.status = 'approved'
    GROUP BY ri.order_item_id
    `,
    [ids]
  );
  return rows.reduce((acc, row) => {
    acc[row.orderItemId] = Number(row.refundedQty) || 0;
    return acc;
  }, {});
}

module.exports = {
  createRefund,
  getById,
  getByOrderId,
  getByUserId,
  countRecentByUserId,
  listAll,
  listAllPaged,
  countAll,
  updateStatus,
  createRefundItems,
  getRefundItemsByRefundId,
  getApprovedRefundedQtyByOrderItemIds
};
