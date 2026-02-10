const session = require('express-session');
const { getUserByUsername, verifyPassword, updateUserPreferences, getUserPreferences } = require('../services/authService');

// Authentication middleware
function requireAuth(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.redirect('/login');
  }
  next();
}

// Optional auth middleware - checks if user is logged in but doesn't require it
function optionalAuth(req, res, next) {
  if (req.session && req.session.user) {
    next();
  } else {
    res.redirect('/login');
  }
}

const MongoStore = require('connect-mongo');

// Initialize session middleware
function initializeSessionMiddleware() {
  return session({
    secret: process.env.SESSION_SECRET || 'your-secret-key-change-in-production',
    resave: false,
    saveUninitialized: false,
    store: MongoStore.create({
      mongoUrl: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stock_news_bot',
      collectionName: 'sessions',
      ttl: 24 * 60 * 60, // 1 day
      autoRemove: 'native',
    }),
    cookie: {
      secure: process.env.NODE_ENV === 'production', // HTTPS only in production
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      sameSite: 'lax', // Improve compatibility
    },
  });
}

// Make user available in all views
function attachUserToLocals(req, res, next) {
  if (req.session && req.session.user) {
    res.locals.user = req.session.user;
    res.locals.isAuthenticated = true;
  } else {
    res.locals.isAuthenticated = false;
  }
  next();
}

module.exports = {
  requireAuth,
  optionalAuth,
  initializeSessionMiddleware,
  attachUserToLocals,
  getUserByUsername,
  verifyPassword,
  updateUserPreferences,
  getUserPreferences,
};
