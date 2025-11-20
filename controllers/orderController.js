const OrderModel = require('../models/orderModel');
const ProductModel = require('../models/productModel');

// Promotion configuration (editable by admin at runtime)
let promotionConfig = {
  keywords: ['milk', 'yogurt', 'cheese', 'butter', 'dairy'],
  percent: 10
};

function resolveUserId(user) {
  if (!user) return null;
  return user.id || user.userId || user.user_id || user.userID || null;
}

function summarizeCart(cart = []) {
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

  const totalAfter = Math.max(totalBefore - promoSavings, 0);
  const totalSavings = promoSavings || 0;
  return {
    totalBefore,
    totalAfter,
    totalSavings,
    matchTotal,
    promo: { ...promotionConfig }
  };
}

async function checkout(req, res) {
  const cart = req.session.cart || [];
  if (!cart.length) {
    req.flash('error', 'Your cart is empty.');
    return res.redirect('/cart');
  }

  const summary = summarizeCart(cart);
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

    const orderRecord = await OrderModel.createOrder({
      userId: resolveUserId(req.session.user),
      subtotal: summary.totalBefore,
      total: summary.totalAfter,
      savings: summary.totalSavings,
      status: 'processing',
      cartItems: cart
    });

    // Reduce stock after successful order creation
    for (const item of cart) {
      await ProductModel.reduceStock(item.productId, item.quantity);
    }

    req.session.cart = [];
    const savingsMsg = summary.totalSavings > 0 ? ` (you saved $${summary.totalSavings.toFixed(2)} from promotions)` : '';
    req.flash('success', `Order #${orderRecord.id} placed! Total: $${summary.totalAfter.toFixed(2)}${savingsMsg}`);
    res.redirect('/shopping');
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
  updateStatus,
  remove,
  renderPromotion,
  updatePromotion,
  get promotionConfig() { return promotionConfig; }
};
