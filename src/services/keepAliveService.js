const axios = require('axios');
const cron = require('node-cron');
const { config } = require('../config');

let keepAliveTask = null;

function pingKeepAliveUrl() {
    const url = config.keepAliveUrl;
    if (!url) {
        console.log('[keep-alive] No URL configured, skipping ping.');
        return;
    }

    axios.get(url, { timeout: 5000 })
        .then((res) => {
            console.log(`[keep-alive] Ping successful: ${url} (Status: ${res.status})`);
        })
        .catch((error) => {
            console.error(`[keep-alive] Ping failed: ${url} (Error: ${error.message})`);
        });
}

function startKeepAliveService() {
    if (keepAliveTask) {
        keepAliveTask.stop();
        keepAliveTask = null;
    }

    if (!config.keepAliveEnabled) {
        console.log('[keep-alive] Service disabled in config.');
        return;
    }

    const expression = config.keepAliveCron;
    if (!cron.validate(expression)) {
        console.error(`[keep-alive] Invalid cron expression: ${expression}`);
        return;
    }

    console.log(`[keep-alive] Starting service with schedule: ${expression} target: ${config.keepAliveUrl}`);

    // Schedule the task
    keepAliveTask = cron.schedule(expression, () => {
        pingKeepAliveUrl();
    });

    // Run once immediately on startup logic check (optional, but good for verify)
    // setTimeout(pingKeepAliveUrl, 5000); 
}

function stopKeepAliveService() {
    if (keepAliveTask) {
        keepAliveTask.stop();
        keepAliveTask = null;
        console.log('[keep-alive] Service stopped.');
    }
}

module.exports = {
    startKeepAliveService,
    stopKeepAliveService,
};
