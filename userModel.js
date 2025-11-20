const db = require('../config/db');

// Admin-facing user helpers
let hasPlanColumnPromise;

async function hasPlanColumn() {
  if (!hasPlanColumnPromise) {
    const dbName =
      (db.config && db.config.connectionConfig && db.config.connectionConfig.database) ||
      (db.config && db.config.database) ||
      process.env.DB_NAME;
    hasPlanColumnPromise = db
      .query(
        "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'plan'",
        [dbName]
      )
      .then(([rows]) => rows.length > 0)
      .catch(() => false);
  }
  return hasPlanColumnPromise;
}

async function list() {
  const includePlan = await hasPlanColumn();
  const fields = includePlan
    ? 'id, username, email, address, contact, role, plan'
    : 'id, username, email, address, contact, role';
  const [rows] = await db.query(`SELECT ${fields} FROM users ORDER BY id DESC`);
  return rows;
}

async function getById(id) {
  const includePlan = await hasPlanColumn();
  const fields = includePlan
    ? 'id, username, email, address, contact, role, plan'
    : 'id, username, email, address, contact, role';
  const [rows] = await db.query(`SELECT ${fields} FROM users WHERE id = ?`, [id]);
  return rows[0] || null;
}

async function update(id, { username, email, address, contact, role, plan }) {
  const includePlan = await hasPlanColumn();
  const setters = [];
  const params = [];

  if (typeof username !== 'undefined') {
    setters.push('username = ?');
    params.push(username);
  }
  if (typeof email !== 'undefined') {
    setters.push('email = ?');
    params.push(email);
  }
  if (typeof address !== 'undefined') {
    setters.push('address = ?');
    params.push(address);
  }
  if (typeof contact !== 'undefined') {
    setters.push('contact = ?');
    params.push(contact);
  }
  if (typeof role !== 'undefined') {
    setters.push('role = ?');
    params.push(role);
  }
  if (includePlan && typeof plan !== 'undefined') {
    setters.push('plan = ?');
    params.push(plan || null);
  }

  if (!setters.length) return { affectedRows: 0 };

  params.push(id);
  const [result] = await db.query(`UPDATE users SET ${setters.join(', ')} WHERE id = ?`, params);
  return result;
}

async function remove(id) {
  const [result] = await db.query('DELETE FROM users WHERE id = ?', [id]);
  return result;
}

module.exports = {
  list,
  getById,
  update,
  remove
};
