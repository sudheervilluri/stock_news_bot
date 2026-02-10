const serverless = require('serverless-http');
const server = require('../server');
const app = server; // require('../server') returns app with .boot attached

// Initialize global state (DB connection) once per cold start
let booted = false;

const handler = serverless(app);

module.exports.handler = async (event, context) => {
    if (!booted) {
        try {
            if (server.boot) {
                await server.boot();
            }
            booted = true;
            console.log('[serverless] Boot successful');
        } catch (error) {
            console.error('[serverless] Boot failed:', error);
            // Fall through to handler, which might return 500 or work in degraded mode
        }
    }
    return handler(event, context);
};
