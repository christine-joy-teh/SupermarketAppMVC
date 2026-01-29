const TransactionLogModel = require('../models/transactionLogModel');

async function checkFraud(req, res) {
  try {
    const payload = req.body || {};
    const result = await TransactionLogModel.evaluateSuspiciousRules(payload);
    return res.json(result);
  } catch (err) {
    console.error('Fraud check error:', err.message);
    return res.status(200).json({ suspicious: false, reason: null });
  }
}

module.exports = { checkFraud };
