const dns = require('dns').promises;
const net = require('net');
const { config } = require('../src/config');
const { readDb } = require('../src/store');
const { getQuotes } = require('../src/services/marketDataService');

function printHeader() {
  console.log('== stock tracker doctor ==');
  console.log(`node: ${process.version}`);
  console.log(`platform: ${process.platform} ${process.arch}`);
  console.log(`cwd: ${process.cwd()}`);
  console.log(`host: ${config.host}`);
  console.log(`port: ${config.port}`);
  console.log(`dataFile: ${config.dataFilePath}`);
  console.log(`marketProviders: ${config.marketDataProviderOrder.join(' -> ')}`);
  if (config.marketDataProviderOrder.includes('twelvedata')) {
    console.log(`twelveDataKey: ${config.twelveDataApiKey ? 'configured' : 'missing'}`);
  }
  if (config.marketDataProviderOrder.includes('alphavantage')) {
    console.log(`alphaVantageKey: ${config.alphaVantageApiKey ? 'configured' : 'missing'}`);
  }
}

function checkStorage() {
  try {
    const db = readDb();
    console.log(`storage: ok (watchlist=${db.watchlist.length}, portfolio=${db.portfolio.length}, chat=${db.chatHistory.length})`);
  } catch (error) {
    console.error('storage: failed');
    console.error(error);
    process.exitCode = 1;
  }
}

async function checkProviderDns() {
  const providerHostMap = {
    nseindia: 'www.nseindia.com',
    alphavantage: 'www.alphavantage.co',
    tradingview: 'scanner.tradingview.com',
    twelvedata: 'api.twelvedata.com',
    yahoo: 'query1.finance.yahoo.com',
  };

  const hosts = Array.from(new Set(
    config.marketDataProviderOrder
      .map((provider) => providerHostMap[provider])
      .filter(Boolean),
  ));

  for (const host of hosts) {
    try {
      const result = await dns.lookup(host);
      console.log(`dns: ok ${host} -> ${result.address}`);
    } catch (error) {
      console.error(`dns: failed ${host} (${error.code || 'ERR'})`);
      process.exitCode = 1;
    }
  }
}

async function checkQuoteProbe() {
  try {
    const quotes = await getQuotes(['RELIANCE.NS']);
    const quote = quotes[0];
    if (!quote) {
      console.error('quote-probe: failed (no quote object)');
      process.exitCode = 1;
      return;
    }

    console.log(
      `quote-probe: symbol=${quote.symbol} price=${quote.regularMarketPrice} source=${quote.source} status=${quote.dataStatus}`,
    );

    if (Array.isArray(quote.providerTrace) && quote.providerTrace.length > 0) {
      console.log(`quote-probe-trace: ${quote.providerTrace.join(' | ')}`);
    }
  } catch (error) {
    console.error(`quote-probe: failed (${error.code || 'ERR'}: ${error.message})`);
    process.exitCode = 1;
  }
}

function checkPort() {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', (error) => {
      console.error('port-bind: failed');
      console.error(`${error.code || 'ERR'}: ${error.message}`);
      if (error.code === 'EADDRINUSE') {
        console.error('hint: another process is already using this port.');
      }
      if (error.code === 'EPERM') {
        console.error('hint: this environment does not allow binding local ports on this interface.');
      }
      process.exitCode = 1;
      resolve();
    });

    server.listen(config.port, config.host, () => {
      console.log('port-bind: ok');
      server.close(() => resolve());
    });
  });
}

async function main() {
  printHeader();
  checkStorage();
  await checkProviderDns();
  await checkQuoteProbe();
  await checkPort();
}

main().catch((error) => {
  console.error('doctor crashed:', error);
  process.exit(1);
});
