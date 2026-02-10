# Netlify Deployment Guide

Follow these steps to deploy the Stock News Bot to Netlify.

## Prerequisite: Netlify Account
Ensure you have an account at [netlify.com](https://netlify.com).

## 1. Project Configuration
The project is configured for Netlify using:
- `netlify.toml`: Redirects all traffic to the serverless function.
- `functions/api.js`: Wraps the Express app using `serverless-http`.

## 2. Deploying via Git (Recommended)
1.  Push your latest changes to GitHub.
2.  Log in to Netlify and click **"Add new site"** > **"Import an existing project"**.
3.  Connect to GitHub and select your repository.
4.  **Build Settings:**
    -   **Base directory**: (leave empty)
    -   **Build command**: (leave empty)
    -   **Publish directory**: `public` (or leave empty if using `netlify.toml`)
    -   Netlify should detect `netlify.toml` automatically.
5.  **Environment Variables**:
    You **MUST** add the following environment variables in "Site configuration > Environment variables":
    
    | Variable | Value |
    | :--- | :--- |
    | `MONGODB_URI` | Your MongoDB Connection String |
    | `MONGODB_DB` | `myDatabase` (or your preferred DB name) |
    | `SESSION_SECRET` | A long random string |
    | `NODE_ENV` | `production` |

6.  Click **Deploy**.

## 3. MongoDB IP Whitelist
Netlify Functions use dynamic IP addresses (AWS Lambda).
-   **Action**: Whitelist `0.0.0.0/0` in MongoDB Atlas Network Access.

## 4. Troubleshooting
-   **Logs**: Go to the "Functions" tab in Netlify to see execution logs.
-   **Cold Starts**: The first request might take a few seconds.
-   **"File not found"**: Ensure `process.cwd()` logic in `server.js` is working (it should be).

## 5. Local Development
You can test the function locally using Netlify CLI:
```bash
npm install -g netlify-cli
netlify dev
```
Or simply run `npm start` as usual, which bypasses the serverless wrapper.
