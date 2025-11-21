const db = require('../config/db');

const discountReady = ensureDiscountColumn().catch(err => {
  console.error('Failed to ensure discount column on products:', err.message);
});

async function ensureDiscountColumn() {
  const dbName =
    (db.config && db.config.connectionConfig && db.config.connectionConfig.database) ||
    (db.config && db.config.database) ||
    process.env.DB_NAME;
  const [rows] = await db.query(
    `SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'products' AND COLUMN_NAME = 'discountPercent'`,
    [dbName]
  );
  if (!rows.length) {
    try {
      await db.query('ALTER TABLE products ADD COLUMN discountPercent DECIMAL(5,2) DEFAULT 0');
    } catch (err) {
      if (err.code !== 'ER_DUP_FIELDNAME') {
        throw err;
      }
    }
  }
}

// Data access helpers for products
async function list({ q, sort } = {}) {
  await discountReady;
  let sql = 'SELECT * FROM products';
  const params = [];
  if (q) {
    sql += ' WHERE productName LIKE ?';
    params.push(`%${q}%`);
  }
  if (sort === 'price_asc') sql += ' ORDER BY price ASC';
  else if (sort === 'price_desc') sql += ' ORDER BY price DESC';

  const [rows] = await db.query(sql, params);
  return rows;
}

async function getById(id) {
  await discountReady;
  const [rows] = await db.query('SELECT * FROM products WHERE id = ?', [id]);
  return rows[0] || null;
}

async function getBestsellers(limit = 4) {
  await discountReady;
  const [rows] = await db.query('SELECT * FROM products ORDER BY id DESC LIMIT ?', [limit]);
  return rows;
}

async function create({ name, quantity, price, image, discountPercent = 0 }) {
  await discountReady;
  const [result] = await db.query(
    'INSERT INTO products (productName, quantity, price, image, discountPercent) VALUES (?, ?, ?, ?, ?)',
    [name, quantity, price, image || null, discountPercent || 0]
  );
  return result.insertId;
}

async function update(id, { name, quantity, price, image, discountPercent = 0 }) {
  await discountReady;
  const [result] = await db.query(
    'UPDATE products SET productName = ?, quantity = ?, price = ?, image = ?, discountPercent = ? WHERE id = ?',
    [name, quantity, price, image || null, discountPercent || 0, id]
  );
  return result;
}

async function remove(id) {
  await db.query('DELETE FROM products WHERE id = ?', [id]);
}

// Decrease stock by a given quantity; floors at 0
async function reduceStock(id, reductionQty) {
  const qty = Number(reductionQty) || 0;
  if (qty <= 0) return { affectedRows: 0 };
  const [result] = await db.query(
    'UPDATE products SET quantity = GREATEST(quantity - ?, 0) WHERE id = ?',
    [qty, id]
  );
  return result;
}

module.exports = {
  list,
  getById,
  getBestsellers,
  create,
  update,
  remove,
  reduceStock
};
