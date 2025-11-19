const Product = require('../models/productModel');

// Controller helpers focused on products (list, detail, CRUD)

async function renderHome(req, res) {
  try {
    const products = await Product.list({ q: req.query.q, sort: req.query.sort });
    const promotions = [
      { id: 1, title: 'Fresh Fruits Sale', subtitle: 'Up to 20% off on selected fruits', image: '/images/promo-fruits.jpg' },
      { id: 2, title: 'Dairy Deals', subtitle: 'Buy 2 get 1 free on select dairy', image: '/images/promo-dairy.jpg' },
      { id: 3, title: 'Bread & Bakery', subtitle: 'Daily fresh bread discounts', image: '/images/promo-bakery.jpg' }
    ];
    const bestsellers = await Product.getBestsellers(4);
    res.render('index', { products, promotions, bestsellers });
  } catch (err) {
    console.error('Error rendering home:', err.message);
    res.status(500).send('Error retrieving products');
  }
}

async function renderShopping(req, res) {
  try {
    const products = await Product.list({ q: req.query.q, sort: req.query.sort });
    const bestsellers = (await Product.getBestsellers(4)).map(b => b.id);
    res.render('shopping', { products, bestsellers });
  } catch (err) {
    console.error('Error rendering shopping:', err.message);
    res.status(500).send('Error retrieving products');
  }
}

async function renderInventory(req, res) {
  try {
    const products = await Product.list();
    res.render('inventory', { products, user: req.session.user });
  } catch (err) {
    console.error('Error rendering inventory:', err.message);
    res.status(500).send('Error retrieving products');
  }
}

async function renderProduct(req, res) {
  try {
    const product = await Product.getById(req.params.id);
    if (!product) return res.status(404).send('Product not found');
    res.render('product', { product, user: req.session.user });
  } catch (err) {
    console.error('Error retrieving product:', err.message);
    res.status(500).send('Error retrieving product by ID');
  }
}

function renderAdd(req, res) {
  res.render('addProduct', { user: req.session.user });
}

async function create(req, res) {
  try {
    const { name, quantity, price } = req.body;
    const image = req.file ? req.file.filename : null;
    await Product.create({ name, quantity, price, image });
    req.flash('success', 'Product added');
    res.redirect('/inventory');
  } catch (err) {
    console.error('Error adding product:', err.message);
    res.status(500).send('Error adding product');
  }
}

async function renderUpdate(req, res) {
  try {
    const product = await Product.getById(req.params.id);
    if (!product) return res.status(404).send('Product not found');
    res.render('updateProduct', { product });
  } catch (err) {
    console.error('Error loading product for update:', err.message);
    res.status(500).send('Error loading product');
  }
}

async function update(req, res) {
  try {
    const { name, quantity, price, currentImage } = req.body;
    const image = req.file ? req.file.filename : currentImage;
    await Product.update(req.params.id, { name, quantity, price, image });
    req.flash('success', 'Product updated');
    res.redirect('/inventory');
  } catch (err) {
    console.error('Error updating product:', err.message);
    res.status(500).send('Error updating product');
  }
}

async function remove(req, res) {
  try {
    await Product.remove(req.params.id);
    req.flash('success', 'Product deleted');
    res.redirect('/inventory');
  } catch (err) {
    console.error('Error deleting product:', err.message);
    res.status(500).send('Error deleting product');
  }
}

module.exports = {
  renderHome,
  renderShopping,
  renderInventory,
  renderProduct,
  renderAdd,
  renderUpdate,
  create,
  update,
  remove
};
