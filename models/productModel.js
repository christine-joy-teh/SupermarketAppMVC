<<<<<<< HEAD
const rawDb = require('../db');
const db = rawDb.promise ? rawDb.promise() : rawDb;

function getDbName() {
  return (
    (rawDb.config && rawDb.config.connectionConfig && rawDb.config.connectionConfig.database) ||
    (rawDb.config && rawDb.config.database) ||
    process.env.DB_NAME
  );
}

const discountReady = ensureDiscountColumn().catch(err => {
  console.error('Failed to ensure discount column on products:', err.message);
});

function clampDiscountPercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(50, num));
}

async function ensureDiscountColumn() {
  const dbName = getDbName();
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
  const discount = clampDiscountPercent(discountPercent);
  const [result] = await db.query(
    'INSERT INTO products (productName, quantity, price, image, discountPercent) VALUES (?, ?, ?, ?, ?)',
    [name, quantity, price, image || null, discount]
  );
  return result.insertId;
}

async function update(id, { name, quantity, price, image, discountPercent = 0 }) {
  await discountReady;
  const discount = clampDiscountPercent(discountPercent);
  const [result] = await db.query(
    'UPDATE products SET productName = ?, quantity = ?, price = ?, image = ?, discountPercent = ? WHERE id = ?',
    [name, quantity, price, image || null, discount, id]
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
=======
const rawDb = require('../db');
const db = rawDb.promise ? rawDb.promise() : rawDb;

function getDbName() {
  return (
    (rawDb.config && rawDb.config.connectionConfig && rawDb.config.connectionConfig.database) ||
    (rawDb.config && rawDb.config.database) ||
    process.env.DB_NAME
  );
}

const discountReady = ensureDiscountColumn().catch(err => {
  console.error('Failed to ensure discount column on products:', err.message);
});

function clampDiscountPercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(50, num));
}

async function ensureDiscountColumn() {
  const dbName = getDbName();
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
  const discount = clampDiscountPercent(discountPercent);
  const [result] = await db.query(
    'INSERT INTO products (productName, quantity, price, image, discountPercent) VALUES (?, ?, ?, ?, ?)',
    [name, quantity, price, image || null, discount]
  );
  return result.insertId;
}

async function update(id, { name, quantity, price, image, discountPercent = 0 }) {
  await discountReady;
  const discount = clampDiscountPercent(discountPercent);
  const [result] = await db.query(
    'UPDATE products SET productName = ?, quantity = ?, price = ?, image = ?, discountPercent = ? WHERE id = ?',
    [name, quantity, price, image || null, discount, id]
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
>>>>>>> bfc95a4 (new updates, transaction logs and refund)
