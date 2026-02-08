# Quick Render Deployment Checklist

## ✅ What We've Done
Your repo is now **fully compatible with Render**:

### Changes Made:
1. ✅ **Modified `src/config.js`** - Host changed from `127.0.0.1` → `0.0.0.0` (allows public access)
2. ✅ **Updated `.env.example`** - Reflects correct host for Render
3. ✅ **Added `Procfile`** - Tells Render how to start the app
4. ✅ **Added `render.yaml`** - Infrastructure as Code (all config in one file)
5. ✅ **Created `RENDER_DEPLOYMENT.md`** - Complete deployment guide with troubleshooting

### Pushed to GitHub:
✅ All changes committed and pushed to main branch

---

## 🚀 Next Steps - Deploy to Render (5 minutes)

### 1. Get Your API Keys
Copy these values (you'll need them):
- **Alpha Vantage**: https://www.alphavantage.co/api/ (free)
- **Twelve Data**: https://twelvedata.com (free tier)
- **News API**: https://newsapi.org/ (optional)

### 2. Create Render Account
Go to https://render.com/register (free signup)

### 3. Deploy
1. Dashboard → **New +** → **Web Service**
2. Select **Deploy an existing project from a Git repository**
3. Authorize GitHub and select `stock_news_bot`
4. Fill in:
   - Name: `stock-news-bot`
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Plan: **Free**
5. Click **Create Web Service**

### 4. Add Environment Variables
In Render dashboard → Your service → **Environment**:

```
ALPHA_VANTAGE_API_KEY=your_key
TWELVE_DATA_API_KEY=your_key
NEWS_API_KEY=your_key (optional)
```

### 5. Done! 🎉
Your app will deploy automatically. Visit the URL provided.

---

## 📋 Important Notes

### Free Tier Limitations:
- **Spins down after 15 minutes of inactivity** (first request takes ~30s)
- **512MB RAM, shared CPU**
- **No persistent storage** (data resets daily)

### Keep App Awake (Optional):
Use **UptimeRobot** (free) to ping your app every 5 minutes:
1. https://uptimerobot.com
2. Create HTTP(S) monitor → Your Render URL
3. Set interval to 5 minutes

### Persistent Data:
MongoDB is supported via `MONGODB_URI`. For persistent data:
- **Option 1**: Accept daily resets (JSON fallback)
- **Option 2**: Add MongoDB Atlas (free 512MB) and set `MONGODB_URI`
- **Option 3**: Upgrade to Render paid plan

---

## 📖 Full Documentation
See **RENDER_DEPLOYMENT.md** in root directory for detailed guide, troubleshooting, and upgrade paths.

---

## 🔗 Useful Links
- Render Dashboard: https://dashboard.render.com
- Render Docs: https://render.com/docs
- This Project on GitHub: https://github.com/sudheervilluri/stock_news_bot
