const express = require('express');
const multer = require('multer');
const session = require('express-session');
const flash = require('connect-flash');
const productController = require('./controllers/productController');
const orderController = require('./controllers/orderController');
const userController = require('./controllers/userController');

const { attachSessionLocals, checkAuthenticated, checkAdmin } = require('./middleware');
const app = express();

// Set up multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'public/images'); // Directory to save uploaded files
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname); // Keep original file name
    }
});

const upload = multer({ storage: storage });

// Set up view engine
app.set('view engine', 'ejs');
// Enable static files
app.use(express.static('public'));
// Enable form processing
app.use(express.urlencoded({ extended: false }));

// Session middleware
app.use(session({
    secret: 'secret',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

app.use(flash());

// Expose common template variables + session helpers
app.use(attachSessionLocals);

// Routes

// Home route - Displays products with optional search & sort
app.get('/', (req, res) => productController.renderHome(req, res));

// GET route for login page
app.get('/login', (req, res) => userController.renderLogin(req, res));

// GET route for registration page
app.get('/register', (req, res) => userController.renderRegister(req, res));

// Membership payment landing (select plan and proceed)
app.get('/membership/payment', (req, res) => userController.renderMembershipPayment(req, res));

// Apply membership for a logged-in user
app.post('/membership/payment', checkAuthenticated, (req, res) => userController.processMembershipPayment(req, res));

// Orders API (admin list) and user history/detail
app.get('/orders', checkAuthenticated, checkAdmin, (req, res) => orderController.list(req, res));
app.get('/orders/history', checkAuthenticated, (req, res) => orderController.renderUserOrders(req, res));
app.get('/orders/:id/invoice', checkAuthenticated, (req, res) => orderController.renderInvoice(req, res));
app.get('/orders/:id', checkAuthenticated, (req, res) => orderController.detail(req, res));
app.get('/admin/orders', checkAuthenticated, checkAdmin, (req, res) => orderController.renderAdminOrders(req, res));
app.post('/admin/orders/:id/status', checkAuthenticated, checkAdmin, (req, res) => orderController.updateStatus(req, res));
app.post('/admin/orders/:id/delete', checkAuthenticated, checkAdmin, (req, res) => orderController.remove(req, res));

// POST route to handle registration
app.post('/register', (req, res) => userController.register(req, res));

// POST route for login form submission
app.post('/login', (req, res) => userController.login(req, res));

// Product details route
app.get('/product/:id', (req, res) => {
    productController.renderProduct(req, res);
});

// Inventory route (accessible to admins)
app.get('/inventory', checkAuthenticated, checkAdmin, (req, res) => {
    productController.renderInventory(req, res);
});

// Add product route
app.get('/addProduct', checkAuthenticated, checkAdmin, (req, res) => {
    productController.renderAdd(req, res);
});

// POST route to add product
app.post('/addProduct', checkAuthenticated, checkAdmin, upload.single('image'), (req, res) => {
    productController.create(req, res);
});

// Update product route
app.get('/updateProduct/:id', checkAuthenticated, checkAdmin, (req, res) => {
    productController.renderUpdate(req, res);
});

// POST route to update product
app.post('/updateProduct/:id', checkAuthenticated, checkAdmin, upload.single('image'), (req, res) => {
    productController.update(req, res);
});

// Delete product route
app.get('/deleteProduct/:id', checkAuthenticated, checkAdmin, (req, res) => {
    productController.remove(req, res);
});

app.get('/shopping', checkAuthenticated, (req, res) => {
    productController.renderShopping(req, res);
});

// Admin: manage users
app.get('/admin', checkAuthenticated, checkAdmin, (req, res) => res.redirect('/admin/orders'));
app.get('/admin/users', checkAuthenticated, checkAdmin, (req, res) => {
    userController.listUsers(req, res);
});

app.get('/admin/users/:id/edit', checkAuthenticated, checkAdmin, (req, res) => {
    userController.renderEditUser(req, res);
});

app.post('/admin/users/:id', checkAuthenticated, checkAdmin, (req, res) => {
    userController.updateUser(req, res);
});

app.post('/admin/users/:id/disable', checkAuthenticated, checkAdmin, (req, res) => {
    userController.toggleDisable(req, res);
});

// Admin promotion management
app.get('/admin/promotion', checkAuthenticated, checkAdmin, (req, res) => orderController.renderPromotion(req, res));
app.post('/admin/promotion', checkAuthenticated, checkAdmin, (req, res) => orderController.updatePromotion(req, res));

// Cart route - Displays the cart
app.get('/cart', checkAuthenticated, (req, res) => orderController.renderCart(req, res));

// Add to cart route
app.post('/add-to-cart/:id', checkAuthenticated, (req, res) => orderController.addToCart(req, res));

// Update item quantity in cart (set to new value; 0 removes)
app.post('/cart/item/:id/update', checkAuthenticated, (req, res) => orderController.updateCartItem(req, res));

// Delete item from cart
app.post('/cart/item/:id/delete', checkAuthenticated, (req, res) => orderController.deleteCartItem(req, res));

// Checkout route now handled by OrderController (persists the order)
app.post('/checkout', checkAuthenticated, (req, res) => orderController.checkout(req, res));


// Logout route - Destroy session and log the user out
app.get('/logout', (req, res) => userController.logout(req, res));




// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
