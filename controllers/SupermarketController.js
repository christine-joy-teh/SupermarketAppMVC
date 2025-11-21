const express = require('express');
const mysql = require('mysql2');
const session = require('express-session');
const flash = require('connect-flash');
const multer = require('multer');
const app = express();

// Supermarket controller (function-based MVC)
const SupermarketController = require('./controllers/SupermarketController');


// Set up multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'public/images'); // Directory to save uploaded files
    },
    filename: (req, file, cb) => {
        cb(null, file.originalname);
    }
});

const upload = multer({ storage: storage });

// NOTE: connection is still used for user auth/register routes below
const connection = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'Republic_C207',
    database: 'c372_supermarketdb'
  });

connection.connect((err) => {
    if (err) {
        console.error('Error connecting to MySQL:', err);
        return;
    }
    console.log('Connected to MySQL database');
});

// Set up view engine
app.set('view engine', 'ejs');
//  enable static files
app.use(express.static('public'));
// enable form processing
app.use(express.urlencoded({
    extended: false
}));

// Session Middleware
app.use(session({
    secret: 'secret',
    resave: false,
    saveUninitialized: true,
    // Session expires after 1 week of inactivity
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

app.use(flash());

// Middleware to check if user is logged in
const checkAuthenticated = (req, res, next) => {
    if (req.session.user) {
        return next();
    } else {
        req.flash('error', 'Please log in to view this resource');
        res.redirect('/login');
    }
};

// Middleware to check if user is admin
const checkAdmin = (req, res, next) => {
    if (req.session.user && req.session.user.role === 'admin') {
        return next();
    } else {
        req.flash('error', 'Access denied');
        res.redirect('/shopping');
    }
};

// Middleware for form validation
const validateRegistration = (req, res, next) => {
    const { username, email, password, address, contact, role } = req.body;

    if (!username || !email || !password || !address || !contact || !role) {
        return res.status(400).send('All fields are required.');
    }

    if (password.length < 6) {
        req.flash('error', 'Password should be at least 6 or more characters long');
        req.flash('formData', req.body);
        return res.redirect('/register');
    }
    next();
};

// Define routes

app.get('/',  (req, res) => {
    res.render('index', {user: req.session.user} );
});

// Inventory (admin) - uses controller to list products and render inventory view
app.get('/inventory', checkAuthenticated, checkAdmin, (req, res) => {
    // delegate to controller
    SupermarketController.list(req, res);
});

// Shopping (user) - uses same controller list method to render shopping view
app.get('/shopping', checkAuthenticated, (req, res) => {
    SupermarketController.list(req, res);
});

app.get('/register', (req, res) => {
    res.render('register', { messages: req.flash('error'), formData: req.flash('formData')[0] });
});

app.post('/register', validateRegistration, (req, res) => {

    const { username, email, password, address, contact, role } = req.body;

    const sql = 'INSERT INTO users (username, email, password, address, contact, role) VALUES (?, ?, SHA1(?), ?, ?, ?)';
    connection.query(sql, [username, email, password, address, contact, role], (err, result) => {
        if (err) {
            throw err;
        }
        console.log(result);
        req.flash('success', 'Registration successful! Please log in.');
        res.redirect('/login');
    });
});

app.get('/login', (req, res) => {
    res.render('login', { messages: req.flash('success'), errors: req.flash('error') });
});

app.post('/login', (req, res) => {
    const { email, password } = req.body;

    // Validate email and password
    if (!email || !password) {
        req.flash('error', 'All fields are required.');
        return res.redirect('/login');
    }

    const sql = 'SELECT * FROM users WHERE email = ? AND password = SHA1(?)';
    connection.query(sql, [email, password], (err, results) => {
        if (err) {
            throw err;
        }

        if (results.length > 0) {
            // Successful login
            req.session.user = results[0];
            req.flash('success', 'Login successful!');
            if(req.session.user.role == 'user')
                res.redirect('/shopping');
            else
                res.redirect('/inventory');
        } else {
            // Invalid credentials
            req.flash('error', 'Invalid email or password.');
            res.redirect('/login');
        }
    });
});

// add-to-cart uses product data programmatically; keep existing logic (no rendering by controller)
app.post('/add-to-cart/:id', checkAuthenticated, (req, res) => {
    const productId = parseInt(req.params.id);
    const quantity = parseInt(req.body.quantity) || 1;

    connection.query('SELECT * FROM products WHERE id = ?', [productId], (error, results) => {
        if (error) throw error;

        if (results.length > 0) {
            const product = results[0];

            // Initialize cart in session if not exists
            if (!req.session.cart) {
                req.session.cart = [];
            }

            // Check if product already in cart
            const existingItem = req.session.cart.find(item => item.productId === productId);
            if (existingItem) {
                existingItem.quantity += quantity;
            } else {
                req.session.cart.push({
                    id: product.productId,
                    productName: product.productName,
                    price: product.price,
                    quantity: quantity,
                    image: product.image
                });
            }

            res.redirect('/cart');
        } else {
            res.status(404).send("Product not found");
        }
    });
});

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

    // sort descending and make every 3rd item free
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

    res.render('cart', { cart, promo: { totalBefore, totalAfter, totalSavings, dairyCount: dairyUnitPrices.length }, user: req.session.user });
});

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// View single product - delegate to controller (controller should render product view)
app.get('/product/:id', checkAuthenticated, (req, res) => {
  SupermarketController.getById(req, res);
});

// Render add product form
app.get('/addProduct', checkAuthenticated, checkAdmin, (req, res) => {
    res.render('addProduct', {user: req.session.user } );
});

// Add product - handled by controller; file upload handled by multer middleware
app.post('/addProduct', checkAuthenticated, checkAdmin, upload.single('image'), (req, res) => {
    SupermarketController.add(req, res);
});

// Render update product form - delegate to controller (controller should render updateProduct view)
app.get('/updateProduct/:id', checkAuthenticated, checkAdmin, (req, res) => {
    SupermarketController.getById(req, res);
});

// Update product - handled by controller; file upload handled by multer middleware
app.post('/updateProduct/:id', checkAuthenticated, checkAdmin, upload.single('image'), (req, res) => {
    SupermarketController.update(req, res);
});

// Delete product - handled by controller
app.get('/deleteProduct/:id', checkAuthenticated, checkAdmin, (req, res) => {
    SupermarketController.delete(req, res);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));