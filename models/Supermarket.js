// ...existing code...
const db = require('../db');

const Supermarket = {
  // Get all products
  getAll: function (params, callback) {
    // params is kept for compatibility (e.g., pagination/filter) but not used here
    const sql = 'SELECT productId, name, quantity, price, image FROM students';
    db.query(sql, (err, results) => {
      callback(err, results);
    });
  },

  // Get product by ID
  getById: function (productId, callback) {
    const sql = 'SELECT productId, name, quantity, price, image FROM students WHERE productId = ?';
    db.query(sql, [productId], (err, results) => {
      callback(err, results && results.length ? results[0] : null);
    });
  },

  // Add a new product
  add: function (product, callback) {
    // product: { name, quantity, price, image }
    const sql = 'INSERT INTO students (name, quantity, price, image) VALUES (?, ?, ?, ?)';
    const params = [product.name, product.quantity, product.price, product.image];
    db.query(sql, params, (err, result) => {
      if (err) return callback(err);
      // return inserted id and product data
      callback(null, { productId: result.insertId, ...product });
    });
  },

  // Update an existing product
  update: function (productId, product, callback) {
    // product: { name, quantity, price, image }
    const sql = 'UPDATE students SET name = ?, quantity = ?, price = ?, image = ? WHERE productId = ?';
    const params = [product.name, product.quantity, product.price, product.image, productId];
    db.query(sql, params, (err, result) => {
      if (err) return callback(err);
      callback(null, { affectedRows: result.affectedRows });
    });
  },

  // Delete a product
  delete: function (productId, callback) {
    const sql = 'DELETE FROM students WHERE productId = ?';
    db.query(sql, [productId], (err, result) => {
      if (err) return callback(err);
      callback(null, { affectedRows: result.affectedRows });
    });
  }
};

module.exports = Supermarket;
// ...existing code...
