const db = require('../config/db');

// Admin-facing user helpers
let planColumnReady;

async function ensurePlanColumn() {
  const dbName =
    (db.config && db.config.connectionConfig && db.config.connectionConfig.database) ||
    (db.config && db.config.database) ||
    process.env.DB_NAME;

  try {
    const [exists] = await db.query(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'plan'",
      [dbName]
    );
    if (exists.length) return true;
  } catch (err) {
    console.warn('Plan column check failed:', err.message);
  }

  try {
    await db.query('ALTER TABLE users ADD COLUMN plan VARCHAR(50) NULL');
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') {
      console.warn('Plan column migration skipped:', err.message);
    }
  }

  try {
    const [rows] = await db.query(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'plan'",
      [dbName]
    );
    return rows.length > 0;
  } catch (err) {
    console.warn('Plan column final check failed:', err.message);
    return false;
  }
}

async function hasPlanColumn() {
  if (!planColumnReady) {
    planColumnReady = ensurePlanColumn();
  }
  return planColumnReady;
}

async function list() {
  // Prefer selecting plan; if column is missing, fall back gracefully.
  const fieldsWithPlan = 'id, username, email, address, contact, role, plan';
  const fieldsWithoutPlan = 'id, username, email, address, contact, role';
  try {
    await hasPlanColumn();
    const [rows] = await db.query(`SELECT ${fieldsWithPlan} FROM users ORDER BY id DESC`);
    return rows;
  } catch (err) {
    if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
    const [rows] = await db.query(`SELECT ${fieldsWithoutPlan} FROM users ORDER BY id DESC`);
    return rows;
  }
}

async function getById(id) {
  const fieldsWithPlan = 'id, username, email, address, contact, role, plan';
  const fieldsWithoutPlan = 'id, username, email, address, contact, role';
  try {
    await hasPlanColumn();
    const [rows] = await db.query(`SELECT ${fieldsWithPlan} FROM users WHERE id = ?`, [id]);
    return rows[0] || null;
  } catch (err) {
    if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
    const [rows] = await db.query(`SELECT ${fieldsWithoutPlan} FROM users WHERE id = ?`, [id]);
    return rows[0] || null;
  }
}

async function update(id, { username, email, address, contact, role, plan }) {
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
  if (typeof plan !== 'undefined') {
    try {
      await hasPlanColumn();
      setters.push('plan = ?');
      params.push(plan || null);
    } catch (err) {
      if (err.code !== 'ER_BAD_FIELD_ERROR') {
        throw err;
      }
      // column missing; skip plan silently
    }
  }

  if (!setters.length) return { affectedRows: 0 };

  params.push(id);
  try {
    const [result] = await db.query(`UPDATE users SET ${setters.join(', ')} WHERE id = ?`, params);
    return result;
  } catch (err) {
    // If plan column missing and we attempted to set it, retry without plan
    if (err.code === 'ER_BAD_FIELD_ERROR') {
      const filteredSetters = setters.filter(s => !s.startsWith('plan ='));
      const filteredParams = params.slice(0, filteredSetters.length);
      filteredParams.push(id);
      const [result] = await db.query(`UPDATE users SET ${filteredSetters.join(', ')} WHERE id = ?`, filteredParams);
      return result;
    }
    throw err;
  }
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
