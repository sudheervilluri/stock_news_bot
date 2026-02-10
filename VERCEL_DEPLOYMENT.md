# Vercel Deployment Guide

Follow these steps to deploy the Stock News Bot to Vercel.

## Prerequisite: Vercel Account
Ensure you have an account at [vercel.com](https://vercel.com) and the Vercel CLI installed (optional, but recommended).

## 1. Project Configuration
The project is already configured for Vercel:
- `vercel.json`: Routes all traffic to `server.js`.
- `server.js`: Modified to export the Express app for Vercel's serverless environment.

## 2. Deploying via Git (Recommended)
1.  Push your latest changes to GitHub.
2.  Go to the Vercel Dashboard and click "Add New... > Project".
3.  Import your GitHub repository.
4.  **Framework Preset**: Select "Other".
5.  **Build Command**: Leave empty (or `npm install` if needed, but Vercel handles this).
6.  **Output Directory**: Leave default.
7.  **Environment Variables**:
    You MUST add the following environment variables in the Vercel dashboard:
    
    | Variable | Value |
    | :--- | :--- |
    | `MONGODB_URI` | Your MongoDB Connection String (e.g. `mongodb+srv://...`) |
    | `MONGODB_DB` | `myDatabase` (or your preferred DB name) |
    | `SESSION_SECRET` | A long random string |
    | `NODE_ENV` | `production` |
    
    *Optional Variables:*
    - `KEEP_ALIVE_ENABLED`: `false` (Vercel has different idle behaviors, keep-alive is mostly for Render)

8.  Click **Deploy**.

## 3. MongoDB IP Whitelist
Vercel uses dynamic IP addresses. To allow Vercel to connect to MongoDB Atlas:
1.  Go to MongoDB Atlas > Network Access.
2.  Add IP Address: `0.0.0.0/0` (Allow Access from Anywhere).
    *Note: This is less secure than a fixed IP but necessary for Vercel serverless functions unless you use peering.*

## 4. Troubleshooting
- **Logs**: Check the "Functions" tab in your Vercel deployment to see server logs.
- **Cold Starts**: Vercel functions go to sleep. The first request might take a few seconds to connect to Mongo.
- **Timeouts**: Vercel has a default execution timeout (usually 10s). Heavy operations might time out.

## 5. Local Fallback
If Vercel cannot connect to MongoDB, the app will try to use local JSON files. However, Vercel file systems are **read-only** at runtime.
- **Implication**: You cannot save new data (watchlist, sales snapshots) to disk on Vercel.
- **Solution**: Ensure MongoDB connectivity is working!
