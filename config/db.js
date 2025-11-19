const mysql = require('mysql2/promise');

// Shared database pool for product operations
const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: 'Republic_C207',
  database: 'c372_supermarketdb',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

module.exports = pool;
