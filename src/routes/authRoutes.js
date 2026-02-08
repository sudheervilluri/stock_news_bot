const express = require('express');
const {
  requireAuth,
  optionalAuth,
  getUserByUsername,
  verifyPassword,
  updateUserPreferences,
  getUserPreferences,
} = require('../middleware/authMiddleware');

const router = express.Router();

// Login page
router.get('/login', (req, res) => {
  if (req.session && req.session.user) {
    return res.redirect('/');
  }
  res.render('login', { error: null });
});

// Handle login
router.post('/login', (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.render('login', { error: 'Username and password are required' });
  }

  const user = getUserByUsername(username);

  if (!user || !verifyPassword(password, user.password)) {
    return res.render('login', { error: 'Invalid username or password' });
  }

  // Create session
  req.session.user = {
    id: user.id,
    username: user.username,
    email: user.email,
    fullName: user.fullName,
    createdAt: user.createdAt,
    preferences: user.preferences || getUserPreferences(username),
  };

  res.redirect('/');
});

// Logout
router.get('/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Error destroying session:', err);
    }
    res.redirect('/login');
  });
});

// Profile page
router.get('/profile', requireAuth, (req, res) => {
  res.render('profile', { user: req.session.user });
});

// Settings page
router.get('/settings', requireAuth, (req, res) => {
  res.render('settings', { user: req.session.user, message: null });
});

// Handle settings update
router.post('/settings', requireAuth, (req, res) => {
  const { username } = req.session.user;
  
  // Prepare preferences object
  const preferences = {
    watchlist: Boolean(req.body.watchlist),
    portfolio: Boolean(req.body.portfolio),
    screener: Boolean(req.body.screener),
    news: Boolean(req.body.news),
    earnings: Boolean(req.body.earnings),
    darkMode: Boolean(req.body.darkMode),
  };

  // Update preferences in database
  const updatedUser = updateUserPreferences(username, preferences);

  if (updatedUser) {
    // Update session
    req.session.user.preferences = updatedUser.preferences;
    res.render('settings', { 
      user: req.session.user, 
      message: '✅ Your preferences have been saved successfully!' 
    });
  } else {
    res.render('settings', { 
      user: req.session.user, 
      message: null 
    });
  }
});

module.exports = router;
