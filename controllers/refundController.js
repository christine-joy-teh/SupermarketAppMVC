const path = require('path');
const OrderModel = require('../models/orderModel');
const RefundModel = require('../models/refundModel');
const UserModel = require('../models/userModel');
const TransactionLogModel = require('../models/transactionLogModel');
const orderController = require('./orderController');
const paypalClient = require('../services/paypalClient');

function resolveUserId(user) {
  return (orderController && orderController.resolveUserId)
    ? orderController.resolveUserId(user)
    : (user && (user.id || user.userId || user.user_id || user.userID)) || null;
}

function isRefundEligible(order) {
  if (!order) return false;
  const amountValue = Number(order.total || 0);
  return Number.isFinite(amountValue) && amountValue > 0;
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

    const confirmedAt = await OrderModel.getConfirmedPurchaseTimeById(orderId);
    if (confirmedAt) {
      const confirmedTime = new Date(confirmedAt).getTime();
      const nowTime = Date.now();
      if (Number.isFinite(confirmedTime) && (nowTime - confirmedTime) > (30 * 60 * 1000)) {
        req.flash('error', 'Refund requests can only be made within 30 minutes after purchase confirmation.');
        return res.redirect('/orders/history');
      }
    }

    if (!isRefundEligible(order)) {
      req.flash('error', 'This order is not eligible for a refund.');
      return res.redirect('/orders/history');
    }

    const existing = await RefundModel.getByOrderId(orderId);
    const blocked = existing.find(r => r.status === 'pending' || r.status === 'approved');
    if (blocked) {
      req.flash('error', 'A refund request already exists for this order.');
      return res.redirect('/orders/history');
    }

    let orderItems = [];
    try {
      await OrderModel.ensureOrderItemsForOrder(orderId, order.items || []);
      orderItems = await OrderModel.getOrderItemsByOrderId(orderId);
      const refundedMap = await RefundModel.getApprovedRefundedQtyByOrderItemIds(orderItems.map(i => i.id));
      orderItems = orderItems.map(item => {
        const approvedRefunded = refundedMap[item.id] || 0;
        const trackedRefunded = Number(item.refunded_qty) || 0;
        const refundedQty = Math.max(approvedRefunded, trackedRefunded);
        const availableQty = Math.max(0, Number(item.qty) - refundedQty);
        return { ...item, refundedQty, availableQty };
      });
    } catch (err) {
      console.warn('Unable to load order items for refund request:', err.message);
    }

    res.render('refundRequest', { order, orderItems, user: req.session.user });
  } catch (err) {
    console.error('Error loading refund request:', err.message);
    req.flash('error', 'Unable to load refund request.');
    res.redirect('/orders/history');
  }
}

function parseRefundItemsPayload(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    } catch (err) {
      return [];
    }
  }
  return [];
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

    const flaggedUntil = await UserModel.getRefundFlagUntilById(userId);
    if (flaggedUntil && new Date(flaggedUntil) > new Date()) {
      req.flash(
        'error',
        `Your account is currently flagged due to unusually frequent refund requests. Refunds will be available again after ${new Date(flaggedUntil).toLocaleString()}.`
      );
      return res.redirect('/orders/history');
    }

    if (!isRefundEligible(order)) {
      req.flash('error', 'This order is not eligible for a refund.');
      return res.redirect('/orders/history');
    }

    const existing = await RefundModel.getByOrderId(orderId);
    const blocked = existing.find(r => r.status === 'pending' || r.status === 'approved');
    if (blocked) {
      req.flash('error', 'A refund request already exists for this order.');
      return res.redirect('/orders/history');
    }

    const documentPath = req.file ? `/refunds/${path.basename(req.file.path)}` : null;

    await OrderModel.ensureOrderItemsForOrder(orderId, order.items || []);
    const orderItems = await OrderModel.getOrderItemsByOrderId(orderId);
    const refundedMap = await RefundModel.getApprovedRefundedQtyByOrderItemIds(orderItems.map(i => i.id));
    const orderItemsById = orderItems.reduce((acc, item) => {
      const approvedRefunded = refundedMap[item.id] || 0;
      const trackedRefunded = Number(item.refunded_qty) || 0;
      const refundedQty = Math.max(approvedRefunded, trackedRefunded);
      acc[item.id] = { ...item, refundedQty };
      return acc;
    }, {});

    const rawItems = parseRefundItemsPayload(req.body.refundItems || req.body.items);
    const normalizedItems = rawItems.map(item => ({
      orderItemId: Number(item.orderItemId || item.id || item.order_item_id),
      refundQty: Number(item.refundQty || item.qty || item.refund_qty)
    })).filter(item => Number.isFinite(item.orderItemId) && Number.isFinite(item.refundQty) && item.refundQty > 0);

    let refundItems = [];
    let totalAmount = 0;
    if (normalizedItems.length) {
      for (const item of normalizedItems) {
        const orderItem = orderItemsById[item.orderItemId];
        if (!orderItem) {
          req.flash('error', 'Selected refund item is invalid.');
          return res.redirect(`/refunds/new?orderId=${orderId}`);
        }
        const maxQty = Math.max(0, Number(orderItem.qty) - Number(orderItem.refundedQty || 0));
        if (!Number.isFinite(item.refundQty) || item.refundQty <= 0 || item.refundQty > maxQty) {
          req.flash('error', 'Refund quantity exceeds available quantity for an item.');
          return res.redirect(`/refunds/new?orderId=${orderId}`);
        }
        const unitPrice = Number(orderItem.unit_price || 0);
        const refundAmount = Number((unitPrice * item.refundQty).toFixed(2));
        refundItems.push({
          orderItemId: orderItem.id,
          refundQty: item.refundQty,
          refundAmount
        });
        totalAmount += refundAmount;
      }
    } else {
      totalAmount = Number(order.total || 0);
    }

    if (!Number.isFinite(totalAmount) || totalAmount <= 0) {
      req.flash('error', 'Invalid refund amount.');
      return res.redirect(`/refunds/new?orderId=${orderId}`);
    }

    const destinationRaw = (req.body.refundDestination || '').toString().toUpperCase();
    const destination = destinationRaw === 'ORIGINAL_METHOD' ? 'ORIGINAL_METHOD' : 'E_WALLET';
    const refundId = await RefundModel.createRefund({
      orderId,
      userId,
      reason,
      documentPath,
      totalAmount,
      destination
    });

    if (refundItems.length) {
      await RefundModel.createRefundItems(refundId, refundItems);
    }

    const recentCount = await RefundModel.countRecentByUserId(userId, 24);
    if (recentCount >= 3) {
      await RefundModel.updateStatus(refundId, { status: 'flagged', adminNote: 'Auto-flagged due to frequent refunds.' });
      const flaggedUntilDate = new Date(Date.now() + (60 * 1000));
      await UserModel.setRefundFlagUntil(userId, flaggedUntilDate);
    }

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
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = 20;
    const total = await RefundModel.countAll();
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const safePage = Math.min(page, totalPages);
    const offset = (safePage - 1) * perPage;
    const refunds = await RefundModel.listAllPaged(perPage, offset);
    res.render('adminRefunds', {
      refunds,
      user: req.session.user,
      pagination: {
        page: safePage,
        totalPages
      }
    });
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
    if (!isRefundEligible(order)) {
      req.flash('error', 'This order is not eligible for a refund.');
      return res.redirect('/admin/refunds');
    }

    const amountValue = Number(refund.total_amount || order.total || 0);
    if (!Number.isFinite(amountValue) || amountValue <= 0) {
      req.flash('error', 'Invalid refund amount.');
      return res.redirect('/admin/refunds');
    }

    const refundUserId = order.userId;
    const destination = (refund.destination || 'E_WALLET').toUpperCase();
    const paymentMethod = (order.paymentMethod || '').toLowerCase();
    let appliedToWallet = true;

    if (destination === 'ORIGINAL_METHOD' && paymentMethod === 'paypal' && order.paymentRef) {
      await paypalClient.refundCapture(order.paymentRef, amountValue.toFixed(2));
      appliedToWallet = false;
    }

    if (destination === 'ORIGINAL_METHOD' && paymentMethod === 'wallet') {
      appliedToWallet = true;
    }

    if (appliedToWallet) {
      const prevWallet = await UserModel.getWalletBalanceById(refundUserId);
      await UserModel.adjustWalletBalance(refundUserId, amountValue);
      const nextWallet = Math.max(0, Number(prevWallet || 0) + amountValue);
      await TransactionLogModel.createLog({
        userId: refundUserId,
        actionType: 'REFUND',
        previousBalance: prevWallet,
        newBalance: nextWallet,
        referenceId: refund.id
      });
    }

    const refundItems = await RefundModel.getRefundItemsByRefundId(refundId);
    if (refundItems.length) {
      for (const item of refundItems) {
        await OrderModel.addRefundedQty(item.order_item_id, item.refund_qty);
      }
    } else {
      await OrderModel.ensureOrderItemsForOrder(order.id, order.items || []);
      await OrderModel.markOrderItemsFullyRefunded(order.id);
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
