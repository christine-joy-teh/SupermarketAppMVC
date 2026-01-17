const orderController = require('./orderController');
const paypalClient = require('../services/paypalClient');
const netsClient = require('../services/netsClient');
const UserModel = require('../models/userModel');

function resolveLoyaltyRedeemPoints(req) {
  const rawPoints = req.body && typeof req.body.loyaltyRedeemPoints !== 'undefined'
    ? req.body.loyaltyRedeemPoints
    : (req.session && req.session.loyaltyRedeemPoints);
  const points = orderController.normalizeRedeemPoints(rawPoints);
  if (req.session) {
    req.session.loyaltyRedeemPoints = points;
  }
  return points;
}

function syncSessionPoints(user, nextPoints) {
  if (!user) return;
  if (typeof user.loyalty_points !== 'undefined' || typeof user.loyaltyPoints === 'undefined') {
    user.loyalty_points = nextPoints;
  } else {
    user.loyaltyPoints = nextPoints;
  }
}

async function createPaypalOrder(req, res) {
  const cart = req.session.cart || [];
  if (!cart.length) {
    return res.status(400).json({ error: 'Your cart is empty.' });
  }

  const validation = await orderController.validateCart(cart);
  if (!validation.ok) {
    return res.status(400).json({ error: validation.message });
  }

  try {
    const loyaltyRedeemPoints = resolveLoyaltyRedeemPoints(req);
    const membershipInfo = orderController.getMembershipBenefit(req.session.user);
    const loyalty = orderController.buildLoyaltyContext(req.session.user, loyaltyRedeemPoints);
    const summary = orderController.summarizeCart(cart, membershipInfo, loyalty);
    const paypalOrder = await paypalClient.createOrder(summary.totalAfter.toFixed(2));
    return res.json(paypalOrder);
  } catch (err) {
    console.error('PayPal createOrder error:', err.message);
    return res.status(500).json({ error: 'Unable to create PayPal order.' });
  }
}

async function capturePaypalOrder(req, res) {
  const { orderId, deliveryMethod, deliveryAddress, pickupOutlet } = req.body || {};
  if (!orderId) {
    return res.status(400).json({ error: 'Missing PayPal order id.' });
  }

  try {
    const capture = await paypalClient.captureOrder(orderId);
    if (!capture || (capture.status !== 'COMPLETED' && capture.status !== 'APPROVED')) {
      return res.status(400).json({ error: 'Payment not completed.' });
    }

    const cart = req.session.cart || [];
    if (!cart.length) {
      return res.status(400).json({ error: 'Your cart is empty.' });
    }

    const validation = await orderController.validateCart(cart);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.message });
    }

    const loyaltyRedeemPoints = resolveLoyaltyRedeemPoints(req);
    const membershipInfo = orderController.getMembershipBenefit(req.session.user);
    const loyalty = orderController.buildLoyaltyContext(req.session.user, loyaltyRedeemPoints);
    const summary = orderController.summarizeCart(cart, membershipInfo, loyalty);
    const captureId = capture && capture.purchase_units && capture.purchase_units[0] &&
      capture.purchase_units[0].payments && capture.purchase_units[0].payments.captures &&
      capture.purchase_units[0].payments.captures[0]
      ? capture.purchase_units[0].payments.captures[0].id
      : (capture && capture.id ? capture.id : null);
    const orderRecord = await orderController.placeOrderFromCart({
      cart,
      user: req.session.user,
      summary,
      status: 'processing',
      deliveryMethod: deliveryMethod || 'delivery',
      deliveryAddress: deliveryMethod === 'pickup' ? null : (deliveryAddress || null),
      pickupOutlet: deliveryMethod === 'pickup' ? (pickupOutlet || null) : null,
      paymentMethod: 'paypal',
      paymentRef: captureId
    });

    req.session.cart = [];
    const userId = orderController.resolveUserId ? orderController.resolveUserId(req.session.user) : null;
    let pointsMsg = '';
    if (userId && summary && summary.loyalty) {
      const pointsSpent = Number(summary.loyalty.pointsSpent) || 0;
      const pointsEarned = orderController.calculateLoyaltyPointsEarned(summary.totalAfter);
      const netDelta = pointsEarned - pointsSpent;
      await UserModel.adjustLoyaltyPoints(userId, netDelta);
      const currentPoints = orderController.getUserPoints(req.session.user);
      const nextPoints = Math.max(0, currentPoints + netDelta);
      syncSessionPoints(req.session.user, nextPoints);
      if (pointsEarned > 0 || pointsSpent > 0) {
        pointsMsg = ` You earned ${pointsEarned} points${pointsSpent ? ` and redeemed ${pointsSpent}` : ''}.`;
      }
    }
    let savingsMsg = '';
    if (summary.totalSavings > 0) {
      const promoPart = summary.promoSavings > 0 ? `promo $${summary.promoSavings.toFixed(2)}` : '';
      const memberPart = summary.membership && summary.membership.savings > 0
        ? `membership $${summary.membership.savings.toFixed(2)}`
        : '';
      const loyaltyPart = summary.loyalty && summary.loyalty.savings > 0
        ? `loyalty $${summary.loyalty.savings.toFixed(2)}`
        : '';
      const parts = [promoPart, memberPart, loyaltyPart].filter(Boolean).join(' + ');
      savingsMsg = ` (you saved $${summary.totalSavings.toFixed(2)}${parts ? `: ${parts}` : ''})`;
    }
    req.flash('success', `Payment completed. Order #${orderRecord.id} placed! Total: $${summary.totalAfter.toFixed(2)}${savingsMsg}.${pointsMsg}`);
    return res.json({ success: true, orderId: orderRecord.id, redirect: `/orders/${orderRecord.id}/invoice` });
  } catch (err) {
    console.error('PayPal captureOrder error:', err.message);
    return res.status(500).json({ error: 'Unable to capture PayPal order.' });
  }
}

async function generateNetsQrCode(req, res) {
  const cart = req.session.cart || [];
  const validation = await orderController.validateCart(cart);
  if (!validation.ok) {
    req.flash('error', validation.message);
    return res.redirect('/payment');
  }

    const loyaltyRedeemPoints = resolveLoyaltyRedeemPoints(req);
    const membershipInfo = orderController.getMembershipBenefit(req.session.user);
    const loyalty = orderController.buildLoyaltyContext(req.session.user, loyaltyRedeemPoints);
    const summary = orderController.summarizeCart(cart, membershipInfo, loyalty);
    req.session.pendingNetsOrder = {
    loyaltyRedeemPoints,
    deliveryMethod: req.body && req.body.deliveryMethod ? String(req.body.deliveryMethod) : 'delivery',
    deliveryAddress: req.body && req.body.deliveryAddress ? String(req.body.deliveryAddress) : '',
    pickupOutlet: req.body && req.body.pickupOutlet ? String(req.body.pickupOutlet) : ''
  };
  req.netsViewData = {
    loyaltyRedeemPoints,
    pointsAvailable: loyalty.pointsAvailable
  };
  req.body.cartTotal = summary.totalAfter.toFixed(2);
  return netsClient.generateQrCode(req, res);
}

async function confirmNetsPayment(req, res) {
  const cart = req.session.cart || [];
  if (!cart.length) {
    req.flash('error', 'Your cart is empty.');
    return res.redirect('/cart');
  }

  const validation = await orderController.validateCart(cart);
  if (!validation.ok) {
    req.flash('error', validation.message);
    return res.redirect('/payment');
  }

  try {
    const pending = req.session.pendingNetsOrder || {};
    const loyaltyRedeemPoints = orderController.normalizeRedeemPoints(
      req.body && typeof req.body.loyaltyRedeemPoints !== 'undefined'
        ? req.body.loyaltyRedeemPoints
        : pending.loyaltyRedeemPoints
    );
    const membershipInfo = orderController.getMembershipBenefit(req.session.user);
    const loyalty = orderController.buildLoyaltyContext(req.session.user, loyaltyRedeemPoints);
    const summary = orderController.summarizeCart(cart, membershipInfo, loyalty);
    const deliveryMethod = pending.deliveryMethod || 'delivery';
    const deliveryAddress = deliveryMethod === 'pickup' ? null : (pending.deliveryAddress || null);
    const pickupOutlet = deliveryMethod === 'pickup' ? (pending.pickupOutlet || null) : null;
    const orderRecord = await orderController.placeOrderFromCart({
      cart,
      user: req.session.user,
      summary,
      status: 'processing',
      deliveryMethod,
      deliveryAddress,
      pickupOutlet,
      paymentMethod: 'nets'
    });

    req.session.cart = [];
    req.session.pendingNetsOrder = null;

    const userId = orderController.resolveUserId ? orderController.resolveUserId(req.session.user) : null;
    let pointsMsg = '';
    if (userId && summary && summary.loyalty) {
      const pointsSpent = Number(summary.loyalty.pointsSpent) || 0;
      const pointsEarned = orderController.calculateLoyaltyPointsEarned(summary.totalAfter);
      const netDelta = pointsEarned - pointsSpent;
      await UserModel.adjustLoyaltyPoints(userId, netDelta);
      const currentPoints = orderController.getUserPoints(req.session.user);
      const nextPoints = Math.max(0, currentPoints + netDelta);
      syncSessionPoints(req.session.user, nextPoints);
      if (pointsEarned > 0 || pointsSpent > 0) {
        pointsMsg = ` You earned ${pointsEarned} points${pointsSpent ? ` and redeemed ${pointsSpent}` : ''}.`;
      }
    }

    let savingsMsg = '';
    if (summary.totalSavings > 0) {
      const promoPart = summary.promoSavings > 0 ? `promo $${summary.promoSavings.toFixed(2)}` : '';
      const memberPart = summary.membership && summary.membership.savings > 0
        ? `membership $${summary.membership.savings.toFixed(2)}`
        : '';
      const loyaltyPart = summary.loyalty && summary.loyalty.savings > 0
        ? `loyalty $${summary.loyalty.savings.toFixed(2)}`
        : '';
      const parts = [promoPart, memberPart, loyaltyPart].filter(Boolean).join(' + ');
      savingsMsg = ` (you saved $${summary.totalSavings.toFixed(2)}${parts ? `: ${parts}` : ''})`;
    }
    req.flash('success', `NETS payment completed. Order #${orderRecord.id} placed! Total: $${summary.totalAfter.toFixed(2)}${savingsMsg}.${pointsMsg}`);
    return res.redirect(`/orders/${orderRecord.id}/invoice`);
  } catch (err) {
    console.error('NETS confirm error:', err.message);
    req.flash('error', 'Unable to confirm NETS payment right now.');
    return res.redirect('/payment');
  }
}

module.exports = {
  createPaypalOrder,
  capturePaypalOrder,
  generateNetsQrCode,
  confirmNetsPayment
};
