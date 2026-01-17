const OrderModel = require('../models/orderModel');
const ProductModel = require('../models/productModel');
const UserModel = require('../models/userModel');
const RefundModel = require('../models/refundModel');

// Promotion configuration (editable by admin at runtime)
let promotionConfig = {
  keywords: ['milk', 'yogurt', 'cheese', 'butter', 'dairy'],
  percent: 10
};

const loyaltyConfig = {
  earnRate: 10,
  discountRate: 0.1,
  maxRedemptionPercent: 50,
  freeItem: { pointsCost: 100, value: 2 },
  exclusivePromo: { pointsCost: 500, percent: 5 }
};


function getMembershipBenefit(user) {
  const planRaw = user && user.plan ? String(user.plan).toLowerCase() : '';
  if (planRaw === 'gold') return { membershipPercent: 10, membershipPlan: 'gold' };
  if (planRaw === 'silver') return { membershipPercent: 5, membershipPlan: 'silver' };
  return { membershipPercent: 0, membershipPlan: planRaw || '' };
}

function getUserPoints(user) {
  if (!user) return 0;
  const raw = typeof user.loyalty_points !== 'undefined' ? user.loyalty_points : user.loyaltyPoints;
  const points = Number(raw);
  return Number.isFinite(points) ? points : 0;
}

function normalizeRedeemPoints(redeemPoints) {
  const raw = Math.max(0, Math.floor(Number(redeemPoints) || 0));
  return Math.floor(raw / 10) * 10;
}

function buildLoyaltyContext(user, redeemPoints) {
  return {
    user,
    redeemPoints: normalizeRedeemPoints(redeemPoints),
    pointsAvailable: getUserPoints(user)
  };
}

function calculateLoyaltyRedemption(totalAfter, pointsAvailable, redeemPoints) {
  const safeTotal = Math.max(Number(totalAfter) || 0, 0);
  const points = Math.max(Math.floor(Number(pointsAvailable) || 0), 0);
  const maxByPercentPoints = Math.floor(
    (safeTotal * (loyaltyConfig.maxRedemptionPercent / 100)) / loyaltyConfig.discountRate
  );
  const maxAllowedPoints = Math.max(0, Math.min(points, maxByPercentPoints));
  const maxAllowedTens = Math.floor(maxAllowedPoints / 10) * 10;
  const desiredPoints = Math.min(normalizeRedeemPoints(redeemPoints), maxAllowedTens);
  let savings = 0;
  let pointsSpent = 0;
  let rewardLabel = '';

  if (desiredPoints > 0 && points > 0) {
    const usablePoints = Math.min(points, desiredPoints);
    const maxByPercent = safeTotal * (loyaltyConfig.maxRedemptionPercent / 100);
    const maxByPoints = usablePoints * loyaltyConfig.discountRate;
    savings = Math.min(maxByPercent, maxByPoints, safeTotal);
    pointsSpent = Math.min(usablePoints, Math.floor(savings / loyaltyConfig.discountRate));
    rewardLabel = 'Points discount';
  }

  return { pointsSpent, savings, rewardLabel, maxRedeemPoints: maxAllowedTens };
}

function calculateLoyaltyPointsEarned(amountPaid) {
  const total = Math.max(Number(amountPaid) || 0, 0);
  return Math.floor(total * loyaltyConfig.earnRate);
}

function resolveUserId(user) {
  if (!user) return null;
  return user.id || user.userId || user.user_id || user.userID || null;
}

function summarizeCart(cart = [], { membershipPercent = 0, membershipPlan = '' } = {}, loyalty = {}) {
  let totalBefore = 0;
  let matchTotal = 0;

  cart.forEach(item => {
    const name = (item.productName || '').toLowerCase();
    const price = parseFloat(item.price) || 0;
    const qty = parseInt(item.quantity, 10) || 0;
    totalBefore += price * qty;
    const isPromoItem = promotionConfig.keywords.some(k => name.includes(k));
    if (isPromoItem) matchTotal += price * qty;
  });

  const percent = Number(promotionConfig.percent) || 0;
  const promoSavings = percent > 0 ? (matchTotal * (percent / 100)) : 0;

  const membershipPct = Number(membershipPercent) > 0 ? Number(membershipPercent) : 0;
  const membershipSavings = membershipPct > 0 ? (Math.max(totalBefore - promoSavings, 0) * (membershipPct / 100)) : 0;

  const totalAfter = Math.max(totalBefore - promoSavings - membershipSavings, 0);
  const pointsAvailable = typeof loyalty.pointsAvailable !== 'undefined'
    ? Number(loyalty.pointsAvailable) || 0
    : getUserPoints(loyalty.user);
    const redemption = calculateLoyaltyRedemption(totalAfter, pointsAvailable, loyalty.redeemPoints);
    const totalAfterLoyalty = Math.max(totalAfter - redemption.savings, 0);
    const totalSavings = (promoSavings || 0) + (membershipSavings || 0) + (redemption.savings || 0);
    const pointsEarned = calculateLoyaltyPointsEarned(totalAfterLoyalty);
    return {
    totalBefore,
    totalAfter: totalAfterLoyalty,
    totalSavings,
    matchTotal,
    promo: { ...promotionConfig },
    promoSavings,
    membership: {
      plan: membershipPlan,
      percent: membershipPct,
      savings: membershipSavings
    },
      loyalty: {
        pointsAvailable,
        rewardLabel: redemption.rewardLabel,
        savings: redemption.savings || 0,
        pointsSpent: redemption.pointsSpent || 0,
        pointsEarned,
        maxRedeemPoints: redemption.maxRedeemPoints || 0,
        earnRate: loyaltyConfig.earnRate,
        discountRate: loyaltyConfig.discountRate,
        maxRedemptionPercent: loyaltyConfig.maxRedemptionPercent
      }
    };
}

async function validateCart(cart = []) {
  if (!Array.isArray(cart) || cart.length === 0) {
    return { ok: false, message: 'Your cart is empty.' };
  }

  for (const item of cart) {
    const product = await ProductModel.getById(item.productId);
    if (!product) {
      return { ok: false, message: `Product not found (id ${item.productId}).` };
    }
    const desiredQty = Number(item.quantity) || 0;
    if (desiredQty <= 0) {
      return { ok: false, message: 'Quantity must be greater than zero.' };
    }
    if (Number(product.quantity) < desiredQty) {
      return { ok: false, message: `Not enough stock for ${product.productName}. Available: ${product.quantity}.` };
    }
  }

  return { ok: true };
}

async function placeOrderFromCart({
  cart,
  user,
  summary,
  status = 'processing',
  deliveryMethod = 'delivery',
  deliveryAddress = null,
  pickupOutlet = null,
  paymentMethod = null,
  paymentRef = null
}) {
  const orderRecord = await OrderModel.createOrder({
    userId: resolveUserId(user),
    subtotal: summary.totalBefore,
    total: summary.totalAfter,
    savings: summary.totalSavings,
    status,
    cartItems: cart,
    deliveryMethod,
    deliveryAddress,
    pickupOutlet,
    paymentMethod,
    paymentRef
  });

  for (const item of cart) {
    await ProductModel.reduceStock(item.productId, item.quantity);
  }

  try {
    const userId = resolveUserId(user);
    if (userId) await OrderModel.saveCart(userId, []);
  } catch (persistErr) {
    console.error('Unable to clear saved cart after checkout:', persistErr.message);
  }

  return orderRecord;
}

async function persistCart(user, items) {
  const userId = (resolveUserId && resolveUserId(user)) || null;
  if (!userId) return;
  const cartItems = Array.isArray(items) ? items : [];
  try {
    await OrderModel.saveCart(userId, cartItems);
  } catch (err) {
    console.error('Unable to save cart:', err.message);
  }
}

async function buildCartViewData(req) {
  let cart = [];
  const membership = getMembershipBenefit(req.session.user);

  try {
    const userId = resolveUserId(req.session.user);
    if (userId) {
      const savedCart = await OrderModel.getCartByUserId(userId);
      if (Array.isArray(savedCart) && savedCart.length) {
        cart = savedCart;
        req.session.cart = savedCart;
      } else {
        cart = req.session.cart || [];
      }
    } else {
      cart = req.session.cart || [];
    }

    const cartWithStock = [];
    let hasStockIssue = false;

    for (const item of cart) {
      const product = await ProductModel.getById(item.productId);
      const availableStock = product ? Number(product.quantity) || 0 : 0;
      const currentQty = Number(item.quantity) || 0;
      const outOfStock = availableStock <= 0;
      const exceeds = currentQty > availableStock;
      if (outOfStock || exceeds) hasStockIssue = true;

      cartWithStock.push({
        ...item,
        availableStock,
        maxAllowed: Math.max(currentQty, availableStock),
        stockIssue: outOfStock ? 'Out of stock' : (exceeds ? `Only ${availableStock} left` : '')
      });
    }

    const loyalty = buildLoyaltyContext(req.session.user, req.session.loyaltyRedeemPoints);
    const summary = summarizeCart(cartWithStock, membership, loyalty);
    return { cart: cartWithStock, summary, hasStockIssue };
  } catch (err) {
    console.error('Error loading cart:', err.message);
    req.flash('error', 'Unable to load cart right now.');
    const loyalty = buildLoyaltyContext(req.session.user, req.session.loyaltyRedeemPoints);
    const summary = summarizeCart(cart, membership, loyalty);
    return { cart, summary, hasStockIssue: false };
  }
}

async function updateLoyaltyRedemption(req, res) {
  try {
    const userId = resolveUserId(req.session.user);
    if (userId) {
      const savedCart = await OrderModel.getCartByUserId(userId);
      if (Array.isArray(savedCart) && savedCart.length) {
        req.session.cart = savedCart;
      }
    }
  } catch (err) {
    console.error('Unable to load cart for loyalty update:', err.message);
  }

  const cart = req.session.cart || [];
  const membership = getMembershipBenefit(req.session.user);
  const requestedPoints = req.body && typeof req.body.loyaltyRedeemPointsInput !== 'undefined'
    ? req.body.loyaltyRedeemPointsInput
    : 0;
  const loyalty = buildLoyaltyContext(req.session.user, requestedPoints);
  const summary = summarizeCart(cart, membership, loyalty);
  req.session.loyaltyRedeemPoints = summary.loyalty.pointsSpent || 0;
  return res.redirect('/payment');
}

async function renderCart(req, res) {
  const data = await buildCartViewData(req);
  return res.render('cart', { ...data, paypalClientId: process.env.PAYPAL_CLIENT_ID });
}

async function renderPayment(req, res) {
  const data = await buildCartViewData(req);
  return res.render('payment', { ...data, paypalClientId: process.env.PAYPAL_CLIENT_ID });
}

async function addToCart(req, res) {
  try {
    const productId = parseInt(req.params.id);
    const quantity = parseInt(req.body.quantity) || 1;

    const product = await ProductModel.getById(productId);
    if (!product) return res.status(404).send('Product not found');
    const availableStock = Number(product.quantity) || 0;
    if (availableStock <= 0) {
      req.flash('error', `${product.productName} is out of stock.`);
      return res.redirect('/shopping');
    }
    if (quantity > availableStock) {
      req.flash('error', `Only ${availableStock} left for ${product.productName}.`);
      return res.redirect('/shopping');
    }
    if (quantity <= 0) {
      req.flash('error', 'Quantity must be at least 1.');
      return res.redirect('/shopping');
    }

    // Always start from the latest saved cart so multiple browsers stay in sync
    const userId = resolveUserId(req.session.user);
    if (userId) {
      req.session.cart = await OrderModel.getCartByUserId(userId) || [];
    } else {
      req.session.cart = req.session.cart || [];
    }

    const discount = Number(product.discountPercent) || 0;
    const finalPrice = discount > 0 ? product.price * (1 - discount / 100) : product.price;

    const existingItem = req.session.cart.find(item => item.productId === productId);
    if (existingItem) {
      existingItem.quantity += quantity;
    } else {
      req.session.cart.push({
        productId: product.id,
        productName: product.productName,
        price: finalPrice,
        originalPrice: product.price,
        quantity: quantity,
        image: product.image
      });
    }

    await persistCart(req.session.user, req.session.cart);
    res.redirect('/cart');
  } catch (error) {
    console.error('Database query error:', error.message);
    res.status(500).send('Error retrieving product');
  }
}

async function updateCartItem(req, res) {
  const productId = Number(req.params.id);
  const qty = Number(req.body.quantity);
  if (!Number.isFinite(productId)) {
    req.flash('error', 'Invalid product.');
    return res.redirect('/cart');
  }
  if (!Number.isFinite(qty) || qty < 0) {
    req.flash('error', 'Quantity must be 0 or more.');
    return res.redirect('/cart');
  }

  // Load latest cart from storage to avoid stale data across browsers
  const userId = resolveUserId(req.session.user);
  if (userId) {
    req.session.cart = await OrderModel.getCartByUserId(userId) || [];
  } else {
    req.session.cart = req.session.cart || [];
  }
  const cart = req.session.cart || [];
  const idx = cart.findIndex(item => Number(item.productId) === productId);
  if (idx === -1) {
    req.flash('error', 'Item not found in cart.');
    return res.redirect('/cart');
  }

  try {
    const product = await ProductModel.getById(productId);
    if (!product) {
      req.flash('error', 'Product not found.');
      return res.redirect('/cart');
    }

    const availableStock = Number(product.quantity) || 0;
    if (qty > availableStock) {
      req.flash('error', `Only ${availableStock} left in stock for ${product.productName}.`);
      return res.redirect('/cart');
    }

    if (qty === 0) {
      cart.splice(idx, 1);
      req.flash('success', 'Item removed from cart.');
    } else {
      cart[idx].quantity = qty;
      req.flash('success', 'Cart updated.');
    }
    req.session.cart = cart;
    await persistCart(req.session.user, req.session.cart);
    return res.redirect('/cart');
  } catch (err) {
    console.error('Error updating cart item:', err.message);
    req.flash('error', 'Unable to update cart right now.');
    return res.redirect('/cart');
  }
}

async function deleteCartItem(req, res) {
  const productId = Number(req.params.id);
  if (!Number.isFinite(productId)) {
    req.flash('error', 'Invalid product.');
    return res.redirect('/cart');
  }
  // Load latest cart from storage to avoid stale data across browsers
  const userId = resolveUserId(req.session.user);
  if (userId) {
    req.session.cart = await OrderModel.getCartByUserId(userId) || [];
  } else {
    req.session.cart = req.session.cart || [];
  }
  const cart = req.session.cart || [];
  const nextCart = cart.filter(item => Number(item.productId) !== productId);
  if (nextCart.length === cart.length) {
    req.flash('error', 'Item not found in cart.');
  } else {
    req.flash('success', 'Item removed from cart.');
  }
  req.session.cart = nextCart;
  await persistCart(req.session.user, req.session.cart);
  res.redirect('/cart');
}

async function checkout(req, res) {
  const cart = req.session.cart || [];
  // Basic payment validation
  const { cardName = '', cardNumber = '', expiry = '', cvv = '' } = req.body || {};
  const deliveryAddress = (req.body && req.body.deliveryAddress) ? String(req.body.deliveryAddress).trim() : '';
  const pickupOutlet = (req.body && req.body.pickupOutlet) ? String(req.body.pickupOutlet).trim() : '';
  const cleanNumber = (cardNumber || '').replace(/\s+/g, '');
  const expiryOk = /^[0-1][0-9]\/[0-9]{2}$/.test(expiry || '');
  const cardOk = /^\d{13,19}$/.test(cleanNumber);
  const cvvOk = /^\d{3,4}$/.test(cvv || '');
  if (!cardName.trim() || !cardOk || !expiryOk || !cvvOk) {
    req.flash('error', 'Please enter valid card details (name, number, expiry MM/YY, CVV).');
    return res.redirect('/cart');
  }

  const membershipInfo = getMembershipBenefit(req.session.user);
  try {
    const validation = await validateCart(cart);
    if (!validation.ok) {
      req.flash('error', validation.message);
      return res.redirect('/cart');
    }

    const summary = summarizeCart(cart, membershipInfo);
    const deliveryMethod = req.body && req.body.deliveryMethod ? String(req.body.deliveryMethod) : 'delivery';
    const orderRecord = await placeOrderFromCart({
      cart,
      user: req.session.user,
      summary,
      status: 'processing',
      deliveryMethod,
      deliveryAddress: deliveryAddress || null,
      pickupOutlet: deliveryMethod === 'pickup' ? (pickupOutlet || null) : null,
      paymentMethod: 'card'
    });

    req.session.cart = [];
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
    req.flash('success', `Order #${orderRecord.id} placed! Total: $${summary.totalAfter.toFixed(2)}${savingsMsg}`);
    res.redirect(`/orders/${orderRecord.id}/invoice`);
  } catch (err) {
    console.error('Error creating order:', err.message);
    req.flash('error', 'Unable to place order right now. Please try again later.');
    res.redirect('/cart');
  }
}

async function list(req, res) {
  try {
    const orders = await OrderModel.getAllOrders();
    res.json(orders);
  } catch (err) {
    console.error('Error fetching orders:', err.message);
    res.status(500).json({ message: 'Unable to fetch orders' });
  }
}

async function detail(req, res) {
  try {
    const order = await OrderModel.getOrderById(req.params.id);
    if (!order) return res.status(404).json({ message: 'Order not found' });
    const user = req.session.user;
    const userId = resolveUserId(user);
    const canView = user && (user.role === 'admin' || (order.userId && Number(order.userId) === Number(userId)));
    if (!canView) return res.status(403).json({ message: 'Not authorized to view this order' });
    res.json(order);
  } catch (err) {
    console.error('Error fetching order:', err.message);
    res.status(500).json({ message: 'Unable to fetch order' });
  }
}

async function renderUserOrders(req, res) {
  if (!req.session.user) {
    req.flash('error', 'Please log in to view your orders.');
    return res.redirect('/login');
  }
  try {
    const userId = resolveUserId(req.session.user);
    const orders = await OrderModel.getOrdersByUser(userId);
    const refunds = await RefundModel.getByUserId(userId);
    const refundsMap = refunds.reduce((acc, refund) => {
      if (!acc[refund.orderId]) acc[refund.orderId] = refund;
      return acc;
    }, {});
    res.render('ordersHistory', { orders, refundsMap, user: req.session.user });
  } catch (err) {
    console.error('Error fetching user orders:', err.message);
    req.flash('error', 'Unable to load your orders right now.');
    res.redirect('/shopping');
  }
}

async function renderAdminOrders(req, res) {
  try {
    const orders = await OrderModel.getAllOrders();
    res.render('adminOrders', { orders, user: req.session.user });
  } catch (err) {
    console.error('Error fetching orders:', err.message);
    req.flash('error', 'Unable to load orders right now.');
    res.redirect('/inventory');
  }
}

async function renderInvoice(req, res) {
  if (!req.session.user) {
    req.flash('error', 'Please log in to view invoices.');
    return res.redirect('/login');
  }

  const orderId = req.params.id;
  try {
    const order = await OrderModel.getOrderById(orderId);
    if (!order) {
      req.flash('error', 'Order not found.');
      return res.redirect('/orders/history');
    }

    const sessionUser = req.session.user;
    const sessionUserId = resolveUserId(sessionUser);
    const isAdmin = sessionUser && sessionUser.role === 'admin';
    const belongsToUser = order.userId && Number(order.userId) === Number(sessionUserId);

    if (!isAdmin && !belongsToUser) {
      req.flash('error', 'You are not authorized to view this invoice.');
      return res.redirect('/orders/history');
    }

    let customer = {
      name: sessionUser.username || sessionUser.name || '',
      email: sessionUser.email || '',
      address: sessionUser.address || '',
      contact: sessionUser.contact || ''
    };

    // For admins viewing other users' orders, fetch customer details to display on the invoice
    if (isAdmin && !belongsToUser && order.userId) {
      try {
        const fetchedUser = await UserModel.getById(order.userId);
        if (fetchedUser) {
          customer = {
            name: fetchedUser.username || fetchedUser.name || '',
            email: fetchedUser.email || '',
            address: fetchedUser.address || '',
            contact: fetchedUser.contact || ''
          };
        }
      } catch (err) {
        console.warn('Unable to fetch user for invoice:', err.message);
      }
    }

    const items = Array.isArray(order.items) ? order.items : [];
    const totals = {
      subtotal: Number(order.subtotal || 0),
      savings: Number(order.savings || 0),
      total: Number(order.total || 0)
    };

    res.render('invoice', {
      order,
      customer,
      items,
      totals,
      user: req.session.user
    });
  } catch (err) {
    console.error('Error rendering invoice:', err.message);
    req.flash('error', 'Unable to load invoice right now.');
    res.redirect('/orders/history');
  }
}

async function updateStatus(req, res) {
  const { status } = req.body;
  const orderId = req.params.id;
  if (!['pending', 'completed', 'processing'].includes(status)) {
    req.flash('error', 'Invalid status value.');
    return res.redirect('/admin/orders');
  }
  try {
    await OrderModel.updateOrderStatus(orderId, status);
    req.flash('success', `Order #${orderId} updated to ${status}.`);
  } catch (err) {
    console.error('Error updating order status:', err.message);
    req.flash('error', 'Unable to update order status.');
  }
  res.redirect('/admin/orders');
}

async function remove(req, res) {
  const orderId = req.params.id;
  try {
    await OrderModel.deleteOrder(orderId);
    req.flash('success', `Order #${orderId} deleted.`);
  } catch (err) {
    console.error('Error deleting order:', err.message);
    req.flash('error', 'Unable to delete order.');
  }
  res.redirect('/admin/orders');
}

function renderPromotion(req, res) {
  res.render('adminPromotion', { promo: promotionConfig, user: req.session.user });
}

function updatePromotion(req, res) {
  const { keywords, percent } = req.body;
  const parsedPercent = Number(percent);
  if (!Number.isFinite(parsedPercent) || parsedPercent <= 0 || parsedPercent > 100) {
    req.flash('error', 'Percent must be between 0 and 100.');
    return res.redirect('/admin/promotion');
  }
  const kw = (keywords || '')
    .split(',')
    .map(k => k.trim().toLowerCase())
    .filter(Boolean);
  if (!kw.length) {
    req.flash('error', 'Please provide at least one keyword.');
    return res.redirect('/admin/promotion');
  }
  promotionConfig = { keywords: kw, percent: parsedPercent };
  req.flash('success', 'Promotion updated.');
  res.redirect('/admin/promotion');
}

module.exports = {
  checkout,
  list,
  detail,
  summarizeCart,
  validateCart,
  placeOrderFromCart,
  renderCart,
  renderPayment,
  buildCartViewData,
  addToCart,
  updateCartItem,
  deleteCartItem,
  persistCart,
  renderUserOrders,
  renderAdminOrders,
  renderInvoice,
  updateStatus,
  remove,
  renderPromotion,
  updatePromotion,
  updateLoyaltyRedemption,
  buildLoyaltyContext,
  calculateLoyaltyPointsEarned,
  getUserPoints,
  normalizeRedeemPoints,
  resolveUserId,
  get promotionConfig() { return promotionConfig; },
  getMembershipBenefit
};
