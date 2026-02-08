import fetch from "node-fetch"; // install: npm install node-fetch

const stocks = [
"AFFLE"
];

const API_KEY = "5ebd3faa2ddf4b668eb00e207d1f8fe3";
const BASE_URL = "https://api.twelvedata.com/rsi";

const rsiData = {};

async function fetchRSI(stock) {
  const params = new URLSearchParams({
    symbol: stock,
    interval: "1week",
    apikey: API_KEY
  });
  try {
    const response = await fetch(`${BASE_URL}?${params.toString()}`);
    const data = await response.json();
    if (response.status === 200 && data.values) {
      if (data.values.length > 0) {
        return data.values[0].rsi;
      } else {
        return "No data available";
      }
    } else {
      return `Error: ${data.message || "Unknown error"}`;
    }
  } catch (e) {
    return `Request failed: ${e}`;
  }
}

async function main() {
  for (let i = 0; i < stocks.length; i++) {
    if (i > 0 && i % 8 === 0) {
      console.log("Pausing for 60 seconds to respect API rate limits...");
      await new Promise(r => setTimeout(r, 60000));
    }
    const stock = stocks[i];
    const rsi = await fetchRSI(stock);
    rsiData[stock] = rsi;
  }

// Print the results in a structured format
  for (const [stock, rsi] of Object.entries(rsiData)) {
    console.log(`${stock}: ${rsi}`);
  }
}

main();