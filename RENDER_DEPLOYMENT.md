# Deploy Stock News Bot to Render

## Overview
This guide walks you through deploying the Stock News Bot to Render's free tier platform.

## Prerequisites
1. GitHub account with this repository
2. Render account (free at https://render.com)
3. API keys for:
   - Alpha Vantage (free from https://www.alphavantage.co/)
   - Twelve Data (optional, free from https://twelvedata.com/)
   - News API (optional, free from https://newsapi.org/)

## Step 1: Push to GitHub
```bash
cd /Users/sudheerv/Documents/Code/stock_news_bot
git add .
git commit -m "Prepare for Render deployment"
git push origin main
```

## Step 2: Connect to Render

1. Go to https://dashboard.render.com
2. Click **New +** → **Web Service**
3. Select **Deploy an existing project from a Git repository**
4. Click **Connect account** to authorize GitHub
5. Select this repository: `stock_news_bot`
6. Configure the service:
   - **Name**: `stock-news-bot` (or your preferred name)
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: `Free`

## Step 3: Add Environment Variables

In Render dashboard, go to **Environment** tab and add these variables:

### Required API Keys
```
ALPHA_VANTAGE_API_KEY=your_key_here
TWELVE_DATA_API_KEY=your_key_here
NEWS_API_KEY=your_key_here  # optional
```

### Default Configuration (already set in render.yaml)
- `NODE_ENV=production`
- `HOST=0.0.0.0`
- `PORT=3000`
- `MARKET_DATA_PROVIDER_ORDER=nseindia,tradingview,yahoo`
- Other settings from `.env.example`

## Step 4: Deploy

1. Click **Create Web Service**
2. Render will automatically:
   - Pull your code from GitHub
   - Run `npm install`
   - Start the application with `npm start`
3. Visit the URL provided (e.g., `https://stock-news-bot.onrender.com`)

## Important Notes

### Free Tier Limitations
- **Spins down after 15 minutes of inactivity** - Your app will go to sleep. First request takes ~30 seconds to wake up.
- **Limited resources** - 512MB RAM, shared CPU
- **Daily restarts** - App restarts daily
- **No persistent storage** - Data files reset (see below)

### Data Persistence
The app uses MongoDB when `MONGODB_URI` is configured (and falls back to `data/db.json`). Since Render doesn't persist files between restarts:

**Option 1: Accept Data Loss**
- Watchlist and portfolio reset daily
- News and market data cached but not persistent

**Option 2: Use MongoDB (Recommended)**
- Add MongoDB Atlas (free tier: 512MB)
- Set `MONGODB_URI` (and optionally `MONGODB_DB`) in Render environment variables

**Option 3: Upgrade to Paid Plan**
- Paid plans have persistent disks
- Recommended if you want to keep watchlist data

### Automatic Redeploy
Render automatically redeploys when you push to GitHub. To manually redeploy:
1. Go to dashboard
2. Click your service
3. **Manual Deploy** → **Deploy latest commit**

## Troubleshooting

### App keeps spinning down
This is normal on free tier. Use a monitoring service (like UptimeRobot) to ping it every 14 minutes to keep it awake.

### API Rate Limits
Monitor your API usage:
- **Alpha Vantage**: 5 requests/minute (free tier)
- **Twelve Data**: 800 requests/day (free tier)
- **News API**: 100 requests/day (free tier)

Adjust cron schedules in `.env` if hitting limits.

### View Logs
In Render dashboard, click your service → **Logs** tab to see real-time application logs.

## Upgrade to Paid Plans

When ready to scale:
1. Choose appropriate plan at https://render.com/pricing
2. Change **Plan** setting in your service
3. Render charges per hour of actual usage (paid plans have persistent disks)

## Auto-Wake Script (Optional)

To prevent spin-down, add this external monitoring:

Using UptimeRobot (free):
1. Go to https://uptimerobot.com
2. Create new monitor → HTTP(S)
3. URL: Your Render app URL
4. Interval: 5 minutes
5. Alerts (optional): Email on downtime

This pings your app every 5 minutes, keeping it active.

## Next Steps

- Monitor logs for errors
- Test all features (watchlist, portfolio, news)
- Consider upgrading to paid plan if persistent data needed
- Set up monitoring for uptime

---

**Questions?** Check Render docs: https://render.com/docs
