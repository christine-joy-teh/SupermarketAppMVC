const path = require('path');
const OrderModel = require('../models/orderModel');
const RefundModel = require('../models/refundModel');
const paypalClient = require('../services/paypalClient');
const UserModel = require('../models/userModel');
const orderController = require('./orderController');

function resolveUserId(user) {
  return (orderController && orderController.resolveUserId)
    ? orderController.resolveUserId(user)
    : (user && (user.id || user.userId || user.user_id || user.userID)) || null;
}

function resolveRefundPayment(order) {
  const method = (order && order.paymentMethod ? String(order.paymentMethod).toLowerCase() : '');
  if (method === 'paypal' && order.paymentRef) {
    return { method: 'paypal', label: 'PayPal' };
  }
  if (method === 'wallet') {
    return { method: 'wallet', label: 'E-wallet' };
  }
  return null;
}

async function renderRefundRequest(req, res) {
  const orderId = Number(req.query.orderId);
  if (!Number.isFinite(orderId)) {
    req.flash('error', 'Invalid order.');
    return res.redirect('/orders/history');
  }

  try {
    const order = await OrderModel.getOrderById(orderId);
    if (!order) {
      req.flash('error', 'Order not found.');
      return res.redirect('/orders/history');
    }

    const userId = resolveUserId(req.session.user);
    const canView = userId && order.userId && Number(order.userId) === Number(userId);
    if (!canView) {
      req.flash('error', 'You are not authorized to request a refund for this order.');
      return res.redirect('/orders/history');
    }

    if (!resolveRefundPayment(order)) {
      req.flash('error', 'Refunds are only available for PayPal or E-wallet payments.');
      return res.redirect('/orders/history');
    }

    const existing = await RefundModel.getByOrderId(orderId);
    const blocked = existing.find(r => r.status === 'pending' || r.status === 'approved');
    if (blocked) {
      req.flash('error', 'A refund request already exists for this order.');
      return res.redirect('/orders/history');
    }

    res.render('refundRequest', { order, user: req.session.user });
  } catch (err) {
    console.error('Error loading refund request:', err.message);
    req.flash('error', 'Unable to load refund request.');
    res.redirect('/orders/history');
  }
}

async function submitRefundRequest(req, res) {
  const orderId = Number(req.body.orderId);
  const reason = (req.body.reason || '').trim();
  if (!Number.isFinite(orderId) || !reason) {
    req.flash('error', 'Please provide a reason for your refund request.');
    return res.redirect(`/refunds/new?orderId=${orderId || ''}`);
  }

  try {
    const order = await OrderModel.getOrderById(orderId);
    if (!order) {
      req.flash('error', 'Order not found.');
      return res.redirect('/orders/history');
    }

    const userId = resolveUserId(req.session.user);
    if (!userId || Number(order.userId) !== Number(userId)) {
      req.flash('error', 'You are not authorized to request a refund for this order.');
      return res.redirect('/orders/history');
    }

    if (!resolveRefundPayment(order)) {
      req.flash('error', 'Refunds are only available for PayPal or E-wallet payments.');
      return res.redirect('/orders/history');
    }

    const existing = await RefundModel.getByOrderId(orderId);
    const blocked = existing.find(r => r.status === 'pending' || r.status === 'approved');
    if (blocked) {
      req.flash('error', 'A refund request already exists for this order.');
      return res.redirect('/orders/history');
    }

    const documentPath = req.file ? `/refunds/${path.basename(req.file.path)}` : null;
    await RefundModel.createRefund({
      orderId,
      userId,
      reason,
      documentPath
    });
    req.flash('success', 'Refund request submitted.');
    res.redirect('/orders/history');
  } catch (err) {
    console.error('Error submitting refund request:', err.message);
    req.flash('error', 'Unable to submit refund request.');
    res.redirect('/orders/history');
  }
}

async function renderAdminRefunds(req, res) {
  try {
    const refunds = await RefundModel.listAll();
    res.render('adminRefunds', { refunds, user: req.session.user });
  } catch (err) {
    console.error('Error loading refunds:', err.message);
    req.flash('error', 'Unable to load refunds right now.');
    res.redirect('/admin/orders');
  }
}

async function approveRefund(req, res) {
  const refundId = Number(req.params.id);
  const adminNote = (req.body.adminNote || '').trim();
  if (!Number.isFinite(refundId)) {
    req.flash('error', 'Invalid refund request.');
    return res.redirect('/admin/refunds');
  }

  try {
    const refund = await RefundModel.getById(refundId);
    if (!refund) {
      req.flash('error', 'Refund request not found.');
      return res.redirect('/admin/refunds');
    }
    if (refund.status !== 'pending') {
      req.flash('error', 'Refund request already processed.');
      return res.redirect('/admin/refunds');
    }

    const order = await OrderModel.getOrderById(refund.orderId);
    const payment = resolveRefundPayment(order);
    if (!order || !payment) {
      req.flash('error', 'This order is not eligible for a refund.');
      return res.redirect('/admin/refunds');
    }

    const amountValue = Number(order.total || 0);
    if (!Number.isFinite(amountValue) || amountValue <= 0) {
      req.flash('error', 'Invalid refund amount.');
      return res.redirect('/admin/refunds');
    }

    if (payment.method === 'paypal') {
      await paypalClient.refundCapture(order.paymentRef, amountValue.toFixed(2));
    } else if (payment.method === 'wallet') {
      await UserModel.adjustWalletBalance(order.userId, amountValue);
    }

    await RefundModel.updateStatus(refundId, { status: 'approved', adminNote });
    req.flash('success', `Refund approved for order #${refund.orderId}.`);
    res.redirect('/admin/refunds');
  } catch (err) {
    console.error('Error approving refund:', err.message);
    req.flash('error', 'Unable to approve refund.');
    res.redirect('/admin/refunds');
  }
}

async function denyRefund(req, res) {
  const refundId = Number(req.params.id);
  const adminNote = (req.body.adminNote || '').trim();
  if (!Number.isFinite(refundId)) {
    req.flash('error', 'Invalid refund request.');
    return res.redirect('/admin/refunds');
  }

  try {
    const refund = await RefundModel.getById(refundId);
    if (!refund) {
      req.flash('error', 'Refund request not found.');
      return res.redirect('/admin/refunds');
    }
    if (refund.status !== 'pending') {
      req.flash('error', 'Refund request already processed.');
      return res.redirect('/admin/refunds');
    }

    await RefundModel.updateStatus(refundId, { status: 'denied', adminNote });
    req.flash('success', `Refund denied for order #${refund.orderId}.`);
    res.redirect('/admin/refunds');
  } catch (err) {
    console.error('Error denying refund:', err.message);
    req.flash('error', 'Unable to deny refund.');
    res.redirect('/admin/refunds');
  }
}

module.exports = {
  renderRefundRequest,
  submitRefundRequest,
  renderAdminRefunds,
  approveRefund,
  denyRefund
};
