const OrderModel = require('../models/orderModel');

const DAIRY_KEYWORDS = ['milk', 'yogurt', 'cheese', 'butter', 'dairy'];

function summarizeCart(cart = []) {
  let totalBefore = 0;
  let nonDairyTotal = 0;
  const dairyUnitPrices = [];

  cart.forEach(item => {
    const name = (item.productName || '').toLowerCase();
    const price = parseFloat(item.price) || 0;
    const qty = parseInt(item.quantity, 10) || 0;
    totalBefore += price * qty;
    const isDairy = DAIRY_KEYWORDS.some(k => name.includes(k));
    if (isDairy) {
      for (let i = 0; i < qty; i++) dairyUnitPrices.push(price);
    } else {
      nonDairyTotal += price * qty;
    }
  });

  dairyUnitPrices.sort((a, b) => b - a);
  let dairyCharge = 0;
  let dairySavings = 0;
  for (let i = 0; i < dairyUnitPrices.length; i++) {
    if ((i % 3) === 2) {
      dairySavings += dairyUnitPrices[i];
    } else {
      dairyCharge += dairyUnitPrices[i];
    }
  }

  const totalAfter = nonDairyTotal + dairyCharge;
  const totalSavings = (totalBefore - totalAfter) || 0;
  return { totalBefore, totalAfter, totalSavings, dairyCount: dairyUnitPrices.length };
}

async function checkout(req, res) {
  const cart = req.session.cart || [];
  if (!cart.length) {
    req.flash('error', 'Your cart is empty.');
    return res.redirect('/cart');
  }

  const summary = summarizeCart(cart);
  try {
    const orderRecord = await OrderModel.createOrder({
      userId: req.session.user ? req.session.user.id : null,
      subtotal: summary.totalBefore,
      total: summary.totalAfter,
      savings: summary.totalSavings,
      status: 'processing',
      cartItems: cart
    });

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
    const canView = user && (user.role === 'admin' || (order.userId && Number(order.userId) === Number(user.id)));
    if (!canView) return res.status(403).json({ message: 'Not authorized to view this order' });
    res.json(order);
  } catch (err) {
    console.error('Error fetching order:', err.message);
    res.status(500).json({ message: 'Unable to fetch order' });
  }
}

module.exports = {
  checkout,
  list,
  detail,
  summarizeCart
};
