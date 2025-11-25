const OrderModel = require('../models/orderModel');
const ProductModel = require('../models/productModel');
const UserModel = require('../models/userModel');

// Promotion configuration (editable by admin at runtime)
let promotionConfig = {
  keywords: ['milk', 'yogurt', 'cheese', 'butter', 'dairy'],
  percent: 10
};

function getMembershipBenefit(user) {
  const planRaw = user && user.plan ? String(user.plan).toLowerCase() : '';
  if (planRaw === 'gold') return { membershipPercent: 10, membershipPlan: 'gold' };
  if (planRaw === 'silver') return { membershipPercent: 5, membershipPlan: 'silver' };
  return { membershipPercent: 0, membershipPlan: planRaw || '' };
}

function resolveUserId(user) {
  if (!user) return null;
  return user.id || user.userId || user.user_id || user.userID || null;
}

function summarizeCart(cart = [], { membershipPercent = 0, membershipPlan = '' } = {}) {
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
  const totalSavings = (promoSavings || 0) + (membershipSavings || 0);
  return {
    totalBefore,
    totalAfter,
    totalSavings,
    matchTotal,
    promo: { ...promotionConfig },
    promoSavings,
    membership: {
      plan: membershipPlan,
      percent: membershipPct,
      savings: membershipSavings
    }
  };
}

async function checkout(req, res) {
  const cart = req.session.cart || [];
  if (!cart.length) {
    req.flash('error', 'Your cart is empty.');
    return res.redirect('/cart');
  }

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
  const summary = summarizeCart(cart, membershipInfo);
  try {
    // Validate stock before placing order
    for (const item of cart) {
      const product = await ProductModel.getById(item.productId);
      if (!product) {
        req.flash('error', `Product not found (id ${item.productId}).`);
        return res.redirect('/cart');
      }
      const desiredQty = Number(item.quantity) || 0;
      if (desiredQty <= 0) {
        req.flash('error', 'Quantity must be greater than zero.');
        return res.redirect('/cart');
      }
      if (Number(product.quantity) < desiredQty) {
        req.flash('error', `Not enough stock for ${product.productName}. Available: ${product.quantity}.`);
        return res.redirect('/cart');
      }
    }

    const deliveryMethod = req.body && req.body.deliveryMethod ? String(req.body.deliveryMethod) : 'delivery';
    const orderRecord = await OrderModel.createOrder({
      userId: resolveUserId(req.session.user),
      subtotal: summary.totalBefore,
      total: summary.totalAfter,
      savings: summary.totalSavings,
      status: 'processing',
      cartItems: cart,
      deliveryMethod,
      deliveryAddress: deliveryAddress || null,
      pickupOutlet: deliveryMethod === 'pickup' ? (pickupOutlet || null) : null
    });

    // Reduce stock after successful order creation
    for (const item of cart) {
      await ProductModel.reduceStock(item.productId, item.quantity);
    }

    req.session.cart = [];
    try {
      const userId = resolveUserId(req.session.user);
      if (userId) await OrderModel.saveCart(userId, []);
    } catch (persistErr) {
      console.error('Unable to clear saved cart after checkout:', persistErr.message);
    }
    let savingsMsg = '';
    if (summary.totalSavings > 0) {
      const promoPart = summary.promoSavings > 0 ? `promo $${summary.promoSavings.toFixed(2)}` : '';
      const memberPart = summary.membership && summary.membership.savings > 0
        ? `membership $${summary.membership.savings.toFixed(2)}`
        : '';
      const parts = [promoPart, memberPart].filter(Boolean).join(' + ');
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
    res.render('ordersHistory', { orders, user: req.session.user });
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
  renderUserOrders,
  renderAdminOrders,
  renderInvoice,
  updateStatus,
  remove,
  renderPromotion,
  updatePromotion,
  get promotionConfig() { return promotionConfig; },
  getMembershipBenefit
};
