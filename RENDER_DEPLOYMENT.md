# Render Deployment & MongoDB Troubleshooting

If your app is deployed on Render but cannot connect to MongoDB ("MongoNetworkError" or timeouts), follow these steps to fix it.

## 1. Whitelist IP Address in MongoDB Atlas

Render uses dynamic IP addresses, so you cannot whitelist a single IP. You must allow access from **anywhere** (or use a dedicated static IP add-on, which costs extra).

1.  Log in to your [MongoDB Atlas Dashboard](https://cloud.mongodb.com/).
2.  Go to **Network Access** (under "Security" on the left sidebar).
3.  Click **+ Add IP Address**.
4.  Select **Allow Access from Anywhere** (or enter `0.0.0.0/0`).
5.  Click **Confirm**.
    *   *Note: It may take 1-2 minutes for this change to propagate.*

## 2. Verify Environment Variables on Render

Ensure your Render service has the correct environment variables set.

1.  Go to your [Render Dashboard](https://dashboard.render.com/).
2.  Select your web service (`stock-news-bot`).
3.  Go to **Environment**.
4.  Verify (or add) the following keys:
    *   `MONGODB_URI`: Your full connection string (e.g., `mongodb+srv://admin:password@cluster0.abc.mongodb.net/myDatabase?retryWrites=true&w=majority`).
    *   `KEEP_ALIVE_ENABLED`: `true`
    *   `KEEP_ALIVE_URL`: `https://your-app-name.onrender.com/login` (replace `your-app-name` with your actual Render URL).

## 3. Deployment Check

After updating Network Access in Atlas or Environment Variables in Render:
1.  Go to **Manual Deploy** -> **Deploy latest commit** in Render (if it doesn't auto-deploy).
2.  Check the **Logs** tab in Render. You should see:
    ```
    [mongo] connected
    ```


## 4. Troubleshooting "Unavailable" Sales Data

If your app connects to MongoDB but sales data says "Unavailable":
*   This is likely due to **Screener.in blocking Render's IP addresses**.
*   **Solution**: There is no free fix for this on Render. You would need a proxy or a commercial scraping API to bypass the block.

## 5. How to Check Logs & Enable Debug Mode

### Verification
To confirm that MongoDB is connected, look at the **Logs** tab in your Render dashboard after deployment. You should see a line exactly like this:
```
[mongo] connected
```
If you see `[mongo] connection failed`, check your whitelisting settings (Step 1).

### Enable Debug Mode
To see detailed logs about what the app is doing (e.g., fetching data, errors):
1.  Go to **Environment** in Render.
2.  Add a new variable:
    *   `MARKET_DATA_DEBUG`: `true`
3.  Redeploy.
4.  Check the **Logs** tab. You will now see verbose output starting with `[market-data]`.
