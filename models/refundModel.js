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

async function ensureRefundsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS refunds (
      id INT AUTO_INCREMENT PRIMARY KEY,
      orderId INT NOT NULL,
      userId INT NOT NULL,
      reason TEXT NOT NULL,
      documentPath VARCHAR(255) DEFAULT NULL,
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
  return rows.map(r => r.COLUMN_NAME);
}

async function tableReady() {
  if (!refundTableReady) {
    refundTableReady = ensureRefundsTable().catch(err => {
      console.error('Failed to ensure refunds table:', err.message);
    });
  }
  return refundTableReady;
}

async function createRefund({ orderId, userId, reason, documentPath }) {
  await tableReady();
  const [result] = await db.query(
    'INSERT INTO refunds (orderId, userId, reason, documentPath, status) VALUES (?, ?, ?, ?, ?)',
    [orderId, userId, reason, documentPath || null, 'pending']
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

async function updateStatus(id, { status, adminNote }) {
  await tableReady();
  const [result] = await db.query(
    'UPDATE refunds SET status = ?, adminNote = ? WHERE id = ?',
    [status, adminNote || null, id]
  );
  return result;
}

module.exports = {
  createRefund,
  getById,
  getByOrderId,
  getByUserId,
  listAll,
  updateStatus
};
