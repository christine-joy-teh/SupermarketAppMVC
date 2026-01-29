const rawDb = require('../db');
const db = rawDb.promise ? rawDb.promise() : rawDb;

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
  return result.insertId;
}

async function countRecentByUserAction(userId, actionType, minutes) {
  const safeMinutes = Number(minutes) || 0;
  if (!safeMinutes) return 0;
  const [rows] = await db.query(
    `SELECT COUNT(*) AS total
     FROM transaction_logs
     WHERE user_id = ? AND action_type = ? AND created_at >= (NOW() - INTERVAL ? MINUTE)`,
    [userId, actionType, safeMinutes]
  );
  return rows[0] ? Number(rows[0].total) || 0 : 0;
}

async function evaluateSuspiciousRules(payload = {}) {
  const userId = payload.userId;
  const actionType = payload.actionType;
  const referenceId = payload.referenceId;
  if (!userId || !actionType) return { suspicious: false, reason: null };
  const normalized = String(actionType).toUpperCase();
  const reasons = [];

  if (normalized === 'REFUND') {
    const recent = await countRecentByUserAction(userId, 'REFUND', 10);
    if (recent >= 2) {
      reasons.push('3 refunds within 10 minutes');
    }

    if (referenceId) {
      const refund = await getRefundById(referenceId);
      if (refund && refund.orderId) {
        const repeats = await countRefundsByOrder(refund.orderId);
        if (repeats >= 2) {
          reasons.push(`Multiple refunds for order #${refund.orderId}`);
        }
      }
    }

    const { refundTotal, orderTotal } = await getRefundRatioLastDays(userId, 3);
    if (orderTotal > 0 && refundTotal / orderTotal > 0.5) {
      reasons.push('Refund amount > 50% of spend in last 3 days');
    }

    const recentTopup = await hasRecentWalletTopup(userId, 30);
    if (recentTopup) {
      reasons.push('Refund shortly after wallet top-up');
    }
  }

  if (normalized === 'PAYMENT') {
    const recent = await countRecentByUserAction(userId, 'PAYMENT', 2);
    if (recent >= 2) {
      reasons.push('3 payments within 2 minutes');
    }
    const daily = await countRecentByUserAction(userId, 'PAYMENT', 24 * 60);
    if (daily >= 4) {
      reasons.push('5 payments within 24 hours');
    }

    if (referenceId) {
      const order = await getOrderById(referenceId);
      const orderUserId = resolveOrderUserId(order);
      if (order && orderUserId) {
        const avg = await getUserAverageOrderTotal(orderUserId, order.id);
        const total = Number(order.total || 0);
        if (avg > 0 && total >= (avg * 3)) {
          reasons.push('Order total is 3x higher than usual');
        }
      }
    }
  }
  if (!reasons.length) return { suspicious: false, reason: null };
  return { suspicious: true, reason: reasons.join('; ').slice(0, 255) };
}

async function getRefundById(refundId) {
  if (!refundId) return null;
  const [rows] = await db.query('SELECT * FROM refunds WHERE id = ?', [refundId]);
  return rows[0] || null;
}

async function countRefundsByOrder(orderId) {
  if (!orderId) return 0;
  const [rows] = await db.query('SELECT COUNT(*) AS total FROM refunds WHERE orderId = ?', [orderId]);
  return rows[0] ? Number(rows[0].total) || 0 : 0;
}

async function getRefundRatioLastDays(userId, days = 3) {
  const safeDays = Number(days) || 3;
  const [refundRows] = await db.query(
    `SELECT COALESCE(SUM(total_amount), 0) AS total
     FROM refunds
     WHERE userId = ? AND status = 'approved' AND createdAt >= (NOW() - INTERVAL ? DAY)`,
    [userId, safeDays]
  );
  const [orderRows] = await db.query(
    `SELECT COALESCE(SUM(total), 0) AS total
     FROM orders
     WHERE (userId = ? OR user_id = ?) AND createdAt >= (NOW() - INTERVAL ? DAY)`,
    [userId, userId, safeDays]
  );
  return {
    refundTotal: refundRows[0] ? Number(refundRows[0].total) || 0 : 0,
    orderTotal: orderRows[0] ? Number(orderRows[0].total) || 0 : 0
  };
}

async function hasRecentWalletTopup(userId, minutes = 30) {
  const safeMinutes = Number(minutes) || 30;
  const [rows] = await db.query(
    `SELECT id FROM transaction_logs
     WHERE user_id = ? AND action_type = 'PAYMENT' AND reference_id IS NULL
     AND created_at >= (NOW() - INTERVAL ? MINUTE)
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId, safeMinutes]
  );
  return rows.length > 0;
}

async function getOrderById(orderId) {
  if (!orderId) return null;
  const [rows] = await db.query('SELECT * FROM orders WHERE id = ?', [orderId]);
  return rows[0] || null;
}

function resolveOrderUserId(order) {
  if (!order) return null;
  return order.userId || order.user_id || null;
}

async function getUserAverageOrderTotal(userId, excludeOrderId = null) {
  const [rows] = await db.query(
    `SELECT AVG(total) AS avgTotal
     FROM orders
     WHERE (userId = ? OR user_id = ?) AND id <> ?`,
    [userId, userId, excludeOrderId || 0]
  );
  return rows[0] ? Number(rows[0].avgTotal) || 0 : 0;
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
