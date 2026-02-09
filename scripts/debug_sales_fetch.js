
const { getQuarterlyFinancials } = require('../src/services/marketDataService');
require('dotenv').config();

async function debugFetch() {
    const symbol = process.argv[2] || 'RELIANCE';
    console.log(`Debugging fetch for symbol: ${symbol}`);

    try {
        console.log('Calling getQuarterlyFinancials...');
        const data = await getQuarterlyFinancials(symbol, { limit: 10 });
        console.log('Fetch Result:');
        console.log(JSON.stringify(data, null, 2));

        if (data.dataStatus === 'available') {
            console.log('SUCCESS: Data is available.');
        } else {
            console.log(`FAILURE: Data status is ${data.dataStatus}`);
            if (data.message) console.log(`Message: ${data.message}`);
        }
    } catch (error) {
        console.error('CRITICAL ERROR:', error);
    }
}

debugFetch();
