function attachSessionLocals(req, res, next) {
  res.locals.user = req.session.user || null;
  res.locals.cartCount = req.session.cart
    ? req.session.cart.reduce((sum, item) => sum + (item.quantity || 0), 0)
    : 0;
  res.locals.success = req.flash('success');
  res.locals.error = req.flash('error');
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
