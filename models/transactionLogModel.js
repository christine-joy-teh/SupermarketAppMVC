const rawDb = require('../db');
const db = rawDb.promise ? rawDb.promise() : rawDb;
const UserModel = require('./userModel');

let tableReady;

function getDbName() {
  return (
    (rawDb.config && rawDb.config.connectionConfig && rawDb.config.connectionConfig.database) ||
    (rawDb.config && rawDb.config.database) ||
    process.env.DB_NAME
  );
}

async function ensureTransactionLogsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS transaction_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      action_type VARCHAR(20) NOT NULL,
      previous_balance DECIMAL(10,2) DEFAULT NULL,
      new_balance DECIMAL(10,2) DEFAULT NULL,
      reference_id INT DEFAULT NULL,
      suspicious_flag TINYINT(1) NOT NULL DEFAULT 0,
      suspicious_reason VARCHAR(255) DEFAULT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const dbName = getDbName();
  const [rows] = await db.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'transaction_logs'`,
    [dbName]
  );
  const columns = rows.map(r => r.COLUMN_NAME);
  async function ensureColumn(column, ddl) {
    if (columns.includes(column)) return;
    try {
      await db.query(`ALTER TABLE transaction_logs ADD COLUMN ${ddl}`);
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') {
        console.warn(`transaction_logs table migration (${column}) skipped:`, err.message);
      }
    }
  }
  await ensureColumn('suspicious_flag', 'suspicious_flag TINYINT(1) NOT NULL DEFAULT 0');
  await ensureColumn('suspicious_reason', 'suspicious_reason VARCHAR(255) DEFAULT NULL');
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
  referenceId = null,
  fraudContext = null
}) {
  await ready();
  const fraudClient = require('../services/fraudClient');
  const fraudResult = await fraudClient.checkTransaction({
    userId,
    actionType,
    referenceId,
    previousBalance,
    newBalance,
    gateway: fraudContext
  });
  const suspiciousFlag = fraudResult && fraudResult.suspicious ? 1 : 0;
  const suspiciousReason = fraudResult && fraudResult.reason ? String(fraudResult.reason).slice(0, 255) : null;
  const [result] = await db.query(
    `INSERT INTO transaction_logs (user_id, action_type, previous_balance, new_balance, reference_id, suspicious_flag, suspicious_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [userId, actionType, previousBalance, newBalance, referenceId, suspiciousFlag, suspiciousReason]
  );
  await handleAutoDisableIfNeeded(userId, fraudResult);
  return result.insertId;
}

async function countRecentByUserAction(userId, actionType, windowMinutes) {
  const safeMinutes = Number(windowMinutes) || 0;
  if (!safeMinutes) return 0;
  const [rows] = await db.query(
    `SELECT COUNT(*) AS total
     FROM transaction_logs
     WHERE user_id = ? AND action_type = ? AND created_at >= (NOW() - INTERVAL ? MINUTE)`,
    [userId, actionType, safeMinutes]
  );
  return rows[0] ? Number(rows[0].total) || 0 : 0;
}

const PAYMENT_THRESHOLD = 5;
const REFUND_THRESHOLD = 5;

async function evaluateSuspiciousRules(payload = {}) {
  const userId = payload.userId;
  const actionType = payload.actionType;
  if (!userId || !actionType) return { suspicious: false, reason: null };
  const normalized = String(actionType).toUpperCase();
  const reasons = [];

  if (normalized === 'PAYMENT') {
    const recentPayments = await countRecentByUserAction(userId, 'PAYMENT', 3);
    if (recentPayments + 1 >= PAYMENT_THRESHOLD) {
      reasons.push(`${PAYMENT_THRESHOLD} transactions within 3 minutes`);
    }
  }

  if (normalized === 'REFUND') {
    const recentRefunds = await countRecentByUserAction(userId, 'REFUND', 1);
    if (recentRefunds + 1 >= REFUND_THRESHOLD) {
      reasons.push(`${REFUND_THRESHOLD} refund requests within 1 minute`);
    }
  }

  if (!reasons.length) return { suspicious: false, reason: null };
  return { suspicious: true, reason: reasons.join('; ').slice(0, 255) };
}

async function handleAutoDisableIfNeeded(userId, fraudResult) {
  if (!userId || !fraudResult || !fraudResult.suspicious) return;
  try {
    const user = await UserModel.getById(userId);
    if (!user || user.disabled) return;
    const warningReason = fraudResult && fraudResult.reason
      ? String(fraudResult.reason).slice(0, 255)
      : 'suspicious activity';
    if (user.fraud_warning_sent_at) {
      await UserModel.update(userId, { disabled: true });
      await UserModel.clearFraudWarning(userId);
      console.warn('Auto-disabling user due to repeated suspicious activity:', userId, warningReason);
    } else {
      await UserModel.markFraudWarningSent(userId, new Date(), warningReason);
      console.warn('Issuing fraud warning for user:', userId, warningReason);
    }
  } catch (err) {
    console.error('Auto disable workflow failed:', err.message);
  }
}

module.exports = {
  createLog,
  evaluateSuspiciousRules,
  async listAll() {
    await ready();
    const [rows] = await db.query(`
      SELECT t.*, u.username AS userName, u.email AS userEmail, u.disabled AS userDisabled
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
      SELECT t.*, u.username AS userName, u.email AS userEmail, u.disabled AS userDisabled
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
