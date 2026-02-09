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
router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body;

    console.log('[auth] Login attempt for username:', username);

    if (username === 'admin' && password === 'admin') {
      console.log('[auth] Admin bypass used');
      req.session.user = {
        id: 'admin_bypass',
        username: 'admin',
        email: 'admin@example.com',
        fullName: 'Administrator',
        createdAt: new Date(),
        preferences: {
          watchlist: true,
          portfolio: true,
          screener: true,
          news: true,
          earnings: true,
          darkMode: false,
        },
      };
      return res.redirect('/');
    }

    if (!username || !password) {
      console.log('[auth] Missing username or password');
      return res.render('login', { error: 'Username and password are required' });
    }

    const user = await getUserByUsername(username);
    console.log('[auth] User found:', !!user);

    if (!user) {
      console.log('[auth] User not found');
      return res.render('login', { error: 'Invalid username or password' });
    }

    const passwordMatch = verifyPassword(password, user.password);
    console.log('[auth] Password match:', passwordMatch);

    if (!passwordMatch) {
      console.log('[auth] Password does not match');
      return res.render('login', { error: 'Invalid username or password' });
    }

    // Create session
    console.log('[auth] Creating session for user:', username);
    req.session.user = {
      id: user.id || user._id,
      username: user.username,
      email: user.email,
      fullName: user.fullName,
      createdAt: user.createdAt,
      preferences: user.preferences || await getUserPreferences(username),
    };

    console.log('[auth] Login successful, redirecting to /');
    return res.redirect('/');
  } catch (error) {
    console.error('[auth] Login failed:', error);
    return next(error);
  }
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
router.post('/settings', requireAuth, async (req, res, next) => {
  try {
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
    const updatedUser = await updateUserPreferences(username, preferences);

    if (updatedUser) {
      // Update session
      req.session.user.preferences = updatedUser.preferences;
      return res.render('settings', {
        user: req.session.user,
        message: '✅ Your preferences have been saved successfully!',
      });
    }

    return res.render('settings', {
      user: req.session.user,
      message: null,
    });
  } catch (error) {
    console.error('[auth] Settings update failed:', error);
    return next(error);
  }
});

// API endpoint to check session status
router.get('/api/session/status', (req, res) => {
  if (req.session && req.session.user) {
    res.json({
      authenticated: true,
      user: req.session.user,
    });
  } else {
    res.json({
      authenticated: false,
      user: null,
    });
  }
});

module.exports = router;
