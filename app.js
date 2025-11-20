const express = require('express');
const mysql = require('mysql2');
const multer = require('multer');
const session = require('express-session');
const flash = require('connect-flash');
const productController = require('./controllers/productController');
const orderController = require('./controllers/orderController');
const userAdminController = require('./controllers/userAdminController');
const ProductModel = require('./models/productModel');

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

// Database connection details
const connection = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'Republic_C207',
    database: 'c372_supermarketdb'
});

// Connecting to database
connection.connect((err) => {
    if (err) {
        console.error('Error connecting to MySQL:', err);
        return;
    }
    console.log('Connected to MySQL database');
});

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
app.get('/login', (req, res) => {
    res.render('login', { messages: req.flash('success'), errors: req.flash('error') });
});

// GET route for registration page
app.get('/register', (req, res) => {
    const plan = req.query.plan || '';
    res.render('register', { messages: req.flash('error'), formData: {}, plan });
});

// Orders API (admin list + detail for owner/admin)
app.get('/orders', checkAuthenticated, checkAdmin, (req, res) => orderController.list(req, res));
app.get('/orders/:id', checkAuthenticated, (req, res) => orderController.detail(req, res));

// POST route to handle registration
app.post('/register', (req, res) => {
    const { username, email, password, address, contact, role } = req.body;
    const plan = req.body.plan || '';
    // basic validation
    if (!username || !email || !password || !address || !contact || !role) {
        req.flash('error', 'All fields are required.');
        return res.redirect('/register');
    }

    // check if email already exists
    connection.query('SELECT id FROM users WHERE email = ?', [email], (err, results) => {
        if (err) {
            console.error('Database error during registration:', err.message);
            req.flash('error', 'Database error. Please try again later.');
            return res.redirect('/register');
        }

        if (results.length > 0) {
            req.flash('error', 'An account with that email already exists.');
            return res.redirect('/register');
        }

        // Decide whether the users table has a 'plan' column. If so, include it in the INSERT.
        const colCheckSql = "SELECT COLUMN_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'users' AND COLUMN_NAME = 'plan'";
        connection.query(colCheckSql, [connection.config.database], (colErr, colRes) => {
            if (colErr) {
                console.error('Error checking users table columns:', colErr.message);
                req.flash('error', 'Unable to create account.');
                return res.redirect('/register');
            }

            const hasPlan = colRes.length > 0;
            let sql, params;
            if (hasPlan) {
                sql = 'INSERT INTO users (username, email, password, address, contact, role, plan) VALUES (?, ?, SHA1(?), ?, ?, ?, ?)';
                params = [username, email, password, address, contact, role, plan];
            } else {
                sql = 'INSERT INTO users (username, email, password, address, contact, role) VALUES (?, ?, SHA1(?), ?, ?, ?)';
                params = [username, email, password, address, contact, role];
            }

            connection.query(sql, params, (insertErr, insertRes) => {
                if (insertErr) {
                    console.error('Error inserting user:', insertErr.message);
                    req.flash('error', 'Unable to create account.');
                    return res.redirect('/register');
                }

                req.flash('success', 'Registration successful. Please log in.');
                res.redirect('/login');
            });
        });
    });
});

// POST route for login form submission
app.post('/login', (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        req.flash('error', 'All fields are required.');
        return res.redirect('/login');
    }

    const sql = 'SELECT * FROM users WHERE email = ? AND password = SHA1(?)';
    connection.query(sql, [email, password], (err, results) => {
        if (err) {
            console.error('Database query error:', err.message);
            return res.status(500).send('Database error');
        }

        if (results.length > 0) {
            req.session.user = results[0]; 
            req.flash('success', 'Login successful!');
            if (req.session.user.role === 'user') {
                res.redirect('/shopping');
            } else {
                res.redirect('/inventory');
            }
        } else {
            req.flash('error', 'Invalid email or password.');
            res.redirect('/login');
        }
    });
});

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
app.get('/admin/users', checkAuthenticated, checkAdmin, (req, res) => {
    userAdminController.list(req, res);
});

app.get('/admin/users/:id/edit', checkAuthenticated, checkAdmin, (req, res) => {
    userAdminController.renderEdit(req, res);
});

app.post('/admin/users/:id', checkAuthenticated, checkAdmin, (req, res) => {
    userAdminController.update(req, res);
});

app.post('/admin/users/:id/delete', checkAuthenticated, checkAdmin, (req, res) => {
    userAdminController.remove(req, res);
});

// Cart route - Displays the cart
app.get('/cart', checkAuthenticated, (req, res) => {
    const cart = req.session.cart || [];

    // Compute promotion preview for cart: Buy 2 get 1 free across all dairy items (cheapest of each 3 free)
    const dairyKeywords = ['milk','yogurt','cheese','butter','dairy'];
    let totalBefore = 0;
    let nonDairyTotal = 0;
    const dairyUnitPrices = [];

    cart.forEach(it => {
        const name = (it.productName || '').toLowerCase();
        const price = parseFloat(it.price) || 0;
        const qty = parseInt(it.quantity) || 0;
        totalBefore += price * qty;
        const isDairy = dairyKeywords.some(k => name.includes(k));
        if (isDairy) {
            for (let i = 0; i < qty; i++) dairyUnitPrices.push(price);
        } else {
            nonDairyTotal += price * qty;
        }
    });

    // Calculate dairy charges after promotion
    let dairyCharge = 0;
    let dairySavings = 0;
    if (dairyUnitPrices.length > 0) {
        // sort descending so within each group of 3 the cheapest (3rd) becomes free
        dairyUnitPrices.sort((a,b) => b - a);
        for (let i = 0; i < dairyUnitPrices.length; i++) {
            if ((i % 3) === 2) {
                dairySavings += dairyUnitPrices[i];
            } else {
                dairyCharge += dairyUnitPrices[i];
            }
        }
    }

    const totalAfter = nonDairyTotal + dairyCharge;
    const totalSavings = (totalBefore - totalAfter) || 0;

    res.render('cart', { cart, promo: { totalBefore, totalAfter, totalSavings, dairyCount: dairyUnitPrices.length } });
});

// Add to cart route
app.post('/add-to-cart/:id', checkAuthenticated, async (req, res) => {
    try {
        const productId = parseInt(req.params.id);  // Get the product ID from the URL
        const quantity = parseInt(req.body.quantity) || 1;  // Default quantity is 1 if not provided

        const product = await ProductModel.getById(productId);
        if (!product) return res.status(404).send('Product not found');

        // Initialize the cart in session if it doesn't exist
        if (!req.session.cart) {
            req.session.cart = [];
        }

        // Check if the product is already in the cart
        const existingItem = req.session.cart.find(item => item.productId === productId);
        if (existingItem) {
            existingItem.quantity += quantity;  // If product exists, update the quantity
        } else {
            req.session.cart.push({
                productId: product.id,
                productName: product.productName,
                price: product.price,
                quantity: quantity,
                image: product.image
            });
        }

        // Redirect to the cart page
        res.redirect('/cart');
    } catch (error) {
        console.error('Database query error:', error.message);
        res.status(500).send('Error retrieving product');
    }
});

// Checkout route now handled by OrderController (persists the order)
app.post('/checkout', checkAuthenticated, (req, res) => orderController.checkout(req, res));


// Logout route - Destroy session and log the user out
app.get('/logout', (req, res) => {
    // Set the flash message before destroying the session
    req.flash('success', 'You have been logged out.');
    
    req.session.destroy((err) => {
        if (err) {
            return res.status(500).send('Error logging out');
        }

        // Clear the session cookie
        res.clearCookie('connect.sid');
        
        // Redirect to the login page after logging out
        res.redirect('/login');
    });
});




// Start the server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
