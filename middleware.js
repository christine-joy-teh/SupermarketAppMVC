const UserModel = require('./models/userModel');

async function attachSessionLocals(req, res, next) {
  let user = req.session.user || null;
  if (user && user.id) {
    try {
      const refreshed = await UserModel.getById(user.id);
      if (refreshed) {
        user = refreshed;
        req.session.user = user;
      }
    } catch (err) {
      console.error('Unable to refresh session user data:', err.message);
    }
  }

  const hasFraudWarning = user && user.fraud_warning_sent_at && !user.disabled;
  const reason = hasFraudWarning && user.fraud_warning_reason ? user.fraud_warning_reason : null;
  const fraudWarningMessage = hasFraudWarning
    ? `Your account has been flagged for suspicious activity${reason ? ` (${reason})` : ''}; one more violation will temporarily disable it.`
    : null;

  res.locals.user = user;
  res.locals.cartCount = req.session.cart
    ? req.session.cart.reduce((sum, item) => sum + (item.quantity || 0), 0)
    : 0;
  res.locals.success = req.flash('success');
  res.locals.error = req.flash('error');
  res.locals.warning = req.flash('warning');
  res.locals.fraudWarningMessage = fraudWarningMessage;
  next();
}

function checkAuthenticated(req, res, next) {
  if (req.session.user) {
    return next();
  }
  req.flash('error', 'Please log in to view this resource');
  return res.redirect('/login');
}

function checkAdmin(req, res, next) {
  if (req.session.user && req.session.user.role === 'admin') {
    return next();
  }
  req.flash('error', 'Access denied');
  return res.redirect('/shopping');
}

module.exports = {
  attachSessionLocals,
  checkAuthenticated,
  checkAdmin
};
