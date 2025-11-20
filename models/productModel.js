const db = require('../config/db');

// Data access helpers for products
async function list({ q, sort } = {}) {
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
  const [rows] = await db.query('SELECT * FROM products WHERE id = ?', [id]);
  return rows[0] || null;
}

async function getBestsellers(limit = 4) {
  const [rows] = await db.query('SELECT * FROM products ORDER BY id DESC LIMIT ?', [limit]);
  return rows;
}

async function create({ name, quantity, price, image }) {
  const [result] = await db.query(
    'INSERT INTO products (productName, quantity, price, image) VALUES (?, ?, ?, ?)',
    [name, quantity, price, image || null]
  );
  return result.insertId;
}

async function update(id, { name, quantity, price, image }) {
  const [result] = await db.query(
    'UPDATE products SET productName = ?, quantity = ?, price = ?, image = ? WHERE id = ?',
    [name, quantity, price, image || null, id]
  );
  return result;
}

async function remove(id) {
  await db.query('DELETE FROM products WHERE id = ?', [id]);
}

module.exports = {
  list,
  getById,
  getBestsellers,
  create,
  update,
  remove
};
