# Authentication System - User Guide

## Login Credentials
- **Username**: `admin`
- **Password**: `admin`

## Features

### 1. Login Page (`/login`)
- Clean, modern gradient UI
- Default credentials: admin/admin
- Error messages for invalid login
- Demo credentials displayed on page

### 2. Profile Page (`/profile`)
After logging in, visit `/profile` to see:
- User avatar with initial
- Full name and email
- Account creation date
- Badge showing account status
- Display preferences status:
  - ✓ Watchlist
  - ✓ Portfolio
  - ✓ Screener
  - ✓ News
  - ✓ Earnings
  - ✓ Dark Mode (currently disabled)

### 3. Settings Page (`/settings`)
Visit `/settings` to customize your dashboard:

**Display Preferences** (toggle each section):
- 📊 **Watchlist** - View and manage stock watchlist
- 💼 **Portfolio** - Track investment positions
- 🔍 **Screener** - Use stock screening tools
- 📰 **News Feed** - View latest market news
- 📅 **Earnings Calendar** - Track earnings reports
- 🌙 **Dark Mode** - Enable dark theme

All sections are **enabled by default**.

## How It Works

### Navigation
From any authenticated page, use the top navigation bar:
- 📈 **Stock News Bot** - Logo/Home link
- 👤 **Profile** - View account details
- ⚙️ **Settings** - Configure preferences
- 📊 **Dashboard** - Go to main app
- **Logout** - End your session

### Session Management
- Sessions last **24 hours**
- Preferences are automatically saved
- Logout destroys the session

### Data Storage
- User data stored in `data/users.json`
- Passwords hashed with bcryptjs (secure)
- Preferences persisted per user

## Security

### Password Hashing
Passwords are securely hashed using bcryptjs with 10 salt rounds. The stored hash is:
```
$2a$10$C.O9jrfNIVTSwe.yWafI4eNcM.Pu10EbL9quqXvMkoCumGUN6GrL2
```

### Session Security
- Sessions use HTTP-only cookies (safe from XSS)
- 24-hour expiration
- Automatic logout on browser close (recommended)

## Adding More Users

To add a new user to `data/users.json`:

1. Generate a password hash:
```bash
node -e "const bcrypt = require('bcryptjs'); console.log(bcrypt.hashSync('yourpassword', 10));"
```

2. Add to `data/users.json`:
```json
{
  "id": 2,
  "username": "newuser",
  "password": "PASTE_HASH_HERE",
  "email": "newuser@example.com",
  "fullName": "New User",
  "createdAt": "2026-02-08T00:00:00Z",
  "preferences": {
    "watchlist": true,
    "portfolio": true,
    "screener": true,
    "news": true,
    "earnings": true,
    "darkMode": false
  }
}
```

## File Structure

```
stock_news_bot/
├── views/
│   ├── login.ejs          # Login page
│   ├── profile.ejs        # Profile page
│   ├── settings.ejs       # Settings page
│   └── index.ejs          # Old main page (EJS)
├── src/
│   ├── services/
│   │   └── authService.js # Authentication logic
│   ├── middleware/
│   │   └── authMiddleware.js # Auth middleware
│   └── routes/
│       └── authRoutes.js  # Auth routes (/login, /profile, /settings)
├── data/
│   └── users.json         # User data store
└── server.js              # Main server (updated with auth)
```

## Routes

### Public Routes
- `GET /login` - Login page
- `POST /login` - Handle login

### Protected Routes (require authentication)
- `GET /profile` - User profile
- `GET /settings` - Settings page
- `POST /settings` - Save preferences
- `GET /logout` - Logout

### API Routes
- `GET /` - Main dashboard (protected)
- All `/api/*` routes - Protected APIs

## Environment Variables

Optional (for production):
```env
SESSION_SECRET=your-secret-key-change-in-production
NODE_ENV=production
```

## Troubleshooting

### "Invalid username or password"
- Ensure username is exactly `admin` (case-sensitive)
- Ensure password is exactly `admin`
- Check that `/data/users.json` file exists

### Session not persisting
- Clear browser cookies for localhost:3000
- Restart the server
- Check browser console for errors

### Password hash errors
- Regenerate the hash using the command above
- Replace the password field in `data/users.json`
- Restart the server

## Future Enhancements

Possible improvements:
1. Add "Remember Me" checkbox
2. Implement password change functionality
3. Add email verification
4. Add two-factor authentication
5. Implement user registration
6. Add admin user management panel
7. Sync preferences with main dashboard state
8. Dark mode actually toggle UI colors

---

**Last Updated**: February 8, 2026
