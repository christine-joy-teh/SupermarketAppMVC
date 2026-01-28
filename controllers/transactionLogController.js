const TransactionLogModel = require('../models/transactionLogModel');

async function renderAdminLogs(req, res) {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = 20;
    const total = await TransactionLogModel.countAll();
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const safePage = Math.min(page, totalPages);
    const offset = (safePage - 1) * perPage;
    const logs = await TransactionLogModel.listAllPaged(perPage, offset);
    res.render('adminTransactionLogs', {
      logs,
      user: req.session.user,
      pagination: {
        page: safePage,
        totalPages
      }
    });
  } catch (err) {
    console.error('Error loading transaction logs:', err.message);
    req.flash('error', 'Unable to load transaction logs right now.');
    res.redirect('/admin/orders');
  }
}

module.exports = {
  renderAdminLogs
};
