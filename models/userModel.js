const rawDb = require('../db');
const db = rawDb.promise ? rawDb.promise() : rawDb;

function getDbName() {
  return (
    (rawDb.config && rawDb.config.connectionConfig && rawDb.config.connectionConfig.database) ||
    (rawDb.config && rawDb.config.database) ||
    process.env.DB_NAME
  );
}

// Admin-facing user helpers
let planColumnReady;
let disabledColumnReady;
let loyaltyColumnReady;

async function ensurePlanColumn() {
  const dbName = getDbName();

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

async function ensureDisabledColumn() {
  const dbName = getDbName();
  try {
    const [exists] = await db.query(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'disabled'",
      [dbName]
    );
    if (exists.length) return true;
  } catch (err) {
    console.warn('Disabled column check failed:', err.message);
  }
  try {
    await db.query("ALTER TABLE users ADD COLUMN disabled TINYINT(1) NOT NULL DEFAULT 0");
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') {
      console.warn('Disabled column migration skipped:', err.message);
    }
  }
  return true;
}

async function hasDisabledColumn() {
  if (!disabledColumnReady) {
    disabledColumnReady = ensureDisabledColumn();
  }
  return disabledColumnReady;
}

async function ensureLoyaltyPointsColumn() {
  const dbName = getDbName();

  try {
    const [exists] = await db.query(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'loyalty_points'",
      [dbName]
    );
    if (exists.length) return true;
  } catch (err) {
    console.warn('Loyalty points column check failed:', err.message);
  }

  try {
    await db.query('ALTER TABLE users ADD COLUMN loyalty_points INT NOT NULL DEFAULT 0');
  } catch (err) {
    if (err.code !== 'ER_DUP_FIELDNAME') {
      console.warn('Loyalty points column migration skipped:', err.message);
    }
  }

  try {
    const [rows] = await db.query(
      "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'loyalty_points'",
      [dbName]
    );
    return rows.length > 0;
  } catch (err) {
    console.warn('Loyalty points column final check failed:', err.message);
    return false;
  }
}

async function hasLoyaltyPointsColumn() {
  if (!loyaltyColumnReady) {
    loyaltyColumnReady = ensureLoyaltyPointsColumn();
  }
  return loyaltyColumnReady;
}

async function list() {
  // Prefer selecting plan; if column is missing, fall back gracefully.
  const fieldsWithPlan = 'id, username, email, address, contact, role, plan, loyalty_points, disabled';
  const fieldsWithoutPlan = 'id, username, email, address, contact, role';
  try {
    await hasPlanColumn();
    await hasLoyaltyPointsColumn();
    await hasDisabledColumn();
    const [rows] = await db.query(`SELECT ${fieldsWithPlan} FROM users ORDER BY id DESC`);
    return rows;
  } catch (err) {
    if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
    const [rows] = await db.query(`SELECT ${fieldsWithoutPlan} FROM users ORDER BY id DESC`);
    return rows;
  }
}

async function getById(id) {
  const fieldsWithPlan = 'id, username, email, address, contact, role, plan, loyalty_points, disabled';
  const fieldsWithoutPlan = 'id, username, email, address, contact, role';
  try {
    await hasPlanColumn();
    await hasLoyaltyPointsColumn();
    await hasDisabledColumn();
    const [rows] = await db.query(`SELECT ${fieldsWithPlan} FROM users WHERE id = ?`, [id]);
    return rows[0] || null;
  } catch (err) {
    if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
    const [rows] = await db.query(`SELECT ${fieldsWithoutPlan} FROM users WHERE id = ?`, [id]);
    return rows[0] || null;
  }
}

async function update(id, { username, email, address, contact, role, plan, disabled, loyaltyPoints }) {
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
  if (typeof loyaltyPoints !== 'undefined') {
    try {
      await hasLoyaltyPointsColumn();
      const cleanPoints = Math.max(0, Math.floor(Number(loyaltyPoints) || 0));
      setters.push('loyalty_points = ?');
      params.push(cleanPoints);
    } catch (err) {
      if (err.code !== 'ER_BAD_FIELD_ERROR') {
        throw err;
      }
      // column missing; skip loyalty_points silently
    }
  }
  if (typeof disabled !== 'undefined') {
    try {
      await hasDisabledColumn();
      setters.push('disabled = ?');
      params.push(disabled ? 1 : 0);
    } catch (err) {
      if (err.code !== 'ER_BAD_FIELD_ERROR') {
        throw err;
      }
      // column missing; skip disabled silently
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
      const filteredSetters = setters.filter(s => !s.startsWith('plan =') && !s.startsWith('loyalty_points ='));
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

async function findByEmail(email) {
  const [rows] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
  return rows[0] || null;
}

async function create({ username, email, password, address, contact, plan }) {
  await hasPlanColumn();

  // Try inserting with plan; if column missing, fall back without it
  const baseParams = [username, email, password, address, contact, 'user'];
  try {
    const [result] = await db.query(
      'INSERT INTO users (username, email, password, address, contact, role, plan) VALUES (?, ?, SHA1(?), ?, ?, ?, ?)',
      [...baseParams, plan]
    );
    return result;
  } catch (err) {
    if (err.code !== 'ER_BAD_FIELD_ERROR') throw err;
    const [result] = await db.query(
      'INSERT INTO users (username, email, password, address, contact, role) VALUES (?, ?, SHA1(?), ?, ?, ?)',
      baseParams
    );
    return result;
  }
}

async function authenticate(email, password) {
  const [rows] = await db.query(
    'SELECT * FROM users WHERE email = ? AND password = SHA1(?)',
    [email, password]
  );
  return rows[0] || null;
}

async function adjustLoyaltyPoints(id, delta) {
  const cleanDelta = Math.floor(Number(delta) || 0);
  if (!Number.isFinite(cleanDelta) || cleanDelta === 0) {
    return { affectedRows: 0 };
  }
  try {
    await hasLoyaltyPointsColumn();
    const [result] = await db.query(
      'UPDATE users SET loyalty_points = GREATEST(0, COALESCE(loyalty_points, 0) + ?) WHERE id = ?',
      [cleanDelta, id]
    );
    return result;
  } catch (err) {
    if (err.code === 'ER_BAD_FIELD_ERROR') {
      return { affectedRows: 0 };
    }
    throw err;
  }
}

async function getLoyaltyPointsById(id) {
  try {
    await hasLoyaltyPointsColumn();
    const [rows] = await db.query('SELECT loyalty_points FROM users WHERE id = ?', [id]);
    if (!rows.length) return 0;
    return Number(rows[0].loyalty_points) || 0;
  } catch (err) {
    if (err.code === 'ER_BAD_FIELD_ERROR') return 0;
    throw err;
  }
}

module.exports = {
  list,
  getById,
  update,
  remove,
  findByEmail,
  create,
  authenticate,
  adjustLoyaltyPoints,
  getLoyaltyPointsById
};
