// Handles user registration, login, membership, and account management.

const UserModel = require('../models/userModel');
const OrderModel = require('../models/orderModel');
const membershipPlans = require('../models/membershipPlans');

function resolveUserId(user) {
  if (!user) return null;
  return user.id || user.userId || user.user_id || user.userID || null;
}

function isValidEmail(email) {
  return typeof email === 'string' && email.includes('@') && email.includes('.');
}

function isValidRole(role) {
  return role === 'admin' || role === 'user';
}

function isValidPlan(plan) {
  const allowed = ['', null, undefined, 'basic', 'silver', 'gold'];
  return allowed.includes(plan);
}

function renderLogin(req, res) {
  res.render('login', { messages: req.flash('success'), errors: req.flash('error') });
}

function renderRegister(req, res) {
  const plan = req.query.plan || '';
  res.render('register', { messages: req.flash('error'), formData: {}, plan });
}

function renderLoyalty(req, res) {
  const user = req.session.user || null;
  const pointsValue = Number(
    user && (typeof user.loyalty_points !== 'undefined' ? user.loyalty_points : user.loyaltyPoints)
  );
  const points = Number.isFinite(pointsValue) ? pointsValue : 0;
  res.render('loyalty', { user, points });
}

async function register(req, res) {
  const { username, email, password, address, contact } = req.body;
  const plan = 'basic'; // new accounts start on basic by default
  if (!username || !email || !password || !address || !contact) {
    req.flash('error', 'All fields are required.');
    return res.redirect('/register');
  }
  const strongPwd = password.length >= 8 && /[A-Za-z]/.test(password) && /[0-9]/.test(password);
  if (!strongPwd) {
    req.flash('error', 'Please use a stronger password (at least 8 characters with letters and numbers).');
    return res.redirect('/register');
  }

  try {
    const existing = await UserModel.findByEmail(email);
    if (existing) {
      req.flash('error', 'An account with that email already exists.');
      return res.redirect('/register');
    }
    await UserModel.create({ username, email, password, address, contact, plan });
    req.flash('success', 'Registration successful. Please log in.');
    return res.redirect('/login');
  } catch (err) {
    console.error('Error during registration:', err.message);
    req.flash('error', 'Unable to create account.');
    return res.redirect('/register');
  }
}

async function login(req, res) {
  const { email, password } = req.body;
  if (!email || !password) {
    req.flash('error', 'All fields are required.');
    return res.redirect('/login');
  }

  try {
    const user = await UserModel.authenticate(email, password);
    if (!user) {
      req.flash('error', 'Invalid email or password.');
      return res.redirect('/login');
    }
    if (user.disabled) {
      req.flash('error', 'Your account has been disabled. Please contact support.');
      return res.redirect('/login');
    }

    req.session.user = user;
    if (typeof req.session.user.loyalty_points === 'undefined' && typeof req.session.user.loyaltyPoints === 'undefined') {
      req.session.user.loyalty_points = 0;
    }
    if (typeof req.session.user.wallet_balance === 'undefined' && typeof req.session.user.walletBalance === 'undefined') {
      req.session.user.wallet_balance = 0;
    }
    try {
      const savedCart = await OrderModel.getCartByUserId(resolveUserId(req.session.user));
      if (Array.isArray(savedCart) && savedCart.length) {
        req.session.cart = savedCart;
      }
    } catch (loadErr) {
      console.error('Unable to load saved cart:', loadErr.message);
    }

    req.flash('success', 'Login successful!');
    if (req.session.user.role === 'user') {
      return res.redirect('/shopping');
    }
    return res.redirect('/inventory');
  } catch (err) {
    console.error('Database query error:', err.message);
    return res.status(500).send('Database error');
  }
}

async function persistCart(req) {
  const userId = resolveUserId(req.session && req.session.user);
  if (!userId) return;
  const items = req.session && Array.isArray(req.session.cart) ? req.session.cart : [];
  try {
    await OrderModel.saveCart(userId, items);
  } catch (err) {
    console.error('Unable to save cart:', err.message);
  }
}

async function logout(req, res) {
  await persistCart(req);
  req.flash('success', 'You have been logged out.');

  req.session.destroy(err => {
    if (err) {
      return res.status(500).send('Error logging out');
    }
    res.clearCookie('connect.sid');
    res.redirect('/login');
  });
}

// Membership payment page
function renderMembershipPayment(req, res) {
  const planKey = membershipPlans.normalizePlanKey(req.query.plan || 'silver');
  const confirm = req.query.confirm || '';
  const plans = membershipPlans.getMembershipPlans();
  const selected = membershipPlans.getMembershipPlan(planKey) || plans.silver;
  res.render('membershipPayment', {
    planKey,
    plan: selected,
    plans,
    user: req.session.user,
    confirm,
    paypalClientId: process.env.PAYPAL_CLIENT_ID
  });
}

// Process membership payment
async function processMembershipPayment(req, res) {
  const plan = membershipPlans.normalizePlanKey(req.body.plan);
  const selected = membershipPlans.getMembershipPlan(plan);
  if (!selected) {
    req.flash('error', 'Invalid plan selected.');
    return res.redirect('/membership/payment');
  }
  const userId = resolveUserId(req.session.user);
  if (!userId) {
    req.flash('error', 'User not found.');
    return res.redirect('/membership/payment');
  }

  if (selected.key !== 'basic') {
    const { cardName = '', cardNumber = '', expiry = '', cvv = '' } = req.body;
    const cleanNumber = cardNumber.replace(/\s+/g, '');
    const expiryOk = /^[0-1][0-9]\/[0-9]{2}$/.test(expiry);
    const cardOk = /^\d{13,19}$/.test(cleanNumber);
    const cvvOk = /^\d{3,4}$/.test(cvv);
    if (!cardName.trim() || !cardOk || !expiryOk || !cvvOk) {
      req.flash('error', 'Please enter valid card details (name, number, expiry MM/YY, CVV).');
      return res.redirect(`/membership/payment?plan=${plan}&confirm=1`);
    }
  }

  // Update user's membership plan
  try {
    await UserModel.update(userId, { plan: selected.key });
    if (req.session.user) req.session.user.plan = selected.key;
    req.flash('success', `Your membership plan has been updated to ${selected.key.toUpperCase()}.`);
    return res.redirect(303, `/membership/payment?plan=${selected.key}&confirm=1`);
  } catch (err) {
    console.error('Unable to update membership:', err.message);
    req.flash('error', 'Could not update membership. Please try again.');
    return res.redirect('/membership/payment');
  }
}

// Admin user management
async function listUsers(req, res) {
  try {
    const users = await UserModel.list();
    res.render('adminUsers', { users, user: req.session.user });
  } catch (err) {
    console.error('Error listing users:', err.message);
    req.flash('error', 'Unable to load users right now.');
    res.redirect('/inventory');
  }
}

// Render edit user page
async function renderEditUser(req, res) {
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

// Update user details
async function updateUser(req, res) {
  const { username, email, address, contact, role, plan, disabled, loyaltyPoints } = req.body;
  const userId = req.params.id;

  if (!username || !email || !role || !isValidEmail(email) || !isValidRole(role) || !isValidPlan(plan || '')) {
    req.flash('error', 'Please provide a username, valid email, role (admin/user), and a valid plan (Basic/Silver/Gold).');
    return res.redirect(`/admin/users/${userId}/edit`);
  }

  try {
    const parsedPoints = typeof loyaltyPoints !== 'undefined' ? Number(loyaltyPoints) : undefined;
    const result = await UserModel.update(userId, {
      username,
      email,
      address: address || '',
      contact: contact || '',
      role,
      plan: plan || null,
      disabled: disabled === '1',
      loyaltyPoints: Number.isFinite(parsedPoints) ? parsedPoints : undefined
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

// Delete user (not allowed)
async function deleteUser(req, res) {
  const userId = req.params.id;
  req.flash('error', 'Deleting users is not allowed. Disable the account instead.');
  res.redirect('/admin/users');
}

// Toggle user disabled flag
async function toggleDisable(req, res) {
  const userId = req.params.id;
  const disabled = req.body.disabled === '1';
  try {
    await UserModel.update(userId, { disabled });
    req.flash('success', disabled ? 'User disabled.' : 'User enabled.');
  } catch (err) {
    console.error('Error updating user disabled flag:', err.message);
    req.flash('error', 'Unable to update user status.');
  }
  res.redirect('/admin/users');
}

module.exports = {
  renderLogin,
  renderRegister,
  renderLoyalty,
  register,
  login,
  logout,
  renderMembershipPayment,
  processMembershipPayment,
  listUsers,
  renderEditUser,
  updateUser,
  deleteUser,
  toggleDisable,
  resolveUserId,
  persistCart
};
