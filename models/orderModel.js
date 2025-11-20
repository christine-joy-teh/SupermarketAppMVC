const db = require('../config/db');

const tableReady = ensureOrdersTable().catch(err => {
  console.error('Failed to ensure orders table:', err.message);
});

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
  return { ...row, items };
}

async function createOrder({ userId, subtotal, total, savings, status = 'processing', cartItems = [] }) {
  await tableReady;
  const normalizedItems = sanitizeCartItems(cartItems);
  const [result] = await db.query(
    'INSERT INTO orders (userId, subtotal, total, savings, status, itemsJson) VALUES (?, ?, ?, ?, ?, ?)',
    [
      userId || null,
      subtotal || 0,
      total || 0,
      savings || 0,
      status,
      JSON.stringify(normalizedItems)
    ]
  );
  return { id: result.insertId, userId, subtotal, total, savings, status, items: normalizedItems };
}

async function getAllOrders() {
  await tableReady;
  const [rows] = await db.query('SELECT * FROM orders ORDER BY id DESC');
  return rows.map(mapOrderRow);
}

async function getOrderById(id) {
  await tableReady;
  const [rows] = await db.query('SELECT * FROM orders WHERE id = ?', [id]);
  if (!rows.length) return null;
  return mapOrderRow(rows[0]);
}

async function getOrdersByUser(userId) {
  await tableReady;
  const [rows] = await db.query('SELECT * FROM orders WHERE userId = ? ORDER BY id DESC', [userId]);
  return rows.map(mapOrderRow);
}

async function updateOrderStatus(id, status) {
  await tableReady;
  await db.query('UPDATE orders SET status = ? WHERE id = ?', [status, id]);
}

module.exports = {
  createOrder,
  getAllOrders,
  getOrderById,
  getOrdersByUser,
  updateOrderStatus
};
