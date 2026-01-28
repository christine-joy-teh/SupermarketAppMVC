const orderController = require('./orderController');
const paypalClient = require('../services/paypalClient');
const netsClient = require('../services/netsClient');
const UserModel = require('../models/userModel');
const membershipPlans = require('../models/membershipPlans');
const TransactionLogModel = require('../models/transactionLogModel');

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

function syncSessionWalletBalance(user, nextBalance) {
  if (!user) return;
  if (typeof user.wallet_balance !== 'undefined' || typeof user.walletBalance === 'undefined') {
    user.wallet_balance = nextBalance;
  } else {
    user.walletBalance = nextBalance;
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

    const paymentUserId = orderController.resolveUserId ? orderController.resolveUserId(req.session.user) : null;
    if (paymentUserId) {
      await TransactionLogModel.createLog({
        userId: paymentUserId,
        actionType: 'PAYMENT',
        previousBalance: null,
        newBalance: null,
        referenceId: orderRecord.id
      });
    }

    req.session.cart = [];
    const userId = paymentUserId;
    let pointsMsg = '';
    if (userId && summary && summary.loyalty) {
      const pointsSpent = Number(summary.loyalty.pointsSpent) || 0;
      const pointsEarned = orderController.calculateLoyaltyPointsEarned(summary.totalAfter);
      const netDelta = pointsEarned - pointsSpent;
      const prevPoints = await UserModel.getLoyaltyPointsById(userId);
      const afterSpend = Math.max(0, Number(prevPoints || 0) - pointsSpent);
      const afterEarn = Math.max(0, afterSpend + pointsEarned);
      await UserModel.adjustLoyaltyPoints(userId, netDelta);
      const currentPoints = orderController.getUserPoints(req.session.user);
      const nextPoints = Math.max(0, currentPoints + netDelta);
      syncSessionPoints(req.session.user, nextPoints);
      if (pointsSpent > 0) {
        await TransactionLogModel.createLog({
          userId,
          actionType: 'POINT_SPEND',
          previousBalance: prevPoints,
          newBalance: afterSpend,
          referenceId: orderRecord.id
        });
      }
      if (pointsEarned > 0) {
        await TransactionLogModel.createLog({
          userId,
          actionType: 'POINT_EARN',
          previousBalance: afterSpend,
          newBalance: afterEarn,
          referenceId: orderRecord.id
        });
      }
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
    confirmAction: '/nets/confirm',
    hideConfirmButton: true,
    pollStatus: true,
    cancelUrl: '/payment',
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

    const paymentUserId = orderController.resolveUserId ? orderController.resolveUserId(req.session.user) : null;
    if (paymentUserId) {
      await TransactionLogModel.createLog({
        userId: paymentUserId,
        actionType: 'PAYMENT',
        previousBalance: null,
        newBalance: null,
        referenceId: orderRecord.id
      });
    }

    req.session.cart = [];
    req.session.pendingNetsOrder = null;

    const userId = paymentUserId;
    let pointsMsg = '';
    if (userId && summary && summary.loyalty) {
      const pointsSpent = Number(summary.loyalty.pointsSpent) || 0;
      const pointsEarned = orderController.calculateLoyaltyPointsEarned(summary.totalAfter);
      const netDelta = pointsEarned - pointsSpent;
      const prevPoints = await UserModel.getLoyaltyPointsById(userId);
      const afterSpend = Math.max(0, Number(prevPoints || 0) - pointsSpent);
      const afterEarn = Math.max(0, afterSpend + pointsEarned);
      await UserModel.adjustLoyaltyPoints(userId, netDelta);
      const currentPoints = orderController.getUserPoints(req.session.user);
      const nextPoints = Math.max(0, currentPoints + netDelta);
      syncSessionPoints(req.session.user, nextPoints);
      if (pointsSpent > 0) {
        await TransactionLogModel.createLog({
          userId,
          actionType: 'POINT_SPEND',
          previousBalance: prevPoints,
          newBalance: afterSpend,
          referenceId: orderRecord.id
        });
      }
      if (pointsEarned > 0) {
        await TransactionLogModel.createLog({
          userId,
          actionType: 'POINT_EARN',
          previousBalance: afterSpend,
          newBalance: afterEarn,
          referenceId: orderRecord.id
        });
      }
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
    const redirectUrl = `/orders/${orderRecord.id}/invoice`;
    const acceptsJson = req.headers && typeof req.headers.accept === 'string' && req.headers.accept.includes('application/json');
    if (acceptsJson || req.xhr) {
      return res.json({ success: true, redirect: redirectUrl });
    }
    return res.redirect(redirectUrl);
  } catch (err) {
    console.error('NETS confirm error:', err.message);
    req.flash('error', 'Unable to confirm NETS payment right now.');
    return res.redirect('/payment');
  }
}

function streamNetsPaymentStatus(req, res) {
  const txnRetrievalRef = req.params.txnRetrievalRef;
  if (!txnRetrievalRef) {
    return res.status(400).send('Missing txnRetrievalRef.');
  }
  const courseInitId = typeof netsClient.getCourseInitIdParam === 'function'
    ? netsClient.getCourseInitIdParam()
    : '';
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }
  let finished = false;
  let streamRequest = null;

  const sendEvent = (payload) => {
    if (finished) return;
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (writeErr) {
      console.error('Failed to send NETS SSE payload:', writeErr.message);
      cleanup();
    }
  };

  const cleanup = () => {
    if (finished) return;
    finished = true;
    if (streamRequest && !streamRequest.destroyed) {
      streamRequest.destroy();
    }
    if (timeoutId) clearTimeout(timeoutId);
    if (!res.writableEnded) {
      try {
        res.end();
      } catch (endErr) {
        console.error('NETS SSE cleanup error:', endErr.message);
      }
    }
  };

  const timeoutMs = Number(process.env.NETS_STATUS_STREAM_TIMEOUT_MS) || (4 * 60 * 1000);
  const timeoutId = setTimeout(() => {
    sendEvent({ error: 'NETS status timeout. Please confirm payment manually.' });
    cleanup();
  }, timeoutMs);

  streamRequest = netsClient.streamPaymentStatus(txnRetrievalRef, courseInitId, {
    onPayload: (payload) => {
      const status = netsClient.interpretPaymentStatus(payload);
      if (!status) {
        return;
      }
      if (status.success) {
        sendEvent({ success: true, status });
        cleanup();
      } else if (status.fail) {
        sendEvent({ fail: true, status });
        cleanup();
      }
    },
    onError: (err) => {
      sendEvent({ error: err && err.message ? err.message : 'Unable to receive NETS status updates.' });
      cleanup();
    },
    onEnd: () => {
      if (!finished) {
        sendEvent({ error: 'NETS status stream closed before confirmation.' });
        cleanup();
      }
    }
  });

  req.on('close', cleanup);
}

function resolveMembershipPlan(planRaw) {
  const plan = membershipPlans.getMembershipPlan(planRaw);
  if (!plan) {
    return { error: 'Invalid membership plan.' };
  }
  return { plan };
}

async function createMembershipPaypalOrder(req, res) {
  const { plan, error } = resolveMembershipPlan(req.body && req.body.plan);
  if (error) {
    return res.status(400).json({ error });
  }
  if (!membershipPlans.isPaidPlan(plan)) {
    return res.status(400).json({ error: 'No payment required for Basic plan.' });
  }

  try {
    const paypalOrder = await paypalClient.createOrder(Number(plan.amount).toFixed(2));
    return res.json(paypalOrder);
  } catch (err) {
    console.error('PayPal membership createOrder error:', err.message);
    return res.status(500).json({ error: 'Unable to create PayPal order.' });
  }
}

async function captureMembershipPaypalOrder(req, res) {
  const { orderId } = req.body || {};
  if (!orderId) {
    return res.status(400).json({ error: 'Missing PayPal order id.' });
  }
  const { plan, error } = resolveMembershipPlan(req.body && req.body.plan);
  if (error) {
    return res.status(400).json({ error });
  }
  if (!membershipPlans.isPaidPlan(plan)) {
    return res.status(400).json({ error: 'No payment required for Basic plan.' });
  }

  try {
    const capture = await paypalClient.captureOrder(orderId);
    if (!capture || (capture.status !== 'COMPLETED' && capture.status !== 'APPROVED')) {
      return res.status(400).json({ error: 'Payment not completed.' });
    }

    const userId = orderController.resolveUserId ? orderController.resolveUserId(req.session.user) : null;
    if (!userId) {
      return res.status(400).json({ error: 'User not found.' });
    }

    await UserModel.update(userId, { plan: plan.key });
    if (req.session.user) req.session.user.plan = plan.key;
    await TransactionLogModel.createLog({
      userId,
      actionType: 'PAYMENT',
      previousBalance: null,
      newBalance: null,
      referenceId: null
    });
    req.flash('success', `Your membership plan has been updated to ${plan.key.toUpperCase()}.`);
    return res.json({ success: true, redirect: `/membership/payment?plan=${plan.key}&confirm=1` });
  } catch (err) {
    console.error('PayPal membership capture error:', err.message);
    return res.status(500).json({ error: 'Unable to capture PayPal order.' });
  }
}

async function generateMembershipNetsQrCode(req, res) {
  const { plan, error } = resolveMembershipPlan(req.body && req.body.plan);
  if (error) {
    req.flash('error', error);
    return res.redirect('/membership/payment');
  }
  if (!membershipPlans.isPaidPlan(plan)) {
    req.flash('error', 'No payment required for Basic plan.');
    return res.redirect(`/membership/payment?plan=${plan.key}&confirm=1`);
  }

  req.session.pendingMembershipPayment = {
    plan: plan.key,
    amount: Number(plan.amount).toFixed(2)
  };

  req.netsViewData = {
    confirmAction: '/membership/nets/confirm',
    confirmLabel: 'I have completed NETS payment',
    cancelUrl: `/membership/payment?plan=${plan.key}&confirm=1`,
    pageTitle: 'NETS Membership Payment - Supermarket App',
    title: `Scan to Pay for ${plan.name}`
  };

  req.body.cartTotal = Number(plan.amount).toFixed(2);
  return netsClient.generateQrCode(req, res);
}

async function confirmMembershipNetsPayment(req, res) {
  const pending = req.session.pendingMembershipPayment || {};
  const { plan } = resolveMembershipPlan(pending.plan);
  if (!plan) {
    req.flash('error', 'Membership payment session expired. Please try again.');
    return res.redirect('/membership/payment');
  }

  try {
    const userId = orderController.resolveUserId ? orderController.resolveUserId(req.session.user) : null;
    if (!userId) {
      req.flash('error', 'User not found.');
      return res.redirect('/membership/payment');
    }

    await UserModel.update(userId, { plan: plan.key });
    if (req.session.user) req.session.user.plan = plan.key;
    req.session.pendingMembershipPayment = null;
    await TransactionLogModel.createLog({
      userId,
      actionType: 'PAYMENT',
      previousBalance: null,
      newBalance: null,
      referenceId: null
    });
    req.flash('success', `Your membership plan has been updated to ${plan.key.toUpperCase()}.`);
    return res.redirect(`/membership/payment?plan=${plan.key}&confirm=1`);
  } catch (err) {
    console.error('NETS membership confirm error:', err.message);
    req.flash('error', 'Unable to confirm NETS payment right now.');
    return res.redirect('/membership/payment');
  }
}

async function payMembershipWithWallet(req, res) {
  const { plan, error } = resolveMembershipPlan(req.body && req.body.plan);
  if (error) {
    req.flash('error', error);
    return res.redirect('/membership/payment');
  }
  if (!membershipPlans.isPaidPlan(plan)) {
    req.flash('error', 'No payment required for Basic plan.');
    return res.redirect(`/membership/payment?plan=${plan.key}&confirm=1`);
  }

  try {
    const userId = orderController.resolveUserId ? orderController.resolveUserId(req.session.user) : null;
    if (!userId) {
      req.flash('error', 'User not found.');
      return res.redirect('/membership/payment');
    }

    const amount = Number(plan.amount) || 0;
    const currentBalance = orderController.getUserWalletBalance
      ? orderController.getUserWalletBalance(req.session.user)
      : 0;
    if (currentBalance < amount) {
      req.flash('error', 'Insufficient wallet balance.');
      return res.redirect(`/membership/payment?plan=${plan.key}&confirm=1`);
    }

    await UserModel.adjustWalletBalance(userId, -amount);
    const nextBalance = Math.max(0, currentBalance - amount);
    syncSessionWalletBalance(req.session.user, nextBalance);
    await TransactionLogModel.createLog({
      userId,
      actionType: 'PAYMENT',
      previousBalance: currentBalance,
      newBalance: nextBalance,
      referenceId: null
    });

    await UserModel.update(userId, { plan: plan.key });
    if (req.session.user) req.session.user.plan = plan.key;
    req.flash('success', `Your membership plan has been updated to ${plan.key.toUpperCase()}.`);
    return res.redirect(`/membership/payment?plan=${plan.key}&confirm=1`);
  } catch (err) {
    console.error('Wallet membership payment error:', err.message);
    req.flash('error', 'Unable to process wallet payment right now.');
    return res.redirect('/membership/payment');
  }
}

function renderWalletTopupPage(req, res) {
  const walletBalance = orderController.getUserWalletBalance
    ? orderController.getUserWalletBalance(req.session.user)
    : 0;
  return res.render('walletTopup', {
    walletBalance,
    paypalClientId: process.env.PAYPAL_CLIENT_ID,
    user: req.session.user
  });
}

function resolveWalletTopupAmount(rawAmount) {
  const amount = Number(rawAmount);
  if (!Number.isFinite(amount) || amount < 10) {
    return { error: 'Minimum top-up amount is $10.' };
  }
  return { amount: Number(amount.toFixed(2)) };
}

async function createWalletTopupPaypalOrder(req, res) {
  const { amount, error } = resolveWalletTopupAmount(req.body && req.body.amount);
  if (error) {
    return res.status(400).json({ error });
  }

  try {
    const paypalOrder = await paypalClient.createOrder(amount.toFixed(2));
    return res.json(paypalOrder);
  } catch (err) {
    console.error('PayPal wallet top-up createOrder error:', err.message);
    return res.status(500).json({ error: 'Unable to create PayPal order.' });
  }
}

async function captureWalletTopupPaypalOrder(req, res) {
  const { orderId } = req.body || {};
  if (!orderId) {
    return res.status(400).json({ error: 'Missing PayPal order id.' });
  }
  const { amount, error } = resolveWalletTopupAmount(req.body && req.body.amount);
  if (error) {
    return res.status(400).json({ error });
  }

  try {
    const capture = await paypalClient.captureOrder(orderId);
    if (!capture || (capture.status !== 'COMPLETED' && capture.status !== 'APPROVED')) {
      return res.status(400).json({ error: 'Payment not completed.' });
    }

    const userId = orderController.resolveUserId ? orderController.resolveUserId(req.session.user) : null;
    if (!userId) {
      return res.status(400).json({ error: 'User not found.' });
    }

    await UserModel.adjustWalletBalance(userId, amount);
    const currentBalance = orderController.getUserWalletBalance(req.session.user);
    const nextBalance = Math.max(0, currentBalance + amount);
    syncSessionWalletBalance(req.session.user, nextBalance);
    await TransactionLogModel.createLog({
      userId,
      actionType: 'PAYMENT',
      previousBalance: currentBalance,
      newBalance: nextBalance,
      referenceId: null
    });
    req.flash('success', `Wallet topped up by $${amount.toFixed(2)}.`);
    return res.json({ success: true, redirect: '/wallet/topup' });
  } catch (err) {
    console.error('PayPal wallet top-up capture error:', err.message);
    return res.status(500).json({ error: 'Unable to capture PayPal order.' });
  }
}

async function generateWalletTopupNetsQrCode(req, res) {
  const { amount, error } = resolveWalletTopupAmount(req.body && req.body.amount);
  if (error) {
    req.flash('error', error);
    return res.redirect('/payment');
  }

  req.session.pendingWalletTopup = {
    amount: Number(amount).toFixed(2)
  };

  req.netsViewData = {
    autoConfirmAction: '/wallet/nets/confirm',
    autoConfirmDelayMs: 5000,
    hideConfirmButton: true,
    cancelUrl: '/payment',
    pageTitle: 'NETS Wallet Top-up - Supermarket App',
    title: 'Scan to Top Up Wallet'
  };

  req.body.cartTotal = Number(amount).toFixed(2);
  return netsClient.generateQrCode(req, res);
}

async function confirmWalletTopupNetsPayment(req, res) {
  const pending = req.session.pendingWalletTopup || {};
  const amount = Number(pending.amount || 0);
  if (!Number.isFinite(amount) || amount <= 0) {
    req.flash('error', 'Wallet top-up session expired. Please try again.');
    return res.redirect('/payment');
  }

  try {
    const userId = orderController.resolveUserId ? orderController.resolveUserId(req.session.user) : null;
    if (!userId) {
      req.flash('error', 'User not found.');
      return res.redirect('/payment');
    }

    await UserModel.adjustWalletBalance(userId, amount);
    const currentBalance = orderController.getUserWalletBalance(req.session.user);
    const nextBalance = Math.max(0, currentBalance + amount);
    syncSessionWalletBalance(req.session.user, nextBalance);
    req.session.pendingWalletTopup = null;
    await TransactionLogModel.createLog({
      userId,
      actionType: 'PAYMENT',
      previousBalance: currentBalance,
      newBalance: nextBalance,
      referenceId: null
    });
    req.flash('success', `Wallet topped up by $${amount.toFixed(2)}.`);
    return res.redirect('/wallet/topup');
  } catch (err) {
    console.error('NETS wallet top-up confirm error:', err.message);
    req.flash('error', 'Unable to confirm NETS top-up right now.');
    return res.redirect('/payment');
  }
}

async function payWithWallet(req, res) {
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
    const totalDue = Number(summary.totalAfter) || 0;

    const userId = orderController.resolveUserId ? orderController.resolveUserId(req.session.user) : null;
    if (!userId) {
      return res.status(400).json({ error: 'User not found.' });
    }

    const currentBalance = orderController.getUserWalletBalance(req.session.user);
    if (currentBalance < totalDue) {
      return res.status(400).json({ error: 'Insufficient wallet balance.' });
    }

    const { deliveryMethod, deliveryAddress, pickupOutlet } = req.body || {};
    const orderRecord = await orderController.placeOrderFromCart({
      cart,
      user: req.session.user,
      summary,
      status: 'processing',
      deliveryMethod: deliveryMethod || 'delivery',
      deliveryAddress: deliveryMethod === 'pickup' ? null : (deliveryAddress || null),
      pickupOutlet: deliveryMethod === 'pickup' ? (pickupOutlet || null) : null,
      paymentMethod: 'wallet'
    });

    await UserModel.adjustWalletBalance(userId, -totalDue);
    const nextBalance = Math.max(0, currentBalance - totalDue);
    syncSessionWalletBalance(req.session.user, nextBalance);
    await TransactionLogModel.createLog({
      userId,
      actionType: 'PAYMENT',
      previousBalance: currentBalance,
      newBalance: nextBalance,
      referenceId: orderRecord.id
    });

    req.session.cart = [];
    const pointsSpent = Number(summary.loyalty && summary.loyalty.pointsSpent) || 0;
    const pointsEarned = orderController.calculateLoyaltyPointsEarned(summary.totalAfter);
    const netDelta = pointsEarned - pointsSpent;
    const prevPoints = await UserModel.getLoyaltyPointsById(userId);
    const afterSpend = Math.max(0, Number(prevPoints || 0) - pointsSpent);
    const afterEarn = Math.max(0, afterSpend + pointsEarned);
    await UserModel.adjustLoyaltyPoints(userId, netDelta);
    const currentPoints = orderController.getUserPoints(req.session.user);
    const nextPoints = Math.max(0, currentPoints + netDelta);
    syncSessionPoints(req.session.user, nextPoints);
    if (pointsSpent > 0) {
      await TransactionLogModel.createLog({
        userId,
        actionType: 'POINT_SPEND',
        previousBalance: prevPoints,
        newBalance: afterSpend,
        referenceId: orderRecord.id
      });
    }
    if (pointsEarned > 0) {
      await TransactionLogModel.createLog({
        userId,
        actionType: 'POINT_EARN',
        previousBalance: afterSpend,
        newBalance: afterEarn,
        referenceId: orderRecord.id
      });
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
    const pointsMsg = pointsEarned > 0 || pointsSpent > 0
      ? ` You earned ${pointsEarned} points${pointsSpent ? ` and redeemed ${pointsSpent}` : ''}.`
      : '';
    req.flash('success', `Wallet payment completed. Order #${orderRecord.id} placed! Total: $${summary.totalAfter.toFixed(2)}${savingsMsg}.${pointsMsg}`);
    return res.json({ success: true, redirect: `/orders/${orderRecord.id}/invoice` });
  } catch (err) {
    console.error('Wallet payment error:', err.message);
    return res.status(500).json({ error: 'Unable to process wallet payment.' });
  }
}

module.exports = {
  createPaypalOrder,
  capturePaypalOrder,
  generateNetsQrCode,
  confirmNetsPayment,
  streamNetsPaymentStatus,
  renderWalletTopupPage,
  createMembershipPaypalOrder,
  captureMembershipPaypalOrder,
  generateMembershipNetsQrCode,
  confirmMembershipNetsPayment,
  payMembershipWithWallet,
  createWalletTopupPaypalOrder,
  captureWalletTopupPaypalOrder,
  generateWalletTopupNetsQrCode,
  confirmWalletTopupNetsPayment,
  payWithWallet
};
