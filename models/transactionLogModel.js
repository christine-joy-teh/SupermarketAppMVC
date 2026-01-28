const rawDb = require('../db');
const db = rawDb.promise ? rawDb.promise() : rawDb;

let tableReady;

async function ensureTransactionLogsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS transaction_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      action_type VARCHAR(20) NOT NULL,
      previous_balance DECIMAL(10,2) DEFAULT NULL,
      new_balance DECIMAL(10,2) DEFAULT NULL,
      reference_id INT DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  return true;
}

async function ready() {
  if (!tableReady) {
    tableReady = ensureTransactionLogsTable().catch(err => {
      console.error('Failed to ensure transaction_logs table:', err.message);
    });
  }
  return tableReady;
}

async function createLog({
  userId,
  actionType,
  previousBalance = null,
  newBalance = null,
  referenceId = null
}) {
  await ready();
  const [result] = await db.query(
    `INSERT INTO transaction_logs (user_id, action_type, previous_balance, new_balance, reference_id)
     VALUES (?, ?, ?, ?, ?)`,
    [userId, actionType, previousBalance, newBalance, referenceId]
  );
  return result.insertId;
}

module.exports = {
  createLog,
  async listAll() {
    await ready();
    const [rows] = await db.query(`
      SELECT t.*, u.username AS userName, u.email AS userEmail
      FROM transaction_logs t
      LEFT JOIN users u ON u.id = t.user_id
      ORDER BY t.id DESC
    `);
    return rows;
  },
  async countAll() {
    await ready();
    const [rows] = await db.query('SELECT COUNT(*) AS total FROM transaction_logs');
    return rows[0] ? Number(rows[0].total) || 0 : 0;
  },
  async listAllPaged(limit = 20, offset = 0) {
    await ready();
    const safeLimit = Number.isFinite(Number(limit)) ? Number(limit) : 20;
    const safeOffset = Number.isFinite(Number(offset)) ? Number(offset) : 0;
    const [rows] = await db.query(
      `
      SELECT t.*, u.username AS userName, u.email AS userEmail
      FROM transaction_logs t
      LEFT JOIN users u ON u.id = t.user_id
      ORDER BY t.id DESC
      LIMIT ? OFFSET ?
      `,
      [safeLimit, safeOffset]
    );
    return rows;
  }
};
