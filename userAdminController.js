const UserModel = require('../models/userModel');

function isValidEmail(email) {
  return typeof email === 'string' && email.includes('@') && email.includes('.');
}

function isValidRole(role) {
  return role === 'admin' || role === 'user';
}

async function list(req, res) {
  try {
    const users = await UserModel.list();
    res.render('adminUsers', { users, user: req.session.user });
  } catch (err) {
    console.error('Error listing users:', err.message);
    req.flash('error', 'Unable to load users right now.');
    res.redirect('/inventory');
  }
}

async function renderEdit(req, res) {
  try {
    const targetUser = await UserModel.getById(req.params.id);
    if (!targetUser) {
      req.flash('error', 'User not found.');
      return res.redirect('/admin/users');
    }
    res.render('editUser', { targetUser, user: req.session.user });
  } catch (err) {
    console.error('Error loading user for edit:', err.message);
    req.flash('error', 'Unable to load user.');
    res.redirect('/admin/users');
  }
}

async function update(req, res) {
  const { username, email, address, contact, role, plan } = req.body;
  const userId = req.params.id;

  if (!username || !email || !role || !isValidEmail(email) || !isValidRole(role)) {
    req.flash('error', 'Please provide a username, valid email, and role (admin/user).');
    return res.redirect(`/admin/users/${userId}/edit`);
  }

  try {
    const result = await UserModel.update(userId, {
      username,
      email,
      address: address || '',
      contact: contact || '',
      role,
      plan
    });

    if (result && result.affectedRows === 0) {
      req.flash('error', 'User not found or not updated.');
    } else {
      req.flash('success', 'User updated.');
    }
    res.redirect('/admin/users');
  } catch (err) {
    console.error('Error updating user:', err.message);
    req.flash('error', 'Unable to update user.');
    res.redirect(`/admin/users/${userId}/edit`);
  }
}

async function remove(req, res) {
  const userId = req.params.id;
  try {
    const result = await UserModel.remove(userId);
    if (result && result.affectedRows === 0) {
      req.flash('error', 'User not found.');
    } else {
      req.flash('success', 'User deleted.');
    }
  } catch (err) {
    console.error('Error deleting user:', err.message);
    req.flash('error', 'Unable to delete user.');
  }
  res.redirect('/admin/users');
}

module.exports = {
  list,
  renderEdit,
  update,
  remove
};
