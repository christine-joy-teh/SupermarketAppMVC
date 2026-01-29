const rawDb = require('../db');
const db = rawDb.promise ? rawDb.promise() : rawDb;

let columnCache;
let orderItemsReady;

const tableReady = ensureOrdersTable().then(cols => {
  columnCache = cols;
  return cols;
}).catch(err => {
  console.error('Failed to ensure orders table:', err.message);
});

const cartTableReady = ensureCartTable().catch(err => {
  console.error('Failed to ensure user_carts table:', err.message);
});
const orderItemsTableReady = ensureOrderItemsTable().catch(err => {
  console.error('Failed to ensure order_items table:', err.message);
});

function getDbName() {
  return (
    (rawDb.config && rawDb.config.connectionConfig && rawDb.config.connectionConfig.database) ||
    (rawDb.config && rawDb.config.database) ||
    process.env.DB_NAME
  );
}

async function ensureOrdersTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      userId INT NULL,
      subtotal DECIMAL(10,2) DEFAULT 0,
      total DECIMAL(10,2) DEFAULT 0,
      savings DECIMAL(10,2) DEFAULT 0,
      status VARCHAR(50) DEFAULT 'processing',
      itemsJson LONGTEXT,
      createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Ensure required columns exist (for older tables)
  const dbName = getDbName();

  async function ensureColumn(column, ddl) {
    const [rows] = await db.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'orders' AND COLUMN_NAME = ?`,
      [dbName, column]
    );
    if (!rows.length) {
      try {
        await db.query(`ALTER TABLE orders ADD COLUMN ${ddl}`);
      } catch (err) {
        if (err.code !== 'ER_DUP_FIELDNAME') {
          console.warn(`orders table migration (${column}) skipped:`, err.message);
        }
      }
    }
  }

  await ensureColumn('userId', 'userId INT NULL');
  await ensureColumn('user_id', 'user_id INT NULL');
  await ensureColumn('subtotal', 'subtotal DECIMAL(10,2) DEFAULT 0');
  await ensureColumn('total', 'total DECIMAL(10,2) DEFAULT 0');
  await ensureColumn('savings', 'savings DECIMAL(10,2) DEFAULT 0');
  await ensureColumn('status', "status VARCHAR(50) DEFAULT 'processing'");
  await ensureColumn('itemsJson', 'itemsJson LONGTEXT');
  await ensureColumn('createdAt', 'createdAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP');
  await ensureColumn('confirmed_purchase_time', 'confirmed_purchase_time DATETIME NULL');
  await ensureColumn('deliveryMethod', "deliveryMethod VARCHAR(50) DEFAULT 'delivery'");
  await ensureColumn('deliveryAddress', "deliveryAddress VARCHAR(255) DEFAULT NULL");
  await ensureColumn('pickupOutlet', "pickupOutlet VARCHAR(255) DEFAULT NULL");
  await ensureColumn('paymentMethod', "paymentMethod VARCHAR(50) DEFAULT NULL");
  await ensureColumn('paymentRef', "paymentRef VARCHAR(255) DEFAULT NULL");

  // Loosen existing columns that might be NOT NULL without defaults
  try {
    await db.query('ALTER TABLE orders MODIFY COLUMN user_id INT NULL');
  } catch (err) {
    if (err.code !== 'ER_BAD_FIELD_ERROR') {
      console.warn('orders table migration (alter user_id) skipped:', err.message);
    }
  }
  try {
    await db.query('ALTER TABLE orders MODIFY COLUMN userId INT NULL');
  } catch (err) {
    if (err.code !== 'ER_BAD_FIELD_ERROR') {
      console.warn('orders table migration (alter userId) skipped:', err.message);
    }
  }

  // Backfill user_id from userId for legacy rows
  try {
    await db.query('UPDATE orders SET user_id = userId WHERE user_id IS NULL AND userId IS NOT NULL');
  } catch (err) {
    if (err.code !== 'ER_BAD_FIELD_ERROR') {
      console.warn('orders table migration (backfill user_id) skipped:', err.message);
    }
  }

  const [colRows] = await db.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'orders'`,
    [dbName]
  );
  return colRows.map(r => r.COLUMN_NAME);
}

async function ensureCartTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS user_carts (
      userId INT NOT NULL PRIMARY KEY,
      items JSON NOT NULL,
      updatedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);
}

async function ensureOrderItemsTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS order_items (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_id INT NOT NULL,
      product_id INT NULL,
      name VARCHAR(255) NOT NULL,
      unit_price DECIMAL(10,2) NOT NULL,
      qty INT NOT NULL,
      line_total DECIMAL(10,2) NOT NULL,
      refunded_qty INT NOT NULL DEFAULT 0
    )
  `);

  const dbName = getDbName();

  async function ensureColumn(column, ddl) {
    const [rows] = await db.query(
      `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'order_items' AND COLUMN_NAME = ?`,
      [dbName, column]
    );
    if (!rows.length) {
      try {
        await db.query(`ALTER TABLE order_items ADD COLUMN ${ddl}`);
      } catch (err) {
        if (err.code !== 'ER_DUP_FIELDNAME') {
          console.warn(`order_items table migration (${column}) skipped:`, err.message);
        }
      }
    }
  }

  await ensureColumn('product_id', 'product_id INT NULL');
  await ensureColumn('name', 'name VARCHAR(255) NOT NULL');
  await ensureColumn('unit_price', 'unit_price DECIMAL(10,2) NOT NULL');
  await ensureColumn('qty', 'qty INT NOT NULL');
  await ensureColumn('line_total', 'line_total DECIMAL(10,2) NOT NULL');
  await ensureColumn('refunded_qty', 'refunded_qty INT NOT NULL DEFAULT 0');

  const [colRows] = await db.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'order_items'`,
    [dbName]
  );
  orderItemsReady = colRows.map(r => r.COLUMN_NAME);
  return orderItemsReady;
}

async function ensureOrderItemsForOrder(orderId, items = []) {
  await orderItemsTableReady;
  const [rows] = await db.query('SELECT COUNT(*) AS total FROM order_items WHERE order_id = ?', [orderId]);
  if (rows[0] && Number(rows[0].total) > 0) {
    return;
  }
  const safeItems = Array.isArray(items) ? items : [];
  for (const item of safeItems) {
    const unitPrice = Number(item.price || item.unit_price || 0);
    const qty = Number(item.quantity || item.qty || 0);
    if (!Number.isFinite(unitPrice) || !Number.isFinite(qty) || qty <= 0) continue;
    const lineTotal = Number((unitPrice * qty).toFixed(2));
    await db.query(
      `INSERT INTO order_items (order_id, product_id, name, unit_price, qty, line_total, refunded_qty)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      [orderId, item.productId || item.product_id || null, item.productName || item.name || 'Item', unitPrice, qty, lineTotal]
    );
  }
}

async function getOrderItemsByOrderId(orderId) {
  await orderItemsTableReady;
  const [rows] = await db.query('SELECT * FROM order_items WHERE order_id = ? ORDER BY id ASC', [orderId]);
  return rows;
}

async function addRefundedQty(orderItemId, refundQty) {
  await orderItemsTableReady;
  const qty = Number(refundQty) || 0;
  if (qty <= 0) return;
  await db.query(
    'UPDATE order_items SET refunded_qty = refunded_qty + ? WHERE id = ?',
    [qty, orderItemId]
  );
}

async function markOrderItemsFullyRefunded(orderId) {
  await orderItemsTableReady;
  await db.query('UPDATE order_items SET refunded_qty = qty WHERE order_id = ?', [orderId]);
}

function sanitizeCartItems(items = []) {
  if (!Array.isArray(items)) return [];
  return items.map(item => ({
    productId: item.productId,
    productName: item.productName,
    quantity: Number(item.quantity) || 0,
    price: Number(item.price) || 0,
    image: item.image || null
  }));
}

function mapOrderRow(row) {
  let items = [];
  if (row.itemsJson) {
    try {
      items = JSON.parse(row.itemsJson);
    } catch (err) {
      console.warn('Unable to parse itemsJson for order', row.id, err.message);
    }
  }
  const userId = typeof row.userId !== 'undefined' && row.userId !== null
    ? row.userId
    : (typeof row.user_id !== 'undefined' ? row.user_id : null);
  return { ...row, userId, items };
}

async function createOrder({
  userId,
  subtotal,
  total,
  savings,
  status = 'processing',
  cartItems = [],
  deliveryMethod = 'delivery',
  deliveryAddress = null,
  pickupOutlet = null,
  paymentMethod = null,
  paymentRef = null
}) {
  await tableReady;
  const normalizedItems = sanitizeCartItems(cartItems);
  // Always write to both userId and user_id (both columns are created in ensureOrdersTable)
  const sql = `
    INSERT INTO orders (userId, user_id, subtotal, total, savings, status, itemsJson, deliveryMethod, deliveryAddress, pickupOutlet, paymentMethod, paymentRef)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  const params = [
    userId || null,
    userId || null,
    subtotal || 0,
    total || 0,
    savings || 0,
    status,
    JSON.stringify(normalizedItems),
    deliveryMethod || 'delivery',
    deliveryAddress || null,
    pickupOutlet || null,
    paymentMethod || null,
    paymentRef || null
  ];

  const [result] = await db.query(sql, params);
  return {
    id: result.insertId,
    userId,
    subtotal,
    total,
    savings,
    status,
    items: normalizedItems,
    deliveryMethod,
    deliveryAddress,
    pickupOutlet,
    paymentMethod,
    paymentRef
  };
}

async function getAllOrders() {
  await tableReady;
  const [rows] = await db.query(`
    SELECT o.*, u.username AS userName, u.email AS userEmail
    FROM orders o
    LEFT JOIN users u ON u.id = o.userId OR u.id = o.user_id
    ORDER BY o.id DESC
  `);
  return rows.map(mapOrderRow);
}

async function countAllOrders() {
  await tableReady;
  const [rows] = await db.query('SELECT COUNT(*) AS total FROM orders');
  return rows[0] ? Number(rows[0].total) || 0 : 0;
}

async function getAllOrdersPaged(limit = 20, offset = 0) {
  await tableReady;
  const safeLimit = Number.isFinite(Number(limit)) ? Number(limit) : 20;
  const safeOffset = Number.isFinite(Number(offset)) ? Number(offset) : 0;
  const [rows] = await db.query(
    `
    SELECT o.*, u.username AS userName, u.email AS userEmail
    FROM orders o
    LEFT JOIN users u ON u.id = o.userId OR u.id = o.user_id
    ORDER BY o.id DESC
    LIMIT ? OFFSET ?
    `,
    [safeLimit, safeOffset]
  );
  return rows.map(mapOrderRow);
}

async function getOrderById(id) {
  await tableReady;
  const [rows] = await db.query('SELECT * FROM orders WHERE id = ?', [id]);
  if (!rows.length) return null;
  return mapOrderRow(rows[0]);
}

async function getConfirmedPurchaseTimeById(id) {
  await tableReady;
  const [rows] = await db.query(
    'SELECT confirmed_purchase_time FROM orders WHERE id = ?',
    [id]
  );
  if (!rows.length) return null;
  return rows[0].confirmed_purchase_time || null;
}

async function getOrdersByUser(userId) {
  await tableReady;
  const safeUserId = Number(userId);
  if (!Number.isFinite(safeUserId)) return [];
  try {
    const [rows] = await db.query(
      `
      SELECT o.*
      FROM orders o
      INNER JOIN users u ON u.id = ?
      WHERE (o.userId = ? OR o.user_id = ?)
        AND (u.createdAt IS NULL OR o.createdAt >= u.createdAt)
      ORDER BY o.id DESC
      `,
      [safeUserId, safeUserId, safeUserId]
    );
    return rows.map(mapOrderRow);
  } catch (err) {
    if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
    const [rows] = await db.query(
      'SELECT * FROM orders WHERE (userId = ? OR user_id = ?) ORDER BY id DESC',
      [safeUserId, safeUserId]
    );
    return rows.map(mapOrderRow);
  }
}

async function getOrdersByUserIdOnly(userId) {
  await tableReady;
  const safeUserId = Number(userId);
  if (!Number.isFinite(safeUserId)) return [];
  try {
    const [rows] = await db.query(
      `
      SELECT o.*
      FROM orders o
      INNER JOIN users u ON u.id = ?
      WHERE o.user_id = ?
        AND (u.createdAt IS NULL OR o.createdAt >= u.createdAt)
      ORDER BY o.id DESC
      `,
      [safeUserId, safeUserId]
    );
    return rows.map(mapOrderRow);
  } catch (err) {
    if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
    const [rows] = await db.query(
      'SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC',
      [safeUserId]
    );
    return rows.map(mapOrderRow);
  }
}

async function updateOrderStatus(id, status) {
  await tableReady;
  await db.query('UPDATE orders SET status = ? WHERE id = ?', [status, id]);
}

async function deleteOrder(id) {
  await tableReady;
  await db.query('DELETE FROM orders WHERE id = ?', [id]);
}

async function getCartByUserId(userId) {
  await cartTableReady;
  const [rows] = await db.query('SELECT items FROM user_carts WHERE userId = ?', [userId]);
  if (!rows.length || typeof rows[0].items === 'undefined' || rows[0].items === null) return [];
  const raw = rows[0].items;
  try {
    if (typeof raw === 'string') return JSON.parse(raw);
    if (Buffer.isBuffer(raw)) return JSON.parse(raw.toString('utf8'));
    if (typeof raw === 'object') return raw; // MySQL JSON columns may already be parsed
    return [];
  } catch (err) {
    console.warn('Unable to parse stored cart for user', userId, err.message);
    return [];
  }
}

async function saveCart(userId, cartItems = []) {
  await cartTableReady;
  const payload = JSON.stringify(cartItems || []);
  await db.query(
    `INSERT INTO user_carts (userId, items)
     VALUES (?, ?)
     ON DUPLICATE KEY UPDATE items = VALUES(items), updatedAt = CURRENT_TIMESTAMP`,
    [userId, payload]
  );
}

module.exports = {
  createOrder,
  getAllOrders,
  getAllOrdersPaged,
  countAllOrders,
  getOrderById,
  getConfirmedPurchaseTimeById,
  getOrdersByUser,
  getOrdersByUserIdOnly,
  updateOrderStatus,
  deleteOrder,
  getCartByUserId,
  saveCart,
  ensureOrderItemsForOrder,
  getOrderItemsByOrderId,
  addRefundedQty,
  markOrderItemsFullyRefunded
};
