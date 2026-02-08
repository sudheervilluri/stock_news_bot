const axios = require('axios');
const { config } = require('../config');
const { normalizeIndianSymbol, stripExchangeSuffix } = require('../utils/symbols');
const { getSymbolMasterItems } = require('./symbolMasterService');

const YAHOO_HOSTS = [
  'https://query1.finance.yahoo.com',
  'https://query2.finance.yahoo.com',
];
const YAHOO_QUOTE_PATH = '/v7/finance/quote';
const YAHOO_CHART_PATH = '/v8/finance/chart';
const SCREENER_BASE_URL = 'https://www.screener.in/company';
const BSE_QUOTE_PATH = 'https://api.bseindia.com/BseIndiaAPI/api/getScripHeaderData/w';
const BSE_GRAPH_PATHS = [
  'https://api.bseindia.com/BseIndiaAPI/api/StockReachGraph/w',
  'https://api.bseindia.com/BseIndiaAPI/api/GraphData/w',
];
const NSE_HISTORICAL_PATH = 'https://www.nseindia.com/api/historical/cm/equity';

const quoteCache = new Map();
const technicalCache = new Map();
const quarterlyFinancialCache = new Map();
const TECHNICAL_CACHE_TTL_MS = 30 * 60 * 1000;
const TECHNICAL_NULL_CACHE_TTL_MS = 2 * 60 * 1000;
const QUARTERLY_FINANCIAL_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const QUARTERLY_FINANCIAL_UNAVAILABLE_CACHE_TTL_MS = 0;
const TECHNICAL_LOOKBACK_DAYS = 720;

let nseCookieHeader = '';
let nseCookieFetchedAt = 0;
let bseCookieHeader = '';
let bseCookieFetchedAt = 0;

const nseBaseHeaders = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept: 'application/json,text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
  DNT: '1',
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
};

const bseBaseHeaders = {
  'User-Agent': nseBaseHeaders['User-Agent'],
  Accept: 'application/json,text/plain,*/*',
  'Accept-Language': nseBaseHeaders['Accept-Language'],
  DNT: '1',
  Pragma: 'no-cache',
  'Cache-Control': 'no-cache',
  Origin: 'https://www.bseindia.com',
  Referer: 'https://www.bseindia.com/',
};

function logDebug(message, meta) {
  if (!config.marketDataDebug) {
    return;
  }

  if (meta !== undefined) {
    console.log(`[market-data] ${message}`, meta);
    return;
  }

  console.log(`[market-data] ${message}`);
}

function shortError(error) {
  if (!error) {
    return 'unknown';
  }

  const code = error.code || error.response?.status || 'ERR';
  const message = error.message || String(error);
  return `${code}:${message}`.slice(0, 180);
}

function now() {
  return Date.now();
}

function formatDateDdMmYyyy(date) {
  const value = date instanceof Date ? date : new Date(date);
  const day = String(value.getDate()).padStart(2, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const year = value.getFullYear();
  return `${day}-${month}-${year}`;
}

function formatDateDdMmYyyySlash(date) {
  return formatDateDdMmYyyy(date).replace(/-/g, '/');
}

function parseNseDate(value) {
  if (!value) {
    return null;
  }

  const asDate = new Date(value);
  if (!Number.isNaN(asDate.getTime())) {
    return asDate;
  }

  const match = String(value).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!match) {
    return null;
  }

  const [, ddRaw, monRaw, yyyyRaw] = match;
  const months = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5,
    JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
  };
  const month = months[monRaw.toUpperCase()];
  if (month === undefined) {
    return null;
  }

  const date = new Date(Number(yyyyRaw), month, Number(ddRaw));
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseMarketDate(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      return null;
    }
    const ms = value > 1e12 ? value : value * 1000;
    const parsed = new Date(ms);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const raw = String(value).trim();
  if (!raw) {
    return null;
  }

  const dotNetMatch = raw.match(/\/Date\((\d+)\)\//i);
  if (dotNetMatch) {
    const parsed = new Date(Number(dotNetMatch[1]));
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const asNse = parseNseDate(raw);
  if (asNse) {
    return asNse;
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    return parsed;
  }

  const slashMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!slashMatch) {
    return null;
  }

  const [, ddRaw, mmRaw, yyyyRaw] = slashMatch;
  const slashDate = new Date(Number(yyyyRaw), Number(mmRaw) - 1, Number(ddRaw));
  return Number.isNaN(slashDate.getTime()) ? null : slashDate;
}

function toIsoWeekKey(dateInput) {
  const date = new Date(Date.UTC(
    dateInput.getUTCFullYear(),
    dateInput.getUTCMonth(),
    dateInput.getUTCDate(),
  ));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((date - yearStart) / 86400000) + 1) / 7);
  return `${date.getUTCFullYear()}-${String(weekNo).padStart(2, '0')}`;
}

function dailyToWeeklyCloses(series) {
  if (!Array.isArray(series) || series.length === 0) {
    return [];
  }

  const weeklyMap = new Map();
  for (const item of series) {
    const ts = toNumber(item?.ts);
    const close = toNumber(item?.close);
    if (ts === null || close === null) {
      continue;
    }

    const date = new Date(ts * 1000);
    const key = toIsoWeekKey(date);
    const existing = weeklyMap.get(key);
    if (!existing || ts > existing.ts) {
      weeklyMap.set(key, { ts, close });
    }
  }

  return Array.from(weeklyMap.values())
    .sort((a, b) => a.ts - b.ts)
    .map((item) => item.close);
}

function cacheKey(symbol) {
  return normalizeIndianSymbol(symbol);
}

function isFresh(entry) {
  return entry && (now() - entry.fetchedAt) <= config.marketCacheTtlMs;
}

function isTechnicalFresh(entry) {
  if (!entry) {
    return false;
  }

  const ttl = entry.value ? TECHNICAL_CACHE_TTL_MS : TECHNICAL_NULL_CACHE_TTL_MS;
  return (now() - entry.fetchedAt) <= ttl;
}

function asList(input) {
  return Array.from(new Set(
    (input || [])
      .map((symbol) => normalizeIndianSymbol(symbol))
      .filter(Boolean),
  ));
}

function toNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string') {
    const cleaned = value
      .replace(/,/g, '')
      .replace(/%/g, '')
      .trim();

    if (!cleaned || cleaned === '-' || cleaned === '--' || cleaned.toUpperCase() === 'NA' || cleaned.toUpperCase() === 'N/A') {
      return null;
    }

    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function firstFinite(...values) {
  for (const value of values) {
    const parsed = toNumber(value);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

function lastFinite(values) {
  if (!Array.isArray(values)) {
    return null;
  }

  for (let index = values.length - 1; index >= 0; index -= 1) {
    const parsed = toNumber(values[index]);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

function toYahooSymbol(symbol) {
  const normalized = normalizeIndianSymbol(symbol);
  if (normalized.endsWith('.NS') || normalized.endsWith('.BO')) {
    return normalized;
  }

  return `${stripExchangeSuffix(normalized)}.NS`;
}

function toTradingViewTicker(symbol) {
  const normalized = normalizeIndianSymbol(symbol);
  const base = stripExchangeSuffix(normalized);
  const exchange = normalized.endsWith('.BO') ? 'BSE' : 'NSE';
  return `${exchange}:${base}`;
}

function toScreenerCompanyCode(symbol) {
  const normalized = normalizeIndianSymbol(symbol);
  if (!normalized.endsWith('.BO')) {
    return '';
  }

  const base = stripExchangeSuffix(normalized);
  return /^\d{5,6}$/.test(base) ? base : '';
}

function toScreenerCompanyCandidates(symbol) {
  const normalized = normalizeIndianSymbol(symbol);
  const base = stripExchangeSuffix(normalized);
  const candidates = [];

  const numericCode = toScreenerCompanyCode(normalized);
  if (numericCode) {
    candidates.push(numericCode);
  }

  if (/^[A-Z][A-Z0-9\-_.]{1,24}$/.test(base)) {
    candidates.push(base);
  }

  return Array.from(new Set(candidates));
}

function toScreenerUrlsForSymbol(symbol) {
  const companyIds = toScreenerCompanyCandidates(symbol);
  const urls = [];

  for (const companyId of companyIds) {
    urls.push(`${SCREENER_BASE_URL}/${companyId}/consolidated/`);
    urls.push(`${SCREENER_BASE_URL}/${companyId}/standalone/`);
    urls.push(`${SCREENER_BASE_URL}/${companyId}/`);
  }

  return Array.from(new Set(urls));
}

function decodeHtmlEntities(raw) {
  return String(raw || '')
    .replace(/&#8377;|&\#x20B9;|&inr;/gi, '₹')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function htmlToPlainText(html) {
  return decodeHtmlEntities(String(html || ''))
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractFirstMatch(text, patterns, groupIndex = 1) {
  for (const pattern of patterns) {
    const match = String(text || '').match(pattern);
    if (match && match[groupIndex]) {
      return String(match[groupIndex]).trim();
    }
  }
  return '';
}

function parseMarketCapWithUnit(valueRaw, unitRaw) {
  const value = toNumber(valueRaw);
  if (value === null) {
    return null;
  }

  const unit = String(unitRaw || '').trim().toUpperCase();
  if (!unit) {
    return value;
  }
  if (unit.startsWith('CR') || unit.startsWith('CRORE')) {
    return value * 1e7;
  }
  if (unit.startsWith('LAC') || unit.startsWith('LAKH')) {
    return value * 1e5;
  }
  if (unit === 'K') {
    return value * 1e3;
  }
  if (unit.startsWith('M') || unit.startsWith('MN')) {
    return value * 1e6;
  }
  if (unit.startsWith('B') || unit.startsWith('BN')) {
    return value * 1e9;
  }
  return value;
}

function toNumberWithUnits(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== 'string') {
    return toNumber(value);
  }

  const normalized = value
    .replace(/[₹$]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized) {
    return null;
  }

  const scaledMatch = normalized.match(/^([+-]?[0-9,]+(?:\.[0-9]+)?)\s*(CR|CRORE|LAC|LAKH|K|M|MN|B|BN)\.?$/i);
  if (scaledMatch) {
    return parseMarketCapWithUnit(scaledMatch[1], scaledMatch[2]);
  }

  return toNumber(normalized);
}

function firstWithUnits(...values) {
  for (const value of values) {
    const parsed = toNumberWithUnits(value);
    if (parsed !== null) {
      return parsed;
    }
  }
  return null;
}

function calculateSma(values, period, endExclusive = values.length) {
  if (!Array.isArray(values) || period <= 0 || endExclusive < period) {
    return null;
  }

  const start = endExclusive - period;
  let sum = 0;
  for (let index = start; index < endExclusive; index += 1) {
    const value = toNumber(values[index]);
    if (value === null) {
      return null;
    }
    sum += value;
  }

  return sum / period;
}

function calculateEma(values, period) {
  if (!Array.isArray(values) || period <= 0 || values.length < period) {
    return null;
  }

  const seed = calculateSma(values, period);
  if (seed === null) {
    return null;
  }

  const multiplier = 2 / (period + 1);
  let ema = seed;

  for (let index = period; index < values.length; index += 1) {
    const price = toNumber(values[index]);
    if (price === null) {
      continue;
    }
    ema = ((price - ema) * multiplier) + ema;
  }

  return Number(ema.toFixed(4));
}

function calculateEmaRelaxed(values, period) {
  if (!Array.isArray(values) || period <= 0 || values.length === 0) {
    return null;
  }

  let ema = toNumber(values[0]);
  if (ema === null) {
    return null;
  }

  const multiplier = 2 / (period + 1);
  for (let index = 1; index < values.length; index += 1) {
    const price = toNumber(values[index]);
    if (price === null) {
      continue;
    }
    ema = ((price - ema) * multiplier) + ema;
  }

  return Number(ema.toFixed(4));
}

function classifyWeinsteinStage(input) {
  const close = toNumber(input?.close);
  const sma30Week = toNumber(input?.sma30Week);
  const prevSma30Week = toNumber(input?.prevSma30Week);

  if (close === null || sma30Week === null || prevSma30Week === null) {
    return '';
  }

  const slopePct = prevSma30Week !== 0
    ? ((sma30Week - prevSma30Week) / prevSma30Week) * 100
    : 0;
  const priceAbove30Week = close >= sma30Week;
  const rising = slopePct > 0.05;
  const falling = slopePct < -0.05;

  if (priceAbove30Week && rising) {
    return 'Markup';
  }

  if (!priceAbove30Week && falling) {
    return 'Markdown';
  }

  if (priceAbove30Week) {
    return 'Accumulation';
  }

  return 'Distribution';
}

function classifyStageFromEmaProxy(input) {
  const close = toNumber(input?.close);
  const ema50 = toNumber(input?.ema50);
  const ema200 = toNumber(input?.ema200);

  if (close === null || ema50 === null || ema200 === null) {
    return '';
  }

  if (close >= ema200 && ema50 >= ema200) {
    return 'Markup';
  }

  if (close < ema200 && ema50 < ema200) {
    return 'Markdown';
  }

  if (close >= ema200) {
    return 'Accumulation';
  }

  return 'Distribution';
}

function parseScreenerQuoteFromHtml(symbol, html) {
  const text = htmlToPlainText(html);
  if (!text) {
    return null;
  }

  const nameFromHeading = extractFirstMatch(html, [
    /<h1[^>]*>\s*([\s\S]*?)\s*<\/h1>/i,
  ]);
  const shortName = decodeHtmlEntities(nameFromHeading).replace(/\s+/g, ' ').trim() || stripExchangeSuffix(symbol);

  const priceMatch = text.match(/Current Price\s*₹?\s*([0-9,]+(?:\.[0-9]+)?)(?:\s*([+\-−]?\d+(?:\.\d+)?)\s*%)?/i);
  const marketCapMatch = text.match(/Market Cap\s*₹?\s*([0-9,]+(?:\.[0-9]+)?)\s*([A-Za-z.]+)?/i);
  const highLowMatch = text.match(/High\s*\/\s*Low\s*₹?\s*([0-9,]+(?:\.[0-9]+)?)\s*\/\s*([0-9,]+(?:\.[0-9]+)?)/i);
  const peMatch = text.match(/Stock P\/E\s*([0-9,]+(?:\.[0-9]+)?)/i);
  const pbRatioMatch = text.match(/Price to book value\s*([0-9,]+(?:\.[0-9]+)?)/i);
  const bookValueMatch = text.match(/Book Value\s*₹?\s*([0-9,]+(?:\.[0-9]+)?)/i);
  const faceValueMatch = text.match(/Face Value\s*₹?\s*([0-9,]+(?:\.[0-9]+)?)/i);
  const updateMatch = text.match(/(\d{1,2}\s+[A-Za-z]{3}(?:\s+\d{4})?\s*-\s*close price)/i);
  const isinMatch = text.match(/\bISIN\b\s*([A-Z0-9]{12})/i);

  const regularMarketPrice = firstFinite(priceMatch?.[1]);
  let regularMarketChangePercent = firstFinite(priceMatch?.[2]);
  if (regularMarketChangePercent !== null && String(priceMatch?.[2] || '').includes('−')) {
    regularMarketChangePercent *= -1;
  }

  let previousClose = null;
  let regularMarketChange = null;
  if (regularMarketPrice !== null && regularMarketChangePercent !== null) {
    const denominator = 1 + (regularMarketChangePercent / 100);
    if (Math.abs(denominator) > Number.EPSILON) {
      previousClose = Number((regularMarketPrice / denominator).toFixed(4));
      regularMarketChange = Number((regularMarketPrice - previousClose).toFixed(4));
    }
  }

  const fiftyTwoWeekHigh = firstFinite(highLowMatch?.[1]);
  const fiftyTwoWeekLow = firstFinite(highLowMatch?.[2]);
  const marketCap = parseMarketCapWithUnit(marketCapMatch?.[1], marketCapMatch?.[2]);
  const peRatio = firstFinite(peMatch?.[1]);
  const bookValue = firstFinite(bookValueMatch?.[1]);
  const pbRatio = firstFinite(
    pbRatioMatch?.[1],
    regularMarketPrice !== null && bookValue !== null && bookValue > 0
      ? Number((regularMarketPrice / bookValue).toFixed(4))
      : null,
  );
  const faceValue = firstFinite(faceValueMatch?.[1]);

  if (regularMarketPrice === null) {
    return null;
  }

  return normalizeQuoteShape({
    symbol,
    shortName,
    exchange: 'BSE',
    currency: 'INR',
    regularMarketPrice,
    regularMarketChange,
    regularMarketChangePercent,
    regularMarketOpen: null,
    previousClose,
    dayHigh: null,
    dayLow: null,
    regularMarketVolume: null,
    averageDailyVolume3Month: null,
    marketCap,
    fiftyTwoWeekLow,
    fiftyTwoWeekHigh,
    peRatio,
    eps: null,
    pbRatio,
    faceValue,
    vwap: null,
    upperCircuit: null,
    lowerCircuit: null,
    deliveryToTradedQuantity: null,
    industry: '',
    isin: isinMatch?.[1] || '',
    lastUpdateTime: updateMatch?.[1] || '',
    source: 'screener',
    dataStatus: 'delayed',
  });
}

function parseScreenerTechnicalsFromHtml(symbol, html, priceHint = null) {
  const text = htmlToPlainText(html);
  if (!text) {
    return null;
  }

  const ema50Raw = extractFirstMatch(text, [
    /50\s*Day\s*EMA\s*₹?\s*([0-9,]+(?:\.[0-9]+)?(?:\s*(?:CR|CRORE|LAC|LAKH|K|M|MN|B|BN)\.?)?)/i,
    /50\s*DMA\s*₹?\s*([0-9,]+(?:\.[0-9]+)?(?:\s*(?:CR|CRORE|LAC|LAKH|K|M|MN|B|BN)\.?)?)/i,
    /50\s*(?:D|DAY)?\s*(?:EMA|DMA)\s*[:\-]?\s*₹?\s*([0-9,]+(?:\.[0-9]+)?)/i,
    /(?:EMA|DMA)\s*50\s*(?:D|DAY)?\s*[:\-]?\s*₹?\s*([0-9,]+(?:\.[0-9]+)?)/i,
    /₹?\s*([0-9,]+(?:\.[0-9]+)?)\s*(?:50\s*(?:D|DAY)?\s*(?:EMA|DMA))/i,
  ]);
  const ema200Raw = extractFirstMatch(text, [
    /200\s*Day\s*EMA\s*₹?\s*([0-9,]+(?:\.[0-9]+)?(?:\s*(?:CR|CRORE|LAC|LAKH|K|M|MN|B|BN)\.?)?)/i,
    /200\s*DMA\s*₹?\s*([0-9,]+(?:\.[0-9]+)?(?:\s*(?:CR|CRORE|LAC|LAKH|K|M|MN|B|BN)\.?)?)/i,
    /200\s*(?:D|DAY)?\s*(?:EMA|DMA)\s*[:\-]?\s*₹?\s*([0-9,]+(?:\.[0-9]+)?)/i,
    /(?:EMA|DMA)\s*200\s*(?:D|DAY)?\s*[:\-]?\s*₹?\s*([0-9,]+(?:\.[0-9]+)?)/i,
    /₹?\s*([0-9,]+(?:\.[0-9]+)?)\s*(?:200\s*(?:D|DAY)?\s*(?:EMA|DMA))/i,
  ]);
  const sma30WeekRaw = extractFirstMatch(text, [
    /30\s*Week\s*(?:MA|SMA)\s*₹?\s*([0-9,]+(?:\.[0-9]+)?(?:\s*(?:CR|CRORE|LAC|LAKH|K|M|MN|B|BN)\.?)?)/i,
  ]);

  const currentPriceRaw = extractFirstMatch(text, [
    /Current Price\s*₹?\s*([0-9,]+(?:\.[0-9]+)?)/i,
  ]);

  const ema50 = firstWithUnits(ema50Raw);
  const ema200 = firstWithUnits(ema200Raw);
  const thirtyWeekSma = firstWithUnits(sma30WeekRaw);
  const close = firstWithUnits(currentPriceRaw, priceHint);
  if (ema50 === null && ema200 === null) {
    return null;
  }

  let marketCycleStage = '';
  let method = 'ema-proxy';
  if (close !== null && thirtyWeekSma !== null) {
    marketCycleStage = close >= thirtyWeekSma ? 'Markup' : 'Markdown';
    method = 'price-vs-30w';
  } else {
    marketCycleStage = classifyStageFromEmaProxy({ close, ema50, ema200 });
  }

  return {
    ema50,
    ema200,
    thirtyWeekSma,
    marketCycleStage,
    source: `screener-tech:${method}`,
  };
}

function cleanHtmlCellText(raw) {
  return decodeHtmlEntities(String(raw || ''))
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractTableRowsFromHtml(tableHtml) {
  return Array.from(String(tableHtml || '').matchAll(/<tr[^>]*>[\s\S]*?<\/tr>/gi))
    .map((match) => match[0]);
}

function extractCellTextsFromTableRow(rowHtml) {
  return Array.from(String(rowHtml || '').matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi))
    .map((match) => cleanHtmlCellText(match[1]));
}

function normalizeFinancialMetricKey(label) {
  return cleanHtmlCellText(label)
    .toLowerCase()
    .replace(/\+/g, ' plus ')
    .replace(/%/g, ' percent ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function looksLikeQuarterLabel(labelInput) {
  const label = cleanHtmlCellText(labelInput);
  if (!label || /ttm/i.test(label)) {
    return false;
  }

  return /^(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|SEPT|OCT|NOV|DEC)\s+\d{2,4}$/i.test(label)
    || /^Q[1-4]\s+\d{2,4}$/i.test(label)
    || /^\d{1,2}\s*[A-Z]{3}\s*\d{2,4}$/i.test(label);
}

function selectQuarterColumns(headerCells, limit = 6) {
  const safeLimit = Math.min(Math.max(Number(limit) || 6, 1), 8);
  const indexed = (headerCells || []).map((label, index) => ({
    index,
    label: cleanHtmlCellText(label),
  }));

  let quarterCols = indexed.filter((item) => item.index > 0 && looksLikeQuarterLabel(item.label));
  if (quarterCols.length === 0) {
    quarterCols = indexed.filter((item) => item.index > 0 && item.label && !/ttm/i.test(item.label));
  }

  if (quarterCols.length > safeLimit) {
    quarterCols = quarterCols.slice(-safeLimit);
  }

  return quarterCols;
}

function extractQuarterlyTableHtml(html) {
  const source = String(html || '');
  if (!source) {
    return '';
  }

  const sectionMatch = source.match(/<section[^>]*id=(["'])quarters\1[\s\S]*?<\/section>/i);
  if (sectionMatch) {
    const tableInSection = sectionMatch[0].match(/<table[^>]*>[\s\S]*?<\/table>/i);
    if (tableInSection) {
      return tableInSection[0];
    }
  }

  const headingIndex = source.search(/Quarterly\s*Results/i);
  if (headingIndex >= 0) {
    const searchWindow = source.slice(headingIndex, headingIndex + 220000);
    const tableMatch = searchWindow.match(/<table[^>]*>[\s\S]*?<\/table>/i);
    if (tableMatch) {
      return tableMatch[0];
    }
  }

  return '';
}

function parseQuarterlyFinancialTable(tableHtml, limit = 6) {
  const rows = extractTableRowsFromHtml(tableHtml);
  if (rows.length < 2) {
    return {
      quarterLabels: [],
      metrics: [],
    };
  }

  const headerCells = extractCellTextsFromTableRow(rows[0]);
  const quarterColumns = selectQuarterColumns(headerCells, limit);
  if (quarterColumns.length === 0) {
    return {
      quarterLabels: [],
      metrics: [],
    };
  }

  const metrics = [];
  for (let index = 1; index < rows.length; index += 1) {
    const cells = extractCellTextsFromTableRow(rows[index]);
    if (cells.length <= 1) {
      continue;
    }

    const label = cells[0];
    const key = normalizeFinancialMetricKey(label);
    if (!key) {
      continue;
    }

    const values = quarterColumns.map((column) => toNumberWithUnits(cells[column.index]));
    metrics.push({
      key,
      label,
      values,
    });
  }

  return {
    quarterLabels: quarterColumns.map((column) => column.label),
    metrics,
  };
}

function findFinancialSeries(metrics, patterns) {
  for (const metric of metrics || []) {
    if (patterns.some((pattern) => pattern.test(metric.key))) {
      return Array.isArray(metric.values) ? metric.values : [];
    }
  }
  return [];
}

function hasAnySeriesValue(values) {
  return Array.isArray(values) && values.some((value) => toNumber(value) !== null);
}

function normalizeSeriesLength(values, targetLength, decimals = 2) {
  const normalized = [];
  for (let index = 0; index < targetLength; index += 1) {
    const parsed = toNumber(values?.[index]);
    if (parsed === null) {
      normalized.push(null);
      continue;
    }
    normalized.push(Number(parsed.toFixed(decimals)));
  }
  return normalized;
}

function computeGrowthSeries(values, lag = 1) {
  const series = Array.isArray(values) ? values : [];
  return series.map((currentRaw, index) => {
    if (index < lag) {
      return null;
    }

    const current = toNumber(currentRaw);
    const previous = toNumber(series[index - lag]);
    if (current === null || previous === null || Math.abs(previous) < Number.EPSILON) {
      return null;
    }

    return Number((((current - previous) / previous) * 100).toFixed(2));
  });
}

function buildQuarterlyFinancialRows(parsedTable) {
  const quarterLabels = Array.isArray(parsedTable?.quarterLabels) ? parsedTable.quarterLabels : [];
  const metrics = Array.isArray(parsedTable?.metrics) ? parsedTable.metrics : [];
  const valueCount = quarterLabels.length;
  if (valueCount === 0) {
    return [];
  }

  const salesSeries = normalizeSeriesLength(findFinancialSeries(metrics, [
    /^sales\b/,
    /^revenue\b/,
    /^total income\b/,
  ]), valueCount);
  const operatingProfitSeries = normalizeSeriesLength(findFinancialSeries(metrics, [
    /^operating profit\b/,
    /^op profit\b/,
    /^ebitda\b/,
  ]), valueCount);
  const patSeries = normalizeSeriesLength(findFinancialSeries(metrics, [
    /^net profit\b/,
    /\bprofit after tax\b/,
    /^pat\b/,
  ]), valueCount);
  const opmSeries = normalizeSeriesLength(findFinancialSeries(metrics, [
    /^opm\b/,
    /\boperating margin\b/,
  ]), valueCount);
  const epsSeries = normalizeSeriesLength(findFinancialSeries(metrics, [
    /^eps\b/,
  ]), valueCount);

  const salesQoq = normalizeSeriesLength(computeGrowthSeries(salesSeries, 1), valueCount);
  const salesYoy = normalizeSeriesLength(computeGrowthSeries(salesSeries, 4), valueCount);
  const patQoq = normalizeSeriesLength(computeGrowthSeries(patSeries, 1), valueCount);
  const patYoy = normalizeSeriesLength(computeGrowthSeries(patSeries, 4), valueCount);

  const rows = [];
  if (hasAnySeriesValue(salesSeries)) {
    rows.push({ key: 'sales', label: 'Sales', kind: 'number', values: salesSeries });
  }
  if (hasAnySeriesValue(salesQoq)) {
    rows.push({ key: 'sales_qoq', label: 'Sales QoQ %', kind: 'percent', values: salesQoq });
  }
  if (hasAnySeriesValue(salesYoy)) {
    rows.push({ key: 'sales_yoy', label: 'Sales YoY %', kind: 'percent', values: salesYoy });
  }
  if (hasAnySeriesValue(operatingProfitSeries)) {
    rows.push({ key: 'operating_profit', label: 'Operating Profit', kind: 'number', values: operatingProfitSeries });
  }
  if (hasAnySeriesValue(patSeries)) {
    rows.push({ key: 'pat', label: 'PAT', kind: 'number', values: patSeries });
  }
  if (hasAnySeriesValue(patQoq)) {
    rows.push({ key: 'pat_qoq', label: 'PAT QoQ %', kind: 'percent', values: patQoq });
  }
  if (hasAnySeriesValue(patYoy)) {
    rows.push({ key: 'pat_yoy', label: 'PAT YoY %', kind: 'percent', values: patYoy });
  }
  if (hasAnySeriesValue(opmSeries)) {
    rows.push({ key: 'opm', label: 'OPM %', kind: 'percent', values: opmSeries });
  }
  if (hasAnySeriesValue(epsSeries)) {
    rows.push({ key: 'eps', label: 'EPS', kind: 'number', values: epsSeries });
  }

  return rows;
}

function parseQuarterlyFinancialsFromScreenerHtml(symbol, html, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 6, 1), 8);
  const headingName = decodeHtmlEntities(extractFirstMatch(html, [
    /<h1[^>]*>\s*([\s\S]*?)\s*<\/h1>/i,
  ])).replace(/\s+/g, ' ').trim();
  const companyName = headingName || stripExchangeSuffix(symbol);

  const tableHtml = extractQuarterlyTableHtml(html);
  if (!tableHtml) {
    return {
      companyName,
      quarterLabels: [],
      rows: [],
    };
  }

  const parsedTable = parseQuarterlyFinancialTable(tableHtml, limit);
  const rows = buildQuarterlyFinancialRows(parsedTable);

  return {
    companyName,
    quarterLabels: parsedTable.quarterLabels,
    rows,
  };
}

function isQuarterlyFinancialFresh(entry) {
  if (!entry || !entry.value) {
    return false;
  }

  const hasRows = Array.isArray(entry.value.rows) && entry.value.rows.length > 0;
  const dataStatus = String(entry.value.dataStatus || '').toLowerCase();
  const isAvailable = hasRows || dataStatus === 'available';
  const ttl = isAvailable
    ? QUARTERLY_FINANCIAL_CACHE_TTL_MS
    : QUARTERLY_FINANCIAL_UNAVAILABLE_CACHE_TTL_MS;

  if (ttl <= 0) {
    return false;
  }

  return (now() - entry.fetchedAt) <= ttl;
}

function buildQuarterlyFinancialSymbolCandidates(symbol) {
  const normalized = normalizeIndianSymbol(symbol);
  const candidates = new Set([normalized]);

  const aliases = buildTechnicalAliasCandidates(normalized, '');
  aliases.forEach((alias) => candidates.add(alias));

  return Array.from(candidates)
    .map((item) => normalizeIndianSymbol(item))
    .filter(Boolean);
}

function companyNameToTickerGuess(name) {
  const stopWords = new Set([
    'LTD',
    'LIMITED',
    'INDIA',
    'INDIAN',
    'COMPANY',
    'PVT',
    'PRIVATE',
    'THE',
    'AND',
    'CO',
    'INC',
    'PLC',
  ]);

  const tokens = String(name || '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((token) => !stopWords.has(token));

  if (tokens.length === 0) {
    return '';
  }

  return tokens.join('').slice(0, 18);
}

function extractTickerCandidatesFromScreenerHtml(symbol, html, nameHint = '') {
  const normalized = normalizeIndianSymbol(symbol);
  const isBse = normalized.endsWith('.BO');
  const text = htmlToPlainText(html);
  const candidates = new Set([normalized]);

  const regex = /\b(NSE|BSE)\s*[:\-]\s*([A-Z0-9]{2,20})\b/gi;
  for (const match of text.matchAll(regex)) {
    const exchange = String(match[1] || '').toUpperCase();
    const code = String(match[2] || '').toUpperCase();
    if (!code) {
      continue;
    }
    if (exchange === 'NSE' && !/^\d+$/.test(code)) {
      candidates.add(`${code}.NS`);
    }
    if (exchange === 'BSE' && !/^\d+$/.test(code)) {
      candidates.add(`${code}.BO`);
    }
  }

  const nameFromHeading = decodeHtmlEntities(extractFirstMatch(html, [
    /<h1[^>]*>\s*([\s\S]*?)\s*<\/h1>/i,
  ])).replace(/\s+/g, ' ').trim();
  const guessed = companyNameToTickerGuess(nameFromHeading || nameHint || stripExchangeSuffix(normalized));
  if (guessed) {
    if (isBse) {
      candidates.add(`${guessed}.BO`);
    }
    candidates.add(`${guessed}.NS`);
  }

  return Array.from(candidates)
    .map((item) => normalizeIndianSymbol(item))
    .filter(Boolean);
}

function snapshotFromTradingViewQuote(quote, source = 'tradingview-tech') {
  if (!quote) {
    return null;
  }

  const close = firstFinite(quote.regularMarketPrice);
  const ema50 = firstFinite(quote.ema50);
  const ema200 = firstFinite(quote.ema200);
  const thirtyWeekSma = firstFinite(quote.thirtyWeekSma);
  let marketCycleStage = quote.marketCycleStage ? String(quote.marketCycleStage) : '';

  if (!marketCycleStage) {
    marketCycleStage = classifyStageFromEmaProxy({ close, ema50, ema200 });
  }

  if (ema50 === null && ema200 === null && thirtyWeekSma === null && !marketCycleStage) {
    return null;
  }

  return {
    ema50,
    ema200,
    thirtyWeekSma,
    marketCycleStage,
    source,
  };
}

function mergeTechnicalSource(existingSource, candidateSource) {
  const sourceParts = [];

  for (const source of [existingSource, candidateSource]) {
    const normalized = String(source || '').trim();
    if (!normalized) {
      continue;
    }

    normalized.split('+').forEach((part) => {
      const cleanPart = String(part || '').trim();
      if (cleanPart && !sourceParts.includes(cleanPart)) {
        sourceParts.push(cleanPart);
      }
    });
  }

  return sourceParts.join('+');
}

function mergeTechnicalSnapshots(baseSnapshot, candidateSnapshot, priceHint = null) {
  const base = baseSnapshot && typeof baseSnapshot === 'object' ? baseSnapshot : null;
  const candidate = candidateSnapshot && typeof candidateSnapshot === 'object' ? candidateSnapshot : null;

  if (!base && !candidate) {
    return null;
  }

  const close = firstFinite(priceHint);
  const ema50 = firstFinite(base?.ema50, candidate?.ema50);
  const ema200 = firstFinite(base?.ema200, candidate?.ema200);
  const thirtyWeekSma = firstFinite(base?.thirtyWeekSma, candidate?.thirtyWeekSma);
  let marketCycleStage = String(base?.marketCycleStage || '').trim()
    || String(candidate?.marketCycleStage || '').trim();

  if (!marketCycleStage && close !== null && thirtyWeekSma !== null) {
    marketCycleStage = close >= thirtyWeekSma ? 'Markup' : 'Markdown';
  }

  if (!marketCycleStage) {
    marketCycleStage = classifyStageFromEmaProxy({ close, ema50, ema200 });
  }

  if (ema50 === null && ema200 === null && thirtyWeekSma === null && !marketCycleStage) {
    return null;
  }

  return {
    ema50,
    ema200,
    thirtyWeekSma,
    marketCycleStage,
    source: mergeTechnicalSource(base?.source, candidate?.source) || 'unknown-tech',
  };
}

function hasCompleteEmaSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return false;
  }

  return firstFinite(snapshot.ema50) !== null && firstFinite(snapshot.ema200) !== null;
}

async function fetchTechnicalSnapshotFromSymbolAliases(symbols, priceHint = null, sourcePrefix = 'alias-tech') {
  const candidates = Array.from(new Set((symbols || []).map((item) => normalizeIndianSymbol(item)).filter(Boolean)));
  let mergedSnapshot = null;

  for (const candidate of candidates) {
    let candidateSnapshot = null;

    try {
      const tvQuotes = await fetchTradingViewQuotes([candidate]);
      const tvSnapshot = snapshotFromTradingViewQuote(tvQuotes[0], `${sourcePrefix}:tradingview:${candidate}`);
      if (tvSnapshot) {
        candidateSnapshot = mergeTechnicalSnapshots(candidateSnapshot, tvSnapshot, priceHint);
      }
    } catch (error) {
      logDebug(`alias tradingview technical failed for ${candidate}`, shortError(error));
    }

    if (!hasCompleteEmaSnapshot(candidateSnapshot)) {
      try {
        const dailySeries = await fetchYahooCloseSeries(candidate, { interval: '1d', range: '2y' });
        const snapshot = buildTechnicalSnapshotFromDailySeries(dailySeries, priceHint, `${sourcePrefix}:yahoo:${candidate}`);
        if (snapshot) {
          candidateSnapshot = mergeTechnicalSnapshots(candidateSnapshot, snapshot, priceHint);
        }
      } catch (error) {
        logDebug(`alias yahoo technical failed for ${candidate}`, shortError(error));
      }
    }

    if (candidateSnapshot) {
      mergedSnapshot = mergeTechnicalSnapshots(mergedSnapshot, candidateSnapshot, priceHint);
      if (hasCompleteEmaSnapshot(mergedSnapshot)) {
        break;
      }
    }
  }

  return mergedSnapshot;
}

const symbolMasterNameIndex = {
  strict: null,
  relaxed: null,
};
let bseSymbolNameIndex = null;

function normalizeCompanyNameForMatch(name, relaxed = false) {
  const base = String(name || '')
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!relaxed) {
    return base;
  }

  const stopWords = new Set([
    'LIMITED',
    'LTD',
    'PVT',
    'PRIVATE',
    'COMPANY',
    'CO',
    'INDIA',
    'INDIAN',
    'THE',
    'INC',
    'PLC',
    'LLP',
  ]);

  return base
    .split(' ')
    .filter((token) => token && !stopWords.has(token))
    .join(' ')
    .trim();
}

function buildSymbolMasterNameIndex(relaxed = false) {
  const key = relaxed ? 'relaxed' : 'strict';
  if (symbolMasterNameIndex[key]) {
    return symbolMasterNameIndex[key];
  }

  const index = new Map();
  const items = getSymbolMasterItems({ exchange: 'NSE' }) || [];
  for (const item of items) {
    const normalizedName = normalizeCompanyNameForMatch(item.companyName, relaxed);
    if (!normalizedName) {
      continue;
    }
    const existing = index.get(normalizedName);
    if (!existing) {
      index.set(normalizedName, [item.symbol]);
      continue;
    }
    existing.push(item.symbol);
  }

  symbolMasterNameIndex[key] = index;
  return index;
}

function findNseAliasFromSymbolMaster(nameHint) {
  const strictKey = normalizeCompanyNameForMatch(nameHint, false);
  if (strictKey) {
    const strictIndex = buildSymbolMasterNameIndex(false);
    const matches = strictIndex.get(strictKey) || [];
    if (matches.length === 1) {
      return matches[0];
    }
  }

  const relaxedKey = normalizeCompanyNameForMatch(nameHint, true);
  if (!relaxedKey) {
    return '';
  }

  const relaxedIndex = buildSymbolMasterNameIndex(true);
  const relaxedMatches = relaxedIndex.get(relaxedKey) || [];
  if (relaxedMatches.length === 1) {
    return relaxedMatches[0];
  }

  return '';
}

function buildBseSymbolNameIndex() {
  if (bseSymbolNameIndex) {
    return bseSymbolNameIndex;
  }

  const index = new Map();
  const items = getSymbolMasterItems({ exchange: 'BSE' }) || [];
  for (const item of items) {
    const symbol = normalizeIndianSymbol(item.symbol);
    const name = String(item.companyName || '').trim();
    if (!symbol || !name || index.has(symbol)) {
      continue;
    }
    index.set(symbol, name);
  }

  bseSymbolNameIndex = index;
  return index;
}

function findNseAliasForBseSymbol(symbol, nameHint = '') {
  const normalized = normalizeIndianSymbol(symbol);
  if (!normalized.endsWith('.BO')) {
    return '';
  }

  const nameCandidates = [];
  if (String(nameHint || '').trim()) {
    nameCandidates.push(String(nameHint).trim());
  }

  const masterName = buildBseSymbolNameIndex().get(normalized);
  if (masterName && !nameCandidates.includes(masterName)) {
    nameCandidates.push(masterName);
  }

  for (const candidate of nameCandidates) {
    const alias = findNseAliasFromSymbolMaster(candidate);
    if (alias) {
      return alias;
    }
  }

  return '';
}

function buildTechnicalAliasCandidates(symbol, nameHint = '') {
  const normalized = normalizeIndianSymbol(symbol);
  const base = stripExchangeSuffix(normalized);
  const candidates = new Set([normalized]);

  if (/^[A-Z][A-Z0-9\-_.]{1,24}$/.test(base) && !/^\d{5,6}$/.test(base)) {
    candidates.add(`${base}.NS`);
    candidates.add(`${base}.BO`);
  }

  if (normalized.endsWith('.BO')) {
    const alias = findNseAliasForBseSymbol(normalized, nameHint);
    if (alias) {
      candidates.add(alias);
    }
  }

  return Array.from(candidates)
    .map((item) => normalizeIndianSymbol(item))
    .filter(Boolean);
}

async function fetchScreenerHtmlForSymbol(symbol, onlyNumericCode = false, includeMeta = false) {
  const urls = onlyNumericCode
    ? toScreenerUrlsForSymbol(toScreenerCompanyCode(symbol) ? symbol : '')
    : toScreenerUrlsForSymbol(symbol);
  if (urls.length === 0) {
    logDebug(`No screener URLs generated for symbol: ${symbol}`);
    return includeMeta ? { html: '', url: '' } : '';
  }

  for (const url of urls) {
    try {
      const response = await axios.get(url, {
        timeout: 9000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
          Referer: 'https://www.screener.in/',
        },
        validateStatus: (status) => status >= 200 && status < 500,
      });

      if (response.status >= 400) {
        logDebug(`Screener HTML fetch failed for ${symbol} at ${url}: HTTP ${response.status}`);
        continue;
      }

      const html = String(response.data || '');
      if (html.trim()) {
        logDebug(`Screener HTML fetched successfully for ${symbol}`);
        return includeMeta ? { html, url } : html;
      }
    } catch (error) {
      logDebug(`screener html failed for ${symbol} at ${url}`, shortError(error));
    }
  }

  logDebug(`No valid screener HTML found for ${symbol} after trying ${urls.length} URLs`);
  return includeMeta ? { html: '', url: '' } : '';
}

function nseQuotePageUrl(baseSymbol) {
  return `https://www.nseindia.com/get-quotes/equity?symbol=${encodeURIComponent(baseSymbol)}`;
}

function parseCookieHeader(cookieHeader) {
  const map = new Map();
  if (!cookieHeader) {
    return map;
  }

  cookieHeader.split(';').forEach((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) {
      return;
    }

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex <= 0) {
      return;
    }
    const key = trimmed.slice(0, eqIndex).trim();
    const value = trimmed.slice(eqIndex + 1).trim();
    if (key) {
      map.set(key, value);
    }
  });

  return map;
}

function mergeCookieHeaders(currentCookieHeader, setCookieArray) {
  const map = parseCookieHeader(currentCookieHeader);
  if (Array.isArray(setCookieArray)) {
    setCookieArray.forEach((setCookie) => {
      if (!setCookie) {
        return;
      }
      const firstPart = String(setCookie).split(';')[0];
      const eqIndex = firstPart.indexOf('=');
      if (eqIndex <= 0) {
        return;
      }
      const key = firstPart.slice(0, eqIndex).trim();
      const value = firstPart.slice(eqIndex + 1).trim();
      if (key) {
        map.set(key, value);
      }
    });
  }

  return Array.from(map.entries())
    .map(([key, value]) => `${key}=${value}`)
    .join('; ');
}

function buildNseHeaders(baseSymbol, cookieHeader = '') {
  const headers = {
    ...nseBaseHeaders,
    Referer: nseQuotePageUrl(baseSymbol),
  };
  if (cookieHeader) {
    headers.cookie = cookieHeader;
  }
  return headers;
}

function buildBseHeaders(cookieHeader = '') {
  const headers = {
    ...bseBaseHeaders,
  };
  if (cookieHeader) {
    headers.cookie = cookieHeader;
  }
  return headers;
}

function defaultExchangeFromSymbol(symbol) {
  return symbol.endsWith('.BO') ? 'BSE' : 'NSE';
}

function normalizeQuoteShape(inputQuote) {
  if (!inputQuote || typeof inputQuote !== 'object') {
    return null;
  }

  const symbol = normalizeIndianSymbol(inputQuote.symbol);
  if (!symbol) {
    return null;
  }

  const previousClose = firstFinite(inputQuote.previousClose);
  const regularMarketPrice = firstFinite(
    inputQuote.regularMarketPrice,
    inputQuote.lastPrice,
    previousClose,
    inputQuote.dayHigh,
    inputQuote.dayLow,
  );

  let regularMarketChange = firstFinite(inputQuote.regularMarketChange, inputQuote.change);
  let regularMarketChangePercent = firstFinite(inputQuote.regularMarketChangePercent, inputQuote.changePercent);

  if (regularMarketChange === null && regularMarketPrice !== null && previousClose !== null) {
    regularMarketChange = Number((regularMarketPrice - previousClose).toFixed(4));
  }

  if (regularMarketChangePercent === null && regularMarketChange !== null && previousClose) {
    regularMarketChangePercent = Number(((regularMarketChange / previousClose) * 100).toFixed(4));
  }

  return {
    symbol,
    shortName: String(inputQuote.shortName || inputQuote.longName || stripExchangeSuffix(symbol)),
    exchange: String(inputQuote.exchange || defaultExchangeFromSymbol(symbol)),
    currency: String(inputQuote.currency || 'INR'),
    regularMarketPrice,
    regularMarketChange,
    regularMarketChangePercent,
    regularMarketOpen: firstFinite(inputQuote.regularMarketOpen, inputQuote.open),
    previousClose,
    dayHigh: firstFinite(inputQuote.dayHigh, inputQuote.regularMarketDayHigh),
    dayLow: firstFinite(inputQuote.dayLow, inputQuote.regularMarketDayLow),
    regularMarketVolume: firstFinite(inputQuote.regularMarketVolume, inputQuote.volume),
    averageDailyVolume3Month: firstFinite(inputQuote.averageDailyVolume3Month, inputQuote.averageVolume),
    marketCap: firstFinite(inputQuote.marketCap),
    fiftyTwoWeekLow: firstFinite(inputQuote.fiftyTwoWeekLow),
    fiftyTwoWeekHigh: firstFinite(inputQuote.fiftyTwoWeekHigh),
    peRatio: firstFinite(inputQuote.peRatio, inputQuote.pe),
    eps: firstFinite(inputQuote.eps),
    pbRatio: firstFinite(inputQuote.pbRatio, inputQuote.pb),
    ema50: firstFinite(inputQuote.ema50),
    ema200: firstFinite(inputQuote.ema200),
    thirtyWeekSma: firstFinite(inputQuote.thirtyWeekSma),
    marketCycleStage: inputQuote.marketCycleStage ? String(inputQuote.marketCycleStage) : '',
    faceValue: firstFinite(inputQuote.faceValue),
    vwap: firstFinite(inputQuote.vwap),
    upperCircuit: firstFinite(inputQuote.upperCircuit),
    lowerCircuit: firstFinite(inputQuote.lowerCircuit),
    deliveryToTradedQuantity: firstFinite(inputQuote.deliveryToTradedQuantity),
    industry: inputQuote.industry ? String(inputQuote.industry) : '',
    isin: inputQuote.isin ? String(inputQuote.isin) : '',
    lastUpdateTime: inputQuote.lastUpdateTime ? String(inputQuote.lastUpdateTime) : '',
    source: String(inputQuote.source || 'unknown'),
    dataStatus: String(inputQuote.dataStatus || 'live'),
    providerTrace: Array.isArray(inputQuote.providerTrace) ? inputQuote.providerTrace : [],
  };
}

function isUsableQuote(quote) {
  return quote && quote.regularMarketPrice !== null && quote.regularMarketPrice > 0;
}

function isMissingValue(value) {
  return value === null || value === undefined || value === '';
}

function needsQuoteEnrichment(quote) {
  if (!quote) {
    return false;
  }

  return [
    quote.marketCap,
    quote.regularMarketVolume,
    quote.averageDailyVolume3Month,
    quote.peRatio,
    quote.eps,
    quote.pbRatio,
    quote.ema50,
    quote.ema200,
    quote.thirtyWeekSma,
    quote.marketCycleStage,
  ].some(isMissingValue);
}

function mergeQuoteMissingFields(baseQuote, candidateQuote, provider) {
  if (!baseQuote || !candidateQuote) {
    return baseQuote || candidateQuote || null;
  }

  const merged = { ...baseQuote };
  const filledFields = [];

  const fillableFields = [
    'regularMarketVolume',
    'averageDailyVolume3Month',
    'marketCap',
    'peRatio',
    'eps',
    'pbRatio',
    'ema50',
    'ema200',
    'thirtyWeekSma',
    'marketCycleStage',
    'vwap',
    'upperCircuit',
    'lowerCircuit',
    'deliveryToTradedQuantity',
    'industry',
    'isin',
    'faceValue',
    'dayHigh',
    'dayLow',
    'regularMarketOpen',
    'previousClose',
    'fiftyTwoWeekLow',
    'fiftyTwoWeekHigh',
    'lastUpdateTime',
  ];

  for (const field of fillableFields) {
    if (isMissingValue(merged[field]) && !isMissingValue(candidateQuote[field])) {
      merged[field] = candidateQuote[field];
      filledFields.push(field);
    }
  }

  if (
    (isMissingValue(merged.shortName) || merged.shortName === stripExchangeSuffix(merged.symbol))
    && !isMissingValue(candidateQuote.shortName)
  ) {
    merged.shortName = candidateQuote.shortName;
    filledFields.push('shortName');
  }

  if (filledFields.length > 0) {
    merged.providerTrace = [
      ...(merged.providerTrace || []),
      `enrich:${provider}(${filledFields.join(',')})`,
    ].slice(-40);
  }

  return merged;
}

function createUnavailableQuote(symbol, reason, staleValue, attempts = []) {
  if (staleValue) {
    const staleSource = String(staleValue.source || 'unknown').includes(':stale')
      ? String(staleValue.source || 'unknown')
      : `${staleValue.source || 'unknown'}:stale`;

    return {
      ...staleValue,
      dataStatus: 'stale',
      source: staleSource,
      providerTrace: [...(staleValue.providerTrace || []), ...attempts, `stale-cache:${reason}`].slice(-40),
    };
  }

  return normalizeQuoteShape({
    symbol,
    shortName: stripExchangeSuffix(symbol),
    exchange: defaultExchangeFromSymbol(symbol),
    currency: 'INR',
    regularMarketPrice: null,
    regularMarketChange: null,
    regularMarketChangePercent: null,
    regularMarketOpen: null,
    previousClose: null,
    dayHigh: null,
    dayLow: null,
    regularMarketVolume: null,
    averageDailyVolume3Month: null,
    marketCap: null,
    fiftyTwoWeekLow: null,
    fiftyTwoWeekHigh: null,
    peRatio: null,
    eps: null,
    pbRatio: null,
    ema50: null,
    ema200: null,
    thirtyWeekSma: null,
    marketCycleStage: '',
    faceValue: null,
    vwap: null,
    upperCircuit: null,
    lowerCircuit: null,
    deliveryToTradedQuantity: null,
    industry: '',
    isin: '',
    source: 'unavailable',
    dataStatus: 'unavailable',
    providerTrace: [...attempts, `unavailable:${reason}`].slice(-40),
  });
}

function normalizeYahooQuote(item) {
  return normalizeQuoteShape({
    symbol: item.symbol,
    shortName: item.shortName || item.longName,
    exchange: item.fullExchangeName || item.exchange,
    currency: item.currency,
    regularMarketPrice: item.regularMarketPrice,
    regularMarketChange: item.regularMarketChange,
    regularMarketChangePercent: item.regularMarketChangePercent,
    regularMarketOpen: item.regularMarketOpen,
    previousClose: item.regularMarketPreviousClose,
    dayHigh: item.regularMarketDayHigh,
    dayLow: item.regularMarketDayLow,
    regularMarketVolume: item.regularMarketVolume,
    averageDailyVolume3Month: item.averageDailyVolume3Month,
    marketCap: item.marketCap,
    fiftyTwoWeekLow: item.fiftyTwoWeekLow,
    fiftyTwoWeekHigh: item.fiftyTwoWeekHigh,
    source: 'yahoo',
    dataStatus: 'live',
  });
}

function normalizeTradingViewItem(item) {
  if (!item || typeof item !== 'object') {
    return null;
  }

  const sourceTicker = String(item.s || '');
  const [exchangeRaw, tickerRaw] = sourceTicker.split(':');
  if (!exchangeRaw || !tickerRaw) {
    return null;
  }

  const exchange = exchangeRaw.toUpperCase();
  const symbol = normalizeIndianSymbol(
    exchange === 'BSE' ? `${tickerRaw}.BO` : `${tickerRaw}.NS`,
  );

  const d = Array.isArray(item.d) ? item.d : [];
  const close = toNumber(d[1]);
  const changePct = toNumber(d[2]);
  const changeAbs = toNumber(d[3]);
  const ema50 = toNumber(d[13]);
  const ema200 = toNumber(d[14]);
  const thirtyWeekSma = toNumber(d[15]);
  const prevThirtyWeekSma = toNumber(d[16]);
  const previousClose = close !== null && changeAbs !== null
    ? Number((close - changeAbs).toFixed(4))
    : null;
  const marketCycleStage = classifyWeinsteinStage({
    close,
    sma30Week: thirtyWeekSma,
    prevSma30Week: prevThirtyWeekSma,
  }) || classifyStageFromEmaProxy({
    close,
    ema50,
    ema200,
  });

  return normalizeQuoteShape({
    symbol,
    shortName: d[12] || d[0] || tickerRaw,
    exchange,
    currency: d[11] || 'INR',
    regularMarketPrice: close,
    regularMarketChange: changeAbs,
    regularMarketChangePercent: changePct,
    regularMarketOpen: toNumber(d[8]),
    previousClose,
    dayHigh: toNumber(d[6]),
    dayLow: toNumber(d[7]),
    regularMarketVolume: toNumber(d[4]),
    marketCap: toNumber(d[5]),
    fiftyTwoWeekHigh: toNumber(d[9]),
    fiftyTwoWeekLow: toNumber(d[10]),
    ema50,
    ema200,
    thirtyWeekSma,
    marketCycleStage,
    source: 'tradingview',
    dataStatus: 'live',
  });
}

async function fetchTradingViewQuotes(symbols) {
  if (symbols.length === 0) {
    return [];
  }

  const tickers = symbols.map((symbol) => toTradingViewTicker(symbol));
  const payload = {
    symbols: {
      tickers,
      query: { types: [] },
    },
    columns: [
      'name',
      'close',
      'change',
      'change_abs',
      'volume',
      'market_cap_basic',
      'high',
      'low',
      'open',
      'price_52_week_high',
      'price_52_week_low',
      'currency',
      'description',
      'EMA50',
      'EMA200',
      'SMA30|1W',
      'SMA30|1W[1]',
    ],
  };

  const response = await axios.post(config.tradingViewScanUrl, payload, {
    timeout: 9000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Referer: 'https://www.tradingview.com/',
    },
  });

  const rows = Array.isArray(response.data?.data) ? response.data.data : [];
  if (rows.length === 0) {
    throw new Error('tradingview-empty-result-set');
  }

  return rows
    .map((row) => normalizeTradingViewItem(row))
    .filter(Boolean);
}

async function fetchScreenerQuoteForSymbol(symbol) {
  const companyCode = toScreenerCompanyCode(symbol);
  if (!companyCode) {
    return null;
  }

  const html = await fetchScreenerHtmlForSymbol(symbol, true);
  if (!html) {
    return null;
  }

  const parsed = parseScreenerQuoteFromHtml(symbol, html);
  if (parsed) {
    return parsed;
  }

  return null;
}

async function fetchScreenerQuotes(symbols) {
  const bseSymbols = symbols.filter((symbol) => Boolean(toScreenerCompanyCode(symbol)));
  if (bseSymbols.length === 0) {
    return [];
  }

  const results = [];
  for (const symbol of bseSymbols) {
    const quote = await fetchScreenerQuoteForSymbol(symbol);
    if (quote) {
      results.push(quote);
    }
  }
  return results;
}

function normalizeYahooChartQuote(symbol, data) {
  const result = data?.chart?.result?.[0];
  const meta = result?.meta || {};
  const quote = result?.indicators?.quote?.[0] || {};

  if (!result || !meta) {
    return null;
  }

  return normalizeQuoteShape({
    symbol,
    shortName: meta.shortName || meta.symbol || stripExchangeSuffix(symbol),
    exchange: meta.exchangeName || defaultExchangeFromSymbol(symbol),
    currency: meta.currency || 'INR',
    regularMarketPrice: meta.regularMarketPrice || lastFinite(quote.close),
    regularMarketChange: meta.regularMarketPrice && meta.previousClose
      ? Number((meta.regularMarketPrice - meta.previousClose).toFixed(4))
      : null,
    regularMarketChangePercent: meta.regularMarketPrice && meta.previousClose
      ? Number((((meta.regularMarketPrice - meta.previousClose) / meta.previousClose) * 100).toFixed(4))
      : null,
    regularMarketOpen: lastFinite(quote.open),
    previousClose: meta.previousClose || meta.chartPreviousClose,
    dayHigh: lastFinite(quote.high),
    dayLow: lastFinite(quote.low),
    regularMarketVolume: lastFinite(quote.volume),
    source: 'yahoo-chart',
    dataStatus: 'live',
    lastUpdateTime: meta.regularMarketTime
      ? new Date(meta.regularMarketTime * 1000).toISOString()
      : '',
  });
}

async function fetchYahooChartQuoteForSymbol(symbol, host = YAHOO_HOSTS[0]) {
  const yahooSymbol = toYahooSymbol(symbol);
  const response = await axios.get(`${host}${YAHOO_CHART_PATH}/${encodeURIComponent(yahooSymbol)}`, {
    params: {
      interval: '1d',
      range: '5d',
      includePrePost: false,
      events: 'div,split',
      lang: 'en-US',
      region: 'IN',
    },
    timeout: 9000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: 'application/json,text/plain,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://finance.yahoo.com/',
    },
  });

  return normalizeYahooChartQuote(symbol, response.data);
}

async function fetchYahooChartQuotes(symbols, host = YAHOO_HOSTS[0]) {
  const results = [];
  const failures = [];

  for (const symbol of symbols) {
    try {
      const quote = await fetchYahooChartQuoteForSymbol(symbol, host);
      if (quote) {
        results.push(quote);
      } else {
        failures.push(`${symbol}:empty-chart`);
      }
    } catch (error) {
      const compact = shortError(error);
      failures.push(`${symbol}:${compact}`);
      logDebug(`yahoo chart failed for ${symbol}`, compact);
    }
  }

  if (results.length === 0 && failures.length > 0) {
    throw new Error(`yahoo-chart-empty:${host}:${failures.slice(0, 3).join(';')}`);
  }

  return results;
}

async function fetchYahooV7Quotes(symbols, host = YAHOO_HOSTS[0]) {
  if (symbols.length === 0) {
    return [];
  }

  const yahooSymbols = symbols.map((symbol) => toYahooSymbol(symbol));

  const response = await axios.get(`${host}${YAHOO_QUOTE_PATH}`, {
    params: {
      symbols: yahooSymbols.join(','),
      lang: 'en-US',
      region: 'IN',
    },
    timeout: 9000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: 'application/json,text/plain,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://finance.yahoo.com/',
    },
  });

  const results = response.data?.quoteResponse?.result;
  if (!Array.isArray(results)) {
    throw new Error('Unexpected Yahoo quote response shape.');
  }

  return results
    .map((item) => normalizeYahooQuote(item))
    .filter(Boolean);
}

async function fetchYahooQuotes(symbols) {
  if (symbols.length === 0) {
    return [];
  }

  let lastError = null;

  for (const host of YAHOO_HOSTS) {
    try {
      const quotes = await fetchYahooV7Quotes(symbols, host);
      const quoteMap = new Map(quotes.map((quote) => [quote.symbol, quote]));
      const missing = symbols.filter((symbol) => !quoteMap.has(symbol));

      if (missing.length > 0) {
        const chartQuotes = await fetchYahooChartQuotes(missing, host);
        chartQuotes.forEach((quote) => quoteMap.set(quote.symbol, quote));
      }

      const resolved = symbols
        .map((symbol) => quoteMap.get(symbol))
        .filter(Boolean);
      if (resolved.length > 0) {
        return resolved;
      }
    } catch (error) {
      lastError = error;
      const status = error.response?.status;
      if (status === 401 || status === 403 || status === 429) {
        try {
          const chartOnly = await fetchYahooChartQuotes(symbols, host);
          if (chartOnly.length > 0) {
            return chartOnly;
          }
        } catch (chartError) {
          lastError = chartError;
        }
      }
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error('yahoo-empty-result-set');
}

async function fetchYahooCloseSeriesForSymbol(symbol, options = {}, host = YAHOO_HOSTS[0]) {
  const yahooSymbol = toYahooSymbol(symbol);
  const interval = options.interval || '1d';
  const range = options.range || '2y';

  const response = await axios.get(`${host}${YAHOO_CHART_PATH}/${encodeURIComponent(yahooSymbol)}`, {
    params: {
      interval,
      range,
      includePrePost: false,
      events: 'div,split',
      lang: 'en-US',
      region: 'IN',
    },
    timeout: 9000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: 'application/json,text/plain,*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      Referer: 'https://finance.yahoo.com/',
    },
  });

  const result = response.data?.chart?.result?.[0];
  const timestamps = Array.isArray(result?.timestamp) ? result.timestamp : [];
  const closes = Array.isArray(result?.indicators?.quote?.[0]?.close)
    ? result.indicators.quote[0].close
    : [];

  const series = [];
  const count = Math.min(timestamps.length, closes.length);
  for (let index = 0; index < count; index += 1) {
    const close = toNumber(closes[index]);
    const ts = toNumber(timestamps[index]);
    if (close === null || ts === null) {
      continue;
    }
    series.push({ ts, close });
  }

  if (series.length === 0) {
    throw new Error(`yahoo-series-empty:${symbol}:${interval}:${range}`);
  }

  return series;
}

async function fetchYahooCloseSeries(symbol, options = {}) {
  let lastError = null;

  for (const host of YAHOO_HOSTS) {
    try {
      return await fetchYahooCloseSeriesForSymbol(symbol, options, host);
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError;
  }

  throw new Error(`yahoo-series-unavailable:${symbol}`);
}

async function fetchTechnicalSnapshotFromYahoo(symbol) {
  const dailySeries = await fetchYahooCloseSeries(symbol, { interval: '1d', range: '2y' });
  let weeklySeries = [];
  try {
    weeklySeries = await fetchYahooCloseSeries(symbol, { interval: '1wk', range: '5y' });
  } catch (error) {
    logDebug(`yahoo weekly technical series failed for ${symbol}`, shortError(error));
  }

  const dailyCloses = dailySeries.map((item) => item.close);
  const weeklyCloses = weeklySeries.map((item) => item.close);
  if (dailyCloses.length < 2) {
    return null;
  }

  const ema50 = firstFinite(
    dailyCloses.length >= 50 ? calculateEma(dailyCloses, 50) : null,
    calculateEmaRelaxed(dailyCloses, 50),
  );
  const ema200 = firstFinite(
    dailyCloses.length >= 200 ? calculateEma(dailyCloses, 200) : null,
    calculateEmaRelaxed(dailyCloses, 200),
  );
  const thirtyWeekSma = weeklyCloses.length >= 30 ? calculateSma(weeklyCloses, 30) : null;
  const prevThirtyWeekSma = weeklyCloses.length >= 31
    ? calculateSma(weeklyCloses, 30, weeklyCloses.length - 1)
    : null;
  const latestClose = firstFinite(
    weeklyCloses[weeklyCloses.length - 1],
    dailyCloses[dailyCloses.length - 1],
  );
  let marketCycleStage = classifyWeinsteinStage({
    close: latestClose,
    sma30Week: thirtyWeekSma,
    prevSma30Week: prevThirtyWeekSma,
  });
  if (!marketCycleStage) {
    marketCycleStage = classifyStageFromEmaProxy({
      close: latestClose,
      ema50,
      ema200,
    });
  }

  return {
    ema50,
    ema200,
    thirtyWeekSma: thirtyWeekSma === null ? null : Number(thirtyWeekSma.toFixed(4)),
    marketCycleStage,
    source: 'yahoo-tech',
  };
}

async function fetchNseHistoricalDailySeries(symbol, retryWithFreshCookie = true) {
  if (!String(symbol).endsWith('.NS')) {
    return [];
  }

  const baseSymbol = stripExchangeSuffix(symbol);
  const toDate = new Date();
  const fromDate = new Date(toDate.getTime() - (TECHNICAL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000));

  let cookie = await ensureNseCookie(false, baseSymbol);

  const requestOnce = async (cookieHeader) => {
    const variants = [
      { series: '["EQ"]' },
      { series: 'EQ' },
    ];

    for (const variant of variants) {
      const response = await axios.get(NSE_HISTORICAL_PATH, {
        params: {
          symbol: baseSymbol,
          from: formatDateDdMmYyyy(fromDate),
          to: formatDateDdMmYyyy(toDate),
          ...variant,
        },
        timeout: 9000,
        headers: buildNseHeaders(baseSymbol, cookieHeader),
      });

      const rows = Array.isArray(response.data?.data) ? response.data.data : [];
      const parsed = rows
        .map((row) => {
          const close = firstWithUnits(
            row?.CH_CLOSING_PRICE,
            row?.CLOSE,
            row?.close,
            row?.closePrice,
          );
          const dateObj = parseNseDate(row?.CH_TIMESTAMP || row?.TIMESTAMP || row?.date);
          if (close === null || !dateObj) {
            return null;
          }
          return {
            ts: Math.floor(dateObj.getTime() / 1000),
            close,
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.ts - b.ts);

      if (parsed.length > 0) {
        return parsed;
      }
    }

    return [];
  };

  try {
    return await requestOnce(cookie);
  } catch (error) {
    const status = error.response?.status;
    if (retryWithFreshCookie && (status === 401 || status === 403 || status === 429)) {
      cookie = await ensureNseCookie(true, baseSymbol);
      return requestOnce(cookie);
    }
    throw error;
  }
}

async function fetchNseHistoricalDailySeriesArchive(symbol, retryWithFreshCookie = true) {
  if (!String(symbol).endsWith('.NS')) {
    return [];
  }

  const baseSymbol = stripExchangeSuffix(symbol);
  const toDate = new Date();
  const fromDate = new Date(toDate.getTime() - (TECHNICAL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000));

  let cookie = await ensureNseCookie(false, baseSymbol);

  const requestOnce = async (cookieHeader) => {
    const variants = [
      { dataType: 'priceVolumeDeliverable' },
      {},
    ];

    for (const variant of variants) {
      const response = await axios.get('https://www.nseindia.com/api/historical/securityArchives', {
        params: {
          symbol: baseSymbol,
          series: 'EQ',
          from: formatDateDdMmYyyy(fromDate),
          to: formatDateDdMmYyyy(toDate),
          ...variant,
        },
        timeout: 9000,
        headers: buildNseHeaders(baseSymbol, cookieHeader),
      });

      const rows = Array.isArray(response.data?.data) ? response.data.data : [];
      const parsed = rows
        .map((row) => {
          const close = firstWithUnits(
            row?.CH_CLOSING_PRICE,
            row?.CH_CLOSE,
            row?.CLOSE,
            row?.close,
          );
          const dateObj = parseNseDate(row?.CH_TIMESTAMP || row?.TIMESTAMP || row?.date);
          if (close === null || !dateObj) {
            return null;
          }
          return {
            ts: Math.floor(dateObj.getTime() / 1000),
            close,
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.ts - b.ts);

      if (parsed.length > 0) {
        return parsed;
      }
    }

    return [];
  };

  try {
    return await requestOnce(cookie);
  } catch (error) {
    const status = error.response?.status;
    if (retryWithFreshCookie && (status === 401 || status === 403 || status === 429)) {
      cookie = await ensureNseCookie(true, baseSymbol);
      return requestOnce(cookie);
    }
    throw error;
  }
}

function buildTechnicalSnapshotFromDailySeries(dailySeries, priceHint = null, source = 'unknown-tech') {
  const dailyCloses = dailySeries.map((item) => item.close);
  if (dailyCloses.length < 2) {
    return null;
  }

  const weeklyCloses = dailyToWeeklyCloses(dailySeries);
  const ema50 = firstFinite(
    dailyCloses.length >= 50 ? calculateEma(dailyCloses, 50) : null,
    calculateEmaRelaxed(dailyCloses, 50),
  );
  const ema200 = firstFinite(
    dailyCloses.length >= 200 ? calculateEma(dailyCloses, 200) : null,
    calculateEmaRelaxed(dailyCloses, 200),
  );
  const thirtyWeekSma = weeklyCloses.length >= 30 ? calculateSma(weeklyCloses, 30) : null;
  const prevThirtyWeekSma = weeklyCloses.length >= 31
    ? calculateSma(weeklyCloses, 30, weeklyCloses.length - 1)
    : null;
  const close = firstFinite(
    priceHint,
    dailyCloses[dailyCloses.length - 1],
  );

  let marketCycleStage = classifyWeinsteinStage({
    close,
    sma30Week: thirtyWeekSma,
    prevSma30Week: prevThirtyWeekSma,
  });
  if (!marketCycleStage) {
    marketCycleStage = classifyStageFromEmaProxy({
      close,
      ema50,
      ema200,
    });
  }

  return {
    ema50,
    ema200,
    thirtyWeekSma: thirtyWeekSma === null ? null : Number(thirtyWeekSma.toFixed(4)),
    marketCycleStage,
    source,
  };
}

async function fetchTechnicalSnapshotFromNseHistory(symbol, priceHint = null) {
  let dailySeries = [];
  try {
    dailySeries = await fetchNseHistoricalDailySeries(symbol);
  } catch (error) {
    logDebug(`nse cm historical failed for ${symbol}`, shortError(error));
  }

  if (!Array.isArray(dailySeries) || dailySeries.length < 200) {
    try {
      dailySeries = await fetchNseHistoricalDailySeriesArchive(symbol);
    } catch (error) {
      logDebug(`nse archive historical failed for ${symbol}`, shortError(error));
    }
  }

  if (!Array.isArray(dailySeries) || dailySeries.length < 2) {
    return null;
  }

  return buildTechnicalSnapshotFromDailySeries(dailySeries, priceHint, 'nse-history-tech');
}

async function fetchTechnicalSnapshotFromScreener(symbol, priceHint = null, nameHint = '') {
  const html = await fetchScreenerHtmlForSymbol(symbol, false);
  if (!html) {
    return null;
  }

  let snapshot = mergeTechnicalSnapshots(
    null,
    parseScreenerTechnicalsFromHtml(symbol, html, priceHint),
    priceHint,
  );

  if (!hasCompleteEmaSnapshot(snapshot)) {
    const aliases = extractTickerCandidatesFromScreenerHtml(symbol, html, nameHint);
    const aliasSnapshot = await fetchTechnicalSnapshotFromSymbolAliases(aliases, priceHint, 'screener-alias-tech');
    snapshot = mergeTechnicalSnapshots(snapshot, aliasSnapshot, priceHint);
  }

  return snapshot;
}

async function fetchTechnicalSnapshotFromTwelveData(symbol, priceHint = null) {
  if (!config.twelveDataApiKey) {
    return null;
  }

  const variants = toTwelveDataSymbolVariants(symbol);
  for (const variant of variants) {
    const params = {
      symbol: variant.symbol,
      apikey: variant.apikey,
      interval: '1day',
      outputsize: 300,
      order: 'ASC',
    };

    try {
      const response = await axios.get(`${config.twelveDataBaseUrl}/time_series`, {
        params,
        timeout: 9000,
        headers: {
          'User-Agent': 'stock-news-bot/2.0',
          Accept: 'application/json',
        },
      });

      if (response.data?.status === 'error') {
        continue;
      }

      const values = Array.isArray(response.data?.values) ? response.data.values : [];
      const dailySeries = values
        .map((item) => {
          const close = firstWithUnits(item?.close);
          const dateObj = item?.datetime ? new Date(item.datetime) : null;
          if (close === null || !dateObj || Number.isNaN(dateObj.getTime())) {
            return null;
          }
          return {
            ts: Math.floor(dateObj.getTime() / 1000),
            close,
          };
        })
        .filter(Boolean)
        .sort((a, b) => a.ts - b.ts);

      const snapshot = buildTechnicalSnapshotFromDailySeries(dailySeries, priceHint, 'twelvedata-tech');
      if (snapshot) {
        return snapshot;
      }
    } catch (error) {
      logDebug(`twelvedata technical snapshot failed for ${symbol}`, shortError(error));
    }
  }

  return null;
}

async function fetchTechnicalSnapshotFromAlphaVantage(symbol, priceHint = null) {
  if (!config.alphaVantageApiKey) {
    return null;
  }

  try {
    const response = await axios.get(config.alphaVantageBaseUrl, {
      params: {
        function: 'TIME_SERIES_DAILY_ADJUSTED',
        symbol: toAlphaVantageSymbol(symbol),
        outputsize: 'full',
        apikey: config.alphaVantageApiKey,
      },
      timeout: 9000,
      headers: {
        'User-Agent': 'stock-news-bot/2.0',
        Accept: 'application/json',
      },
    });

    if (response.data?.Note || response.data?.Information) {
      return null;
    }

    const series = response.data?.['Time Series (Daily)'];
    if (!series || typeof series !== 'object') {
      return null;
    }

    const dailySeries = Object.entries(series)
      .map(([dateText, row]) => {
        const close = firstWithUnits(row?.['4. close'], row?.close);
        const dateObj = new Date(dateText);
        if (close === null || Number.isNaN(dateObj.getTime())) {
          return null;
        }
        return {
          ts: Math.floor(dateObj.getTime() / 1000),
          close,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.ts - b.ts);

    return buildTechnicalSnapshotFromDailySeries(dailySeries, priceHint, 'alphavantage-tech');
  } catch (error) {
    logDebug(`alphavantage technical snapshot failed for ${symbol}`, shortError(error));
    return null;
  }
}

async function getTechnicalSnapshot(symbol, priceHint = null, nameHint = '') {
  const normalized = normalizeIndianSymbol(symbol);
  const cached = technicalCache.get(normalized);
  if (isTechnicalFresh(cached)) {
    return cached.value;
  }

  let snapshot = null;
  const mergeSnapshot = (candidate) => {
    snapshot = mergeTechnicalSnapshots(snapshot, candidate, priceHint);
  };
  const needsMoreEma = () => !hasCompleteEmaSnapshot(snapshot);

  if (normalized.endsWith('.NS') && needsMoreEma()) {
    try {
      mergeSnapshot(await fetchTechnicalSnapshotFromNseHistory(normalized, priceHint));
    } catch (error) {
      logDebug(`nse history technical snapshot failed for ${normalized}`, shortError(error));
    }
  }

  if (normalized.endsWith('.BO') && needsMoreEma()) {
    try {
      mergeSnapshot(await fetchTechnicalSnapshotFromBseHistory(normalized, priceHint));
    } catch (error) {
      logDebug(`bse history technical snapshot failed for ${normalized}`, shortError(error));
    }
  }

  if (needsMoreEma()) {
    const aliases = buildTechnicalAliasCandidates(normalized, nameHint);
    if (aliases.length > 0) {
      try {
        mergeSnapshot(await fetchTechnicalSnapshotFromSymbolAliases(aliases, priceHint, `symbol-alias-tech:${normalized}`));
      } catch (error) {
        logDebug(`symbol alias technical snapshot failed for ${normalized}`, shortError(error));
      }
    }
  }

  if (needsMoreEma()) {
    try {
      mergeSnapshot(await fetchTechnicalSnapshotFromYahoo(normalized));
    } catch (error) {
      logDebug(`technical snapshot failed for ${normalized}`, shortError(error));
    }
  }

  if (needsMoreEma()) {
    try {
      mergeSnapshot(await fetchTechnicalSnapshotFromScreener(normalized, priceHint, nameHint));
    } catch (error) {
      logDebug(`screener technical snapshot failed for ${normalized}`, shortError(error));
    }
  }

  if (needsMoreEma()) {
    mergeSnapshot(await fetchTechnicalSnapshotFromTwelveData(normalized, priceHint));
  }

  if (needsMoreEma()) {
    mergeSnapshot(await fetchTechnicalSnapshotFromAlphaVantage(normalized, priceHint));
  }

  if (!snapshot) {
    logDebug(`technical snapshot unavailable for ${normalized}`);
  }

  technicalCache.set(normalized, { value: snapshot, fetchedAt: now() });
  return snapshot;
}

async function enrichQuotesWithTechnicals(quotes) {
  const enriched = [];

  for (const quote of quotes) {
    if (!quote || !isUsableQuote(quote)) {
      enriched.push(quote);
      continue;
    }

    if (
      !isMissingValue(quote.ema50)
      && !isMissingValue(quote.ema200)
      && !isMissingValue(quote.marketCycleStage)
    ) {
      enriched.push(quote);
      continue;
    }

    const technical = await getTechnicalSnapshot(quote.symbol, quote.regularMarketPrice, quote.shortName);
    if (!technical) {
      enriched.push(quote);
      continue;
    }

    const ema50 = !isMissingValue(technical.ema50) ? technical.ema50 : quote.ema50;
    const ema200 = !isMissingValue(technical.ema200) ? technical.ema200 : quote.ema200;
    const thirtyWeekSma = !isMissingValue(technical.thirtyWeekSma) ? technical.thirtyWeekSma : quote.thirtyWeekSma;
    let marketCycleStage = !isMissingValue(technical.marketCycleStage)
      ? technical.marketCycleStage
      : quote.marketCycleStage;

    if (isMissingValue(marketCycleStage)) {
      marketCycleStage = classifyStageFromEmaProxy({
        close: quote.regularMarketPrice,
        ema50,
        ema200,
      });
    }

    if (isMissingValue(marketCycleStage)) {
      const close = firstFinite(quote.regularMarketPrice);
      const weekSma = firstFinite(thirtyWeekSma);
      if (close !== null && weekSma !== null) {
        marketCycleStage = close >= weekSma ? 'Markup' : 'Markdown';
      }
    }

    const merged = {
      ...quote,
      ema50,
      ema200,
      thirtyWeekSma,
      marketCycleStage,
      providerTrace: [...(quote.providerTrace || []), `technicals:${technical.source}`].slice(-40),
    };

    enriched.push(merged);
  }

  return enriched;
}

async function ensureNseCookie(forceRefresh = false, symbolForBootstrap = 'RELIANCE') {
  if (!forceRefresh && nseCookieHeader && (now() - nseCookieFetchedAt) < config.nseCookieTtlMs) {
    return nseCookieHeader;
  }

  const bootstrapSymbol = stripExchangeSuffix(normalizeIndianSymbol(symbolForBootstrap) || 'RELIANCE');
  let mergedCookies = '';

  const bootstrapUrls = [
    'https://www.nseindia.com/',
    nseQuotePageUrl(bootstrapSymbol),
  ];

  for (const url of bootstrapUrls) {
    const response = await axios.get(url, {
      timeout: 9000,
      headers: {
        ...nseBaseHeaders,
        Referer: 'https://www.nseindia.com/',
      },
      validateStatus: (status) => status >= 200 && status < 500,
    });
    mergedCookies = mergeCookieHeaders(mergedCookies, response.headers['set-cookie']);
  }

  if (!mergedCookies) {
    throw new Error('NSE cookie bootstrap failed (missing set-cookie header).');
  }

  nseCookieHeader = mergedCookies;
  nseCookieFetchedAt = now();
  return nseCookieHeader;
}

function parseNseQuotePayload(data, symbol) {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const base = stripExchangeSuffix(symbol);
  const info = data.info || {};
  const metadata = data.metadata || {};
  const securityInfo = data.securityInfo || {};
  const priceInfo = data.priceInfo || {};
  const tradeInfo = data.marketDeptOrderBook?.tradeInfo || {};

  return normalizeQuoteShape({
    symbol,
    shortName: info.companyName || metadata.companyName || base,
    exchange: 'NSE',
    currency: metadata.currency || 'INR',
    regularMarketPrice: priceInfo.lastPrice,
    regularMarketChange: priceInfo.change,
    regularMarketChangePercent: priceInfo.pChange,
    regularMarketOpen: priceInfo.open,
    previousClose: priceInfo.previousClose || priceInfo.close,
    dayHigh: priceInfo.intraDayHighLow?.max,
    dayLow: priceInfo.intraDayHighLow?.min,
    regularMarketVolume: data.totalTradedVolume || tradeInfo.totalTradedVolume,
    marketCap: securityInfo.marketCap || metadata.marketCap,
    fiftyTwoWeekLow: priceInfo.weekHighLow?.min,
    fiftyTwoWeekHigh: priceInfo.weekHighLow?.max,
    peRatio: tradeInfo.pE || securityInfo.pe,
    eps: tradeInfo.eps || securityInfo.eps,
    pbRatio: tradeInfo.pb || securityInfo.pb,
    faceValue: securityInfo.faceValue,
    vwap: tradeInfo.vwap,
    upperCircuit: securityInfo.upperCP,
    lowerCircuit: securityInfo.lowerCP,
    deliveryToTradedQuantity: data.securityWiseDP?.deliveryToTradedQuantity,
    industry: metadata.industry || info.industry || '',
    isin: metadata.isin || info.isin || '',
    lastUpdateTime: metadata.lastUpdateTime || data.lastUpdateTime,
    source: 'nseindia',
    dataStatus: 'live',
  });
}

async function fetchNseQuoteForSymbol(symbol, retryWithFreshCookie = true) {
  if (!symbol.endsWith('.NS')) {
    return null;
  }

  const baseSymbol = stripExchangeSuffix(symbol);
  let cookie = await ensureNseCookie(false, baseSymbol);

  try {
    const response = await axios.get('https://www.nseindia.com/api/quote-equity', {
      params: {
        symbol: baseSymbol,
        section: 'trade_info',
      },
      timeout: 9000,
      headers: buildNseHeaders(baseSymbol, cookie),
    });

    let parsed = parseNseQuotePayload(response.data, symbol);
    if (isUsableQuote(parsed)) {
      return parsed;
    }

    // Some responses are incomplete with section=trade_info; retry plain quote payload.
    const fallbackResponse = await axios.get('https://www.nseindia.com/api/quote-equity', {
      params: {
        symbol: baseSymbol,
      },
      timeout: 9000,
      headers: buildNseHeaders(baseSymbol, cookie),
    });

    parsed = parseNseQuotePayload(fallbackResponse.data, symbol);
    if (!isUsableQuote(parsed)) {
      throw new Error('nse-empty-last-price');
    }

    return parsed;
  } catch (error) {
    const status = error.response?.status;
    if (retryWithFreshCookie && (status === 401 || status === 403 || status === 429)) {
      cookie = await ensureNseCookie(true, baseSymbol);
      const retryResponse = await axios.get('https://www.nseindia.com/api/quote-equity', {
        params: {
          symbol: baseSymbol,
          section: 'trade_info',
        },
        timeout: 9000,
        headers: buildNseHeaders(baseSymbol, cookie),
      });

      const parsed = parseNseQuotePayload(retryResponse.data, symbol);
      if (!isUsableQuote(parsed)) {
        throw new Error('nse-empty-last-price-after-retry');
      }
      return parsed;
    }

    throw error;
  }
}

async function fetchNseQuotes(symbols) {
  const nseSymbols = symbols.filter((symbol) => symbol.endsWith('.NS'));
  if (nseSymbols.length === 0) {
    return [];
  }

  const results = [];
  const failures = [];
  for (const symbol of nseSymbols) {
    try {
      const quote = await fetchNseQuoteForSymbol(symbol);
      if (quote) {
        results.push(quote);
      } else {
        failures.push(`${symbol}:empty`);
      }
    } catch (error) {
      const compact = shortError(error);
      failures.push(`${symbol}:${compact}`);
      logDebug(`nse quote failed for ${symbol}`, compact);
    }
  }

  if (results.length === 0 && failures.length > 0) {
    throw new Error(`nse-empty-result-set:${failures.slice(0, 3).join(';')}`);
  }

  return results;
}

function toBseScripCode(symbol) {
  const normalized = normalizeIndianSymbol(symbol);
  if (!normalized.endsWith('.BO')) {
    return '';
  }

  const base = stripExchangeSuffix(normalized);
  return /^\d{5,6}$/.test(base) ? base : '';
}

async function ensureBseCookie(forceRefresh = false) {
  if (!forceRefresh && bseCookieHeader && (now() - bseCookieFetchedAt) < config.nseCookieTtlMs) {
    return bseCookieHeader;
  }

  let mergedCookies = '';
  const bootstrapUrls = [
    'https://www.bseindia.com/',
    'https://api.bseindia.com/',
  ];

  for (const url of bootstrapUrls) {
    try {
      const response = await axios.get(url, {
        timeout: 9000,
        headers: buildBseHeaders(mergedCookies),
        validateStatus: (status) => status >= 200 && status < 500,
      });
      mergedCookies = mergeCookieHeaders(mergedCookies, response.headers['set-cookie']);
    } catch (error) {
      // Ignore bootstrap failures and continue with best-effort cookies.
      logDebug(`bse cookie bootstrap failed for ${url}`, shortError(error));
    }
  }

  bseCookieHeader = mergedCookies || '';
  bseCookieFetchedAt = now();
  return bseCookieHeader;
}

function parseBseQuotePayload(data, symbol) {
  if (!data || typeof data !== 'object') {
    return null;
  }

  const objects = [];
  const pushObject = (candidate) => {
    if (candidate && typeof candidate === 'object') {
      objects.push(candidate);
    }
  };

  pushObject(data);
  pushObject(data.Header);
  pushObject(data.header);
  pushObject(data.Quote);
  pushObject(data.quote);
  pushObject(data.Data);
  pushObject(data.data);
  if (Array.isArray(data) && data.length > 0) {
    pushObject(data[0]);
  }

  const getRaw = (keys) => {
    for (const obj of objects) {
      for (const key of keys) {
        const value = obj?.[key];
        if (value !== undefined && value !== null && value !== '') {
          return value;
        }
      }
    }
    return null;
  };

  const getNum = (keys) => firstWithUnits(getRaw(keys));
  const getText = (keys) => {
    const raw = getRaw(keys);
    return raw === null ? '' : String(raw).trim();
  };

  const regularMarketPrice = getNum([
    'LTP',
    'ltp',
    'LastTradedPrice',
    'lastTradedPrice',
    'CurrentPrice',
    'currentPrice',
    'Price',
    'price',
    'LAST_PRICE',
    'last_price',
    'Close',
    'close',
    'LastRate',
    'lastRate',
  ]);

  if (regularMarketPrice === null) {
    return null;
  }

  return normalizeQuoteShape({
    symbol,
    shortName: getText([
      'CompanyName',
      'companyName',
      'SecurityName',
      'securityName',
      'IssuerName',
      'issuerName',
      'Name',
      'name',
    ]) || stripExchangeSuffix(symbol),
    exchange: 'BSE',
    currency: 'INR',
    regularMarketPrice,
    regularMarketChange: getNum([
      'Change',
      'change',
      'NetChange',
      'netChange',
      'ChangeValue',
      'changeValue',
    ]),
    regularMarketChangePercent: getNum([
      'PercentChange',
      'percentChange',
      'PChange',
      'pChange',
      'ChangePercent',
      'changePercent',
      'PerChange',
    ]),
    regularMarketOpen: getNum([
      'Open',
      'open',
      'OpenPrice',
      'openPrice',
    ]),
    previousClose: getNum([
      'PrevClose',
      'prevClose',
      'PreviousClose',
      'previousClose',
      'ClosePrevDay',
      'closePrevDay',
      'Prev_Close',
    ]),
    dayHigh: getNum([
      'High',
      'high',
      'HighPrice',
      'highPrice',
    ]),
    dayLow: getNum([
      'Low',
      'low',
      'LowPrice',
      'lowPrice',
    ]),
    regularMarketVolume: getNum([
      'Volume',
      'volume',
      'TotalTradedQty',
      'totalTradedQty',
      'TotalTradedQuantity',
      'totalTradedQuantity',
      'NoOfSharesTraded',
    ]),
    marketCap: getNum([
      'MarketCap',
      'marketCap',
      'MktCap',
      'mktCap',
      'MarketCapFull',
      'MCap',
    ]),
    fiftyTwoWeekLow: getNum([
      'Low52Week',
      'low52Week',
      'WeekLow52',
      'weekLow52',
      'FiftyTwoWeekLow',
      'fiftyTwoWeekLow',
      'YearLow',
      'yearLow',
    ]),
    fiftyTwoWeekHigh: getNum([
      'High52Week',
      'high52Week',
      'WeekHigh52',
      'weekHigh52',
      'FiftyTwoWeekHigh',
      'fiftyTwoWeekHigh',
      'YearHigh',
      'yearHigh',
    ]),
    peRatio: getNum([
      'PE',
      'pe',
      'PERatio',
      'peRatio',
      'P_E',
    ]),
    eps: getNum([
      'EPS',
      'eps',
    ]),
    pbRatio: getNum([
      'PB',
      'pb',
      'PBV',
      'pbv',
      'PriceToBook',
      'priceToBook',
    ]),
    faceValue: getNum([
      'FaceValue',
      'faceValue',
      'FaceVal',
      'faceVal',
    ]),
    upperCircuit: getNum([
      'UpperCircuit',
      'upperCircuit',
      'UpperPriceBand',
      'upperPriceBand',
    ]),
    lowerCircuit: getNum([
      'LowerCircuit',
      'lowerCircuit',
      'LowerPriceBand',
      'lowerPriceBand',
    ]),
    industry: getText([
      'Industry',
      'industry',
      'Sector',
      'sector',
    ]),
    isin: getText([
      'ISIN',
      'isin',
    ]),
    lastUpdateTime: getText([
      'LastUpdateTime',
      'lastUpdateTime',
      'UpdatedOn',
      'updatedOn',
      'PriceUpdatedAt',
      'priceUpdatedAt',
    ]),
    source: 'bseindia',
    dataStatus: 'live',
  });
}

async function fetchBseQuoteForSymbol(symbol, retryWithFreshCookie = true) {
  const scripCode = toBseScripCode(symbol);
  if (!scripCode) {
    return null;
  }

  let cookie = await ensureBseCookie(false);

  try {
    const response = await axios.get(BSE_QUOTE_PATH, {
      params: {
        Debtflag: '',
        scripcode: scripCode,
        seriesid: '',
      },
      timeout: 9000,
      headers: buildBseHeaders(cookie),
    });

    const parsed = parseBseQuotePayload(response.data, symbol);
    if (!isUsableQuote(parsed)) {
      throw new Error('bse-empty-last-price');
    }
    return parsed;
  } catch (error) {
    const status = error.response?.status;
    if (retryWithFreshCookie && (status === 401 || status === 403 || status === 429)) {
      cookie = await ensureBseCookie(true);
      const retryResponse = await axios.get(BSE_QUOTE_PATH, {
        params: {
          Debtflag: '',
          scripcode: scripCode,
          seriesid: '',
        },
        timeout: 9000,
        headers: buildBseHeaders(cookie),
      });

      const parsed = parseBseQuotePayload(retryResponse.data, symbol);
      if (!isUsableQuote(parsed)) {
        throw new Error('bse-empty-last-price-after-retry');
      }
      return parsed;
    }

    throw error;
  }
}

async function fetchBseQuotes(symbols) {
  const bseSymbols = symbols.filter((symbol) => Boolean(toBseScripCode(symbol)));
  if (bseSymbols.length === 0) {
    return [];
  }

  const results = [];
  const failures = [];
  for (const symbol of bseSymbols) {
    try {
      const quote = await fetchBseQuoteForSymbol(symbol);
      if (quote) {
        results.push(quote);
      } else {
        failures.push(`${symbol}:empty`);
      }
    } catch (error) {
      const compact = shortError(error);
      failures.push(`${symbol}:${compact}`);
      logDebug(`bse quote failed for ${symbol}`, compact);
    }
  }

  if (results.length === 0 && failures.length > 0) {
    throw new Error(`bse-empty-result-set:${failures.slice(0, 3).join(';')}`);
  }

  return results;
}

function parseBseGraphSeries(payload) {
  if (typeof payload === 'string') {
    const text = payload.trim();
    if (!text) {
      return [];
    }

    try {
      const parsedJson = JSON.parse(text);
      return parseBseGraphSeries(parsedJson);
    } catch (error) {
      // Fall through to delimited-text parser.
    }

    const rows = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    return rows
      .map((line) => {
        const parts = line.split(/[|,;]/).map((item) => item.trim()).filter(Boolean);
        if (parts.length < 2) {
          return null;
        }
        const dateObj = parseMarketDate(parts[0]);
        const close = firstWithUnits(parts[parts.length - 1], parts[1]);
        if (!dateObj || close === null) {
          return null;
        }
        return {
          ts: Math.floor(dateObj.getTime() / 1000),
          close,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.ts - b.ts);
  }

  const findFirstArray = (value, depth = 0) => {
    if (depth > 5 || value === null || value === undefined) {
      return null;
    }
    if (Array.isArray(value)) {
      return value;
    }
    if (typeof value !== 'object') {
      return null;
    }

    for (const key of Object.keys(value)) {
      const found = findFirstArray(value[key], depth + 1);
      if (found) {
        return found;
      }
    }

    return null;
  };

  const buckets = [
    payload?.data,
    payload?.Data,
    payload?.d,
    payload?.Table,
    payload?.table,
    payload?.GraphData,
    payload?.graphData,
    payload?.Series,
    payload?.series,
    payload,
  ];

  const rows = buckets.find((item) => Array.isArray(item))
    || findFirstArray(payload)
    || [];
  if (rows.length === 0) {
    return [];
  }

  const parsed = rows
    .map((row) => {
      if (Array.isArray(row)) {
        const close = firstWithUnits(
          row[row.length - 1],
          row[4],
          row[3],
          row[2],
          row[1],
        );
        const dateObj = parseMarketDate(row[0]);
        if (close === null || !dateObj) {
          return null;
        }
        return {
          ts: Math.floor(dateObj.getTime() / 1000),
          close,
        };
      }

      if (!row || typeof row !== 'object') {
        return null;
      }

      const close = firstWithUnits(
        row.close,
        row.Close,
        row.CLOSE,
        row.CH_CLOSING_PRICE,
        row.CLOSING_PRICE,
        row.lastPrice,
        row.LastPrice,
        row.closeRate,
        row.CloseRate,
        row.value,
        row.Value,
        row.y,
        row.c,
        row.C,
      );
      const dateObj = parseMarketDate(
        row.date
        || row.Date
        || row.CH_TIMESTAMP
        || row.timestamp
        || row.Time
        || row.time
        || row.x
        || row.t,
      );
      if (close === null || !dateObj) {
        return null;
      }

      return {
        ts: Math.floor(dateObj.getTime() / 1000),
        close,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.ts - b.ts);

  // Keep one close per day (latest in case of duplicates).
  const byDay = new Map();
  for (const item of parsed) {
    const dayKey = new Date(item.ts * 1000).toISOString().slice(0, 10);
    byDay.set(dayKey, item);
  }

  return Array.from(byDay.values()).sort((a, b) => a.ts - b.ts);
}

async function fetchBseHistoricalDailySeries(symbol, retryWithFreshCookie = true) {
  const scripCode = toBseScripCode(symbol);
  if (!scripCode) {
    return [];
  }

  const toDate = new Date();
  const fromDate = new Date(toDate.getTime() - (TECHNICAL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000));
  const fromSlash = formatDateDdMmYyyySlash(fromDate);
  const toSlash = formatDateDdMmYyyySlash(toDate);
  const fromDash = formatDateDdMmYyyy(fromDate);
  const toDash = formatDateDdMmYyyy(toDate);
  const paramsVariants = [
    {
      flag: '0',
      fromdate: fromSlash,
      todate: toSlash,
      seriesid: '',
      scripcode: scripCode,
    },
    {
      flag: 0,
      fromdate: fromDash,
      todate: toDash,
      seriesid: '',
      scripcode: scripCode,
    },
    {
      flag: '1',
      fromDate: fromSlash,
      toDate: toSlash,
      seriesid: '',
      scripcode: scripCode,
      stockcode: scripCode,
    },
    {
      flag: '0',
      fromDate: fromDash,
      toDate: toDash,
      seriesid: '',
      stockcode: scripCode,
    },
    {
      flag: '0',
      scripcode: scripCode,
    },
    {
      scripcode: scripCode,
    },
  ];

  let cookie = await ensureBseCookie(false);

  const requestOnce = async (cookieHeader) => {
    let authError = null;

    for (const endpoint of BSE_GRAPH_PATHS) {
      for (const params of paramsVariants) {
        try {
          const response = await axios.get(endpoint, {
            params,
            timeout: 9000,
            headers: buildBseHeaders(cookieHeader),
          });

          const parsed = parseBseGraphSeries(response.data);
          if (parsed.length > 0) {
            return parsed;
          }
        } catch (error) {
          const status = error.response?.status;
          if (status === 401 || status === 403 || status === 429) {
            authError = error;
            break;
          }
          logDebug(`bse history fetch failed for ${symbol}`, shortError(error));
        }
      }

      if (authError) {
        break;
      }
    }

    if (authError) {
      throw authError;
    }

    return [];
  };

  try {
    return await requestOnce(cookie);
  } catch (error) {
    const status = error.response?.status;
    if (retryWithFreshCookie && (status === 401 || status === 403 || status === 429)) {
      cookie = await ensureBseCookie(true);
      return requestOnce(cookie);
    }
    throw error;
  }
}

async function fetchTechnicalSnapshotFromBseHistory(symbol, priceHint = null) {
  const dailySeries = await fetchBseHistoricalDailySeries(symbol);
  if (!Array.isArray(dailySeries) || dailySeries.length < 2) {
    return null;
  }

  return buildTechnicalSnapshotFromDailySeries(dailySeries, priceHint, 'bse-history-tech');
}

function toAlphaVantageSymbol(symbol) {
  const normalized = normalizeIndianSymbol(symbol);
  const baseSymbol = stripExchangeSuffix(normalized);
  const exchange = normalized.endsWith('.BO') ? 'BSE' : 'NSE';
  return `${baseSymbol}.${exchange}`;
}

function normalizeAlphaVantageQuote(data, symbol) {
  const payload = data?.['Global Quote'] || {};
  if (!payload || Object.keys(payload).length === 0) {
    return null;
  }

  const symbolFromApi = payload['01. symbol'] || toAlphaVantageSymbol(symbol);
  const convertedSymbol = symbolFromApi.endsWith('.BSE')
    ? symbolFromApi.replace('.BSE', '.BO')
    : symbolFromApi.replace('.NSE', '.NS');

  return normalizeQuoteShape({
    symbol: convertedSymbol || symbol,
    shortName: stripExchangeSuffix(convertedSymbol || symbol),
    exchange: convertedSymbol?.endsWith('.BO') ? 'BSE' : 'NSE',
    currency: 'INR',
    regularMarketPrice: payload['05. price'],
    regularMarketChange: payload['09. change'],
    regularMarketChangePercent: payload['10. change percent'],
    regularMarketOpen: payload['02. open'],
    dayHigh: payload['03. high'],
    dayLow: payload['04. low'],
    previousClose: payload['08. previous close'],
    regularMarketVolume: payload['06. volume'],
    source: 'alphavantage',
    dataStatus: 'live',
    lastUpdateTime: payload['07. latest trading day'],
  });
}

async function fetchAlphaVantageQuoteForSymbol(symbol) {
  if (!config.alphaVantageApiKey) {
    return null;
  }

  // Alpha Vantage free tier is unreliable for NSE/BSE quotes.
  if (String(symbol).endsWith('.NS') || String(symbol).endsWith('.BO')) {
    return null;
  }

  const response = await axios.get(config.alphaVantageBaseUrl, {
    params: {
      function: 'GLOBAL_QUOTE',
      symbol: toAlphaVantageSymbol(symbol),
      apikey: config.alphaVantageApiKey,
    },
    timeout: 9000,
    headers: {
      'User-Agent': 'stock-news-bot/2.0',
      Accept: 'application/json',
    },
  });

  if (response.data?.Note || response.data?.Information) {
    return null;
  }

  return normalizeAlphaVantageQuote(response.data, symbol);
}

async function fetchAlphaVantageQuotes(symbols) {
  if (!config.alphaVantageApiKey || symbols.length === 0) {
    return [];
  }

  const results = [];
  const failures = [];
  for (const symbol of symbols) {
    try {
      const quote = await fetchAlphaVantageQuoteForSymbol(symbol);
      if (quote) {
        results.push(quote);
      } else {
        failures.push(`${symbol}:empty`);
      }
    } catch (error) {
      failures.push(`${symbol}:${shortError(error)}`);
    }
  }

  if (results.length === 0 && failures.length > 0) {
    throw new Error(`alphavantage-empty-result-set:${failures.slice(0, 3).join(';')}`);
  }

  return results;
}

function toTwelveDataParams(symbol) {
  const normalized = normalizeIndianSymbol(symbol);
  const baseSymbol = stripExchangeSuffix(normalized);
  const exchange = normalized.endsWith('.BO') ? 'BSE' : 'NSE';

  return {
    symbol: baseSymbol,
    exchange,
    apikey: config.twelveDataApiKey,
  };
}

function toTwelveDataSymbolVariants(symbol) {
  const baseParams = toTwelveDataParams(symbol);
  return [
    // Most reliable with Twelve Data for exchanges.
    {
      symbol: `${baseParams.symbol}:${baseParams.exchange}`,
      apikey: baseParams.apikey,
    },
    // Backward-compatible variant.
    baseParams,
  ];
}

function normalizeTwelveDataQuote(data, symbol) {
  const normalized = normalizeIndianSymbol(symbol);
  const fiftyTwoWeek = data.fifty_two_week || {};

  return normalizeQuoteShape({
    symbol: normalized,
    shortName: data.name || stripExchangeSuffix(normalized),
    exchange: data.exchange || defaultExchangeFromSymbol(normalized),
    currency: data.currency || 'INR',
    regularMarketPrice: data.close || data.price,
    regularMarketChange: data.change,
    regularMarketChangePercent: data.percent_change,
    regularMarketOpen: data.open,
    previousClose: data.previous_close,
    dayHigh: data.high,
    dayLow: data.low,
    regularMarketVolume: data.volume,
    averageDailyVolume3Month: data.average_volume,
    marketCap: data.market_cap,
    fiftyTwoWeekLow: fiftyTwoWeek.low,
    fiftyTwoWeekHigh: fiftyTwoWeek.high,
    peRatio: data.pe,
    eps: data.eps,
    pbRatio: data.pb,
    faceValue: data.face_value,
    source: 'twelvedata',
    dataStatus: 'live',
    lastUpdateTime: data.datetime,
  });
}

async function fetchTwelveDataQuoteForSymbol(symbol) {
  if (!config.twelveDataApiKey) {
    return null;
  }

  const variants = toTwelveDataSymbolVariants(symbol);
  let lastApiError = null;

  for (const params of variants) {
    const response = await axios.get(`${config.twelveDataBaseUrl}/quote`, {
      params,
      timeout: 9000,
      headers: {
        'User-Agent': 'stock-news-bot/2.0',
        Accept: 'application/json',
      },
    });

    if (response.data?.status === 'error') {
      const apiCode = response.data?.code || 'ERR';
      const apiMessage = response.data?.message || 'unknown';
      lastApiError = `twelvedata-api-error:${apiCode}:${apiMessage}`;
      continue;
    }

    const quote = normalizeTwelveDataQuote(response.data, symbol);
    if (quote) {
      return quote;
    }
  }

  if (lastApiError) {
    throw new Error(lastApiError);
  }

  return null;
}

async function fetchTwelveDataQuotes(symbols) {
  if (!config.twelveDataApiKey || symbols.length === 0) {
    return [];
  }

  const results = [];
  const failures = [];
  for (const symbol of symbols) {
    try {
      const quote = await fetchTwelveDataQuoteForSymbol(symbol);
      if (quote) {
        results.push(quote);
      } else {
        failures.push(`${symbol}:empty`);
      }
    } catch (error) {
      failures.push(`${symbol}:${shortError(error)}`);
    }
  }

  if (results.length === 0 && failures.length > 0) {
    throw new Error(`twelvedata-empty-result-set:${failures.slice(0, 3).join(';')}`);
  }

  return results;
}

async function fetchProviderQuotes(provider, symbols) {
  if (symbols.length === 0) {
    return [];
  }

  if (provider === 'nseindia') {
    return fetchNseQuotes(symbols);
  }

  if (provider === 'bseindia') {
    return fetchBseQuotes(symbols);
  }

  if (provider === 'alphavantage') {
    return fetchAlphaVantageQuotes(symbols);
  }

  if (provider === 'tradingview') {
    return fetchTradingViewQuotes(symbols);
  }

  if (provider === 'twelvedata') {
    return fetchTwelveDataQuotes(symbols);
  }

  if (provider === 'screener') {
    return fetchScreenerQuotes(symbols);
  }

  if (provider === 'yahoo') {
    return fetchYahooQuotes(symbols);
  }

  return [];
}

function getEffectiveProviderOrder() {
  const configured = Array.isArray(config.marketDataProviderOrder)
    ? config.marketDataProviderOrder
    : [];
  const order = Array.from(new Set(configured.filter(Boolean)));

  if (!order.includes('bseindia')) {
    const nseIndex = order.indexOf('nseindia');
    if (nseIndex >= 0) {
      order.splice(nseIndex + 1, 0, 'bseindia');
    } else {
      order.unshift('bseindia');
    }
  }

  if (!order.includes('screener')) {
    order.push('screener');
  }
  return order;
}

function getProviderSkipReason(provider) {
  if (provider === 'twelvedata' && !config.twelveDataApiKey) {
    return 'missing-api-key';
  }

  if (provider === 'alphavantage' && !config.alphaVantageApiKey) {
    return 'missing-api-key';
  }

  return '';
}

async function fetchQuotesFromProviders(symbols) {
  const resultMap = new Map();
  const pending = new Set(symbols);
  const attemptsBySymbol = new Map(symbols.map((symbol) => [symbol, []]));
  const providerOrder = getEffectiveProviderOrder();

  for (const provider of providerOrder) {
    if (pending.size === 0) {
      break;
    }

    const targets = Array.from(pending);
    const consumed = new Set();
    const unusable = new Set();
    const skipReason = getProviderSkipReason(provider);
    if (skipReason) {
      for (const symbol of targets) {
        attemptsBySymbol.get(symbol).push(`${provider}:skip(${skipReason})`);
      }
      continue;
    }

    let providerQuotes = [];
    try {
      providerQuotes = await fetchProviderQuotes(provider, targets);
      logDebug(`provider=${provider} returned ${providerQuotes.length} quotes`, { targets });
    } catch (error) {
      for (const symbol of targets) {
        attemptsBySymbol.get(symbol).push(`${provider}:error(${shortError(error)})`);
      }
      logDebug(`provider=${provider} failed`, shortError(error));
      providerQuotes = [];
      continue;
    }

    for (const rawQuote of providerQuotes) {
      const quote = normalizeQuoteShape(rawQuote);
      if (!quote) {
        continue;
      }

      if (!isUsableQuote(quote)) {
        unusable.add(quote.symbol);
        attemptsBySymbol.get(quote.symbol)?.push(`${provider}:unusable`);
        continue;
      }

      const existing = resultMap.get(quote.symbol);
      if (!existing) {
        const attempts = attemptsBySymbol.get(quote.symbol) || [];
        resultMap.set(quote.symbol, {
          ...quote,
          providerTrace: [...attempts, `hit:${provider}`],
        });
        pending.delete(quote.symbol);
        consumed.add(quote.symbol);
      }
    }

    for (const symbol of targets) {
      if (!consumed.has(symbol) && !unusable.has(symbol)) {
        attemptsBySymbol.get(symbol).push(`${provider}:miss`);
      }
    }
  }

  // Second pass: enrich already resolved quotes with missing fields from remaining providers.
  for (const provider of providerOrder) {
    const targets = Array.from(resultMap.values())
      .filter((quote) => needsQuoteEnrichment(quote))
      .map((quote) => quote.symbol);

    if (targets.length === 0) {
      break;
    }

    const skipReason = getProviderSkipReason(provider);
    if (skipReason) {
      continue;
    }

    try {
      const providerQuotes = await fetchProviderQuotes(provider, targets);
      const providerMap = new Map(
        providerQuotes
          .map((rawQuote) => normalizeQuoteShape(rawQuote))
          .filter(Boolean)
          .map((quote) => [quote.symbol, quote]),
      );

      for (const symbol of targets) {
        const baseQuote = resultMap.get(symbol);
        const candidate = providerMap.get(symbol);
        if (!baseQuote || !candidate) {
          continue;
        }

        const merged = mergeQuoteMissingFields(baseQuote, candidate, provider);
        resultMap.set(symbol, merged);
      }
    } catch (error) {
      logDebug(`provider=${provider} enrichment failed`, shortError(error));
    }
  }

  return { resultMap, attemptsBySymbol };
}

async function getQuotes(symbolInputs) {
  const symbols = asList(symbolInputs);
  if (symbols.length === 0) {
    return [];
  }

  const resolvedMap = new Map();
  const missing = [];

  for (const symbol of symbols) {
    const key = cacheKey(symbol);
    const cached = quoteCache.get(key);

    if (isFresh(cached) && cached.value) {
      resolvedMap.set(symbol, cached.value);
    } else {
      missing.push(symbol);
    }
  }

  if (missing.length > 0) {
    const { resultMap: fetchedMap, attemptsBySymbol } = await fetchQuotesFromProviders(missing);

    for (const symbol of missing) {
      const fetched = fetchedMap.get(symbol);
      if (fetched) {
        quoteCache.set(cacheKey(symbol), { value: fetched, fetchedAt: now() });
        resolvedMap.set(symbol, fetched);
        continue;
      }

      const stale = quoteCache.get(cacheKey(symbol))?.value || null;
      const attempts = attemptsBySymbol.get(symbol) || [];
      const unavailable = createUnavailableQuote(symbol, 'all providers failed', stale, attempts);
      quoteCache.set(cacheKey(symbol), { value: unavailable, fetchedAt: now() });
      resolvedMap.set(symbol, unavailable);
    }
  }

  const baseQuotes = symbols.map((symbol) => resolvedMap.get(symbol) || createUnavailableQuote(symbol, 'not resolved'));
  const enrichedQuotes = await enrichQuotesWithTechnicals(baseQuotes);

  for (const quote of enrichedQuotes) {
    if (!quote?.symbol) {
      continue;
    }
    quoteCache.set(cacheKey(quote.symbol), { value: quote, fetchedAt: now() });
    resolvedMap.set(quote.symbol, quote);
  }

  return enrichedQuotes;
}

async function getSingleQuote(symbol) {
  const quotes = await getQuotes([symbol]);
  return quotes[0] || null;
}

async function fetchNseRawDetails(symbol) {
  if (!symbol.endsWith('.NS')) {
    return null;
  }

  try {
    const baseSymbol = stripExchangeSuffix(symbol);
    const cookie = await ensureNseCookie(false);
    const response = await axios.get('https://www.nseindia.com/api/quote-equity', {
      params: {
        symbol: baseSymbol,
      },
      timeout: 9000,
      headers: {
        ...nseBaseHeaders,
        cookie,
      },
    });

    const data = response.data || {};
    const info = data.info || {};
    const metadata = data.metadata || {};
    const securityInfo = data.securityInfo || {};
    const tradeInfo = data.marketDeptOrderBook?.tradeInfo || {};

    return {
      companyName: info.companyName || metadata.companyName || stripExchangeSuffix(symbol),
      industry: metadata.industry || info.industry || '',
      isin: metadata.isin || info.isin || '',
      listingDate: metadata.listingDate || '',
      faceValue: firstFinite(securityInfo.faceValue),
      issuedCap: firstFinite(securityInfo.issuedCap),
      freeFloatMarketCap: firstFinite(data.ffmc),
      totalTradedValue: firstFinite(data.totalTradedValue, tradeInfo.totalTradedValue),
      totalTradedVolume: firstFinite(data.totalTradedVolume, tradeInfo.totalTradedVolume),
      deliveryToTradedQuantity: firstFinite(data.securityWiseDP?.deliveryToTradedQuantity),
      weekHighLow: {
        low: firstFinite(data.priceInfo?.weekHighLow?.min),
        high: firstFinite(data.priceInfo?.weekHighLow?.max),
      },
      upperCircuit: firstFinite(securityInfo.upperCP),
      lowerCircuit: firstFinite(securityInfo.lowerCP),
      lastUpdateTime: metadata.lastUpdateTime || data.lastUpdateTime || '',
      source: 'nseindia',
    };
  } catch (error) {
    return null;
  }
}

async function fetchTwelveDataProfile(symbol) {
  if (!config.twelveDataApiKey) {
    return null;
  }

  try {
    const variants = toTwelveDataSymbolVariants(symbol);

    for (const params of variants) {
      const response = await axios.get(`${config.twelveDataBaseUrl}/profile`, {
        params,
        timeout: 9000,
        headers: {
          'User-Agent': 'stock-news-bot/2.0',
          Accept: 'application/json',
        },
      });

      if (response.data?.status === 'error') {
        continue;
      }

      return {
        name: response.data.name || '',
        sector: response.data.sector || '',
        industry: response.data.industry || '',
        description: response.data.description || '',
        website: response.data.website || '',
        marketCap: firstFinite(response.data.market_cap),
        peRatio: firstFinite(response.data.pe),
        eps: firstFinite(response.data.eps),
        beta: firstFinite(response.data.beta),
        employees: firstFinite(response.data.full_time_employees),
        source: 'twelvedata',
      };
    }
    return null;
  } catch (error) {
    return null;
  }
}

async function getQuarterlyFinancials(symbolInput, options = {}) {
  const symbol = normalizeIndianSymbol(symbolInput);
  if (!symbol) {
    throw new Error('Invalid stock symbol.');
  }

  const limit = Math.min(Math.max(Number(options.limit) || 6, 1), 8);
  const forceRefresh = Boolean(options.forceRefresh);
  const key = `${symbol}:${limit}`;
  const cached = quarterlyFinancialCache.get(key);
  if (!forceRefresh && isQuarterlyFinancialFresh(cached)) {
    return cached.value;
  }

  const nowIso = new Date().toISOString();
  const providerTrace = [];
  const candidates = buildQuarterlyFinancialSymbolCandidates(symbol);
  let lastUnavailable = null;

  for (const candidate of candidates) {
    try {
      const screenerPage = await fetchScreenerHtmlForSymbol(candidate, false, true);
      const html = String(screenerPage?.html || '');
      const sourceUrl = String(screenerPage?.url || '');

      if (!html) {
        providerTrace.push(`screener:miss:${candidate}`);
        continue;
      }

      const parsed = parseQuarterlyFinancialsFromScreenerHtml(candidate, html, { limit });
      const hasRows = Array.isArray(parsed.rows) && parsed.rows.length > 0;
      const response = {
        symbol,
        companyName: parsed.companyName || stripExchangeSuffix(symbol),
        source: 'screener',
        sourceUrl,
        dataStatus: hasRows ? 'available' : 'unavailable',
        updatedAt: nowIso,
        quarterLabels: parsed.quarterLabels,
        rows: parsed.rows,
        providerTrace: [...providerTrace, `screener:hit:${candidate}`].slice(-40),
        message: hasRows
          ? ''
          : 'Quarterly financial table is not available for this stock right now.',
      };

      if (hasRows) {
        quarterlyFinancialCache.set(key, { value: response, fetchedAt: now() });
        return response;
      }

      lastUnavailable = response;
    } catch (error) {
      providerTrace.push(`screener:error:${candidate}:${shortError(error)}`);
    }
  }

  const unavailable = lastUnavailable || {
      symbol,
      companyName: stripExchangeSuffix(symbol),
      source: 'screener',
      sourceUrl: '',
      dataStatus: 'unavailable',
      updatedAt: nowIso,
      quarterLabels: [],
      rows: [],
      providerTrace: providerTrace.length > 0 ? providerTrace.slice(-40) : ['screener:miss'],
      message: 'Quarterly financial data is currently unavailable for this symbol. This might be due to: 1) The stock may not have quarterly financial data available, 2) The data source is temporarily unreachable, or 3) The symbol format may not be recognized. Please try refreshing the page or check if the symbol is correct.',
  };

  quarterlyFinancialCache.set(key, { value: unavailable, fetchedAt: now() });
  return unavailable;
}

async function getMarketDetails(symbolInput) {
  const symbol = normalizeIndianSymbol(symbolInput);
  if (!symbol) {
    throw new Error('Invalid stock symbol.');
  }

  const quote = await getSingleQuote(symbol);
  const [nseDetails, profile] = await Promise.all([
    fetchNseRawDetails(symbol),
    fetchTwelveDataProfile(symbol),
  ]);

  return {
    symbol,
    quote,
    details: {
      nse: nseDetails,
      profile,
    },
    providerOrder: getEffectiveProviderOrder(),
  };
}

function calculatePortfolioAnalytics(portfolio, quotes) {
  const quoteMap = new Map(quotes.map((quote) => [quote.symbol, quote]));

  const positions = portfolio.map((position) => {
    const quote = quoteMap.get(position.symbol) || createUnavailableQuote(position.symbol, 'missing quote');

    const marketPrice = quote.regularMarketPrice !== null && quote.regularMarketPrice > 0
      ? quote.regularMarketPrice
      : position.avgPrice;

    const invested = position.quantity * position.avgPrice;
    const current = position.quantity * marketPrice;
    const pnl = current - invested;
    const pnlPercent = invested > 0 ? (pnl / invested) * 100 : 0;

    return {
      ...position,
      quote,
      valuationMode: quote.regularMarketPrice !== null && quote.regularMarketPrice > 0 ? 'market' : 'cost',
      invested: Number(invested.toFixed(2)),
      current: Number(current.toFixed(2)),
      pnl: Number(pnl.toFixed(2)),
      pnlPercent: Number(pnlPercent.toFixed(2)),
    };
  });

  const summary = positions.reduce((acc, position) => {
    acc.invested += position.invested;
    acc.current += position.current;
    acc.pnl += position.pnl;
    return acc;
  }, { invested: 0, current: 0, pnl: 0 });

  const pnlPercent = summary.invested > 0 ? (summary.pnl / summary.invested) * 100 : 0;

  return {
    positions,
    summary: {
      invested: Number(summary.invested.toFixed(2)),
      current: Number(summary.current.toFixed(2)),
      pnl: Number(summary.pnl.toFixed(2)),
      pnlPercent: Number(pnlPercent.toFixed(2)),
    },
  };
}

function parseScreenerFilters(rawFilters) {
  const filters = {
    minPrice: toNumber(rawFilters.minPrice),
    maxPrice: toNumber(rawFilters.maxPrice),
    minChangePct: toNumber(rawFilters.minChangePct),
    minVolume: toNumber(rawFilters.minVolume),
    minMarketCap: toNumber(rawFilters.minMarketCap),
  };

  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) => value !== null && value !== 0),
  );
}

function runScreener(quotes, rawFilters) {
  const filters = parseScreenerFilters(rawFilters || {});

  return quotes.filter((quote) => {
    if (!isUsableQuote(quote)) {
      return false;
    }

    if (filters.minPrice !== undefined && quote.regularMarketPrice < filters.minPrice) {
      return false;
    }

    if (filters.maxPrice !== undefined && quote.regularMarketPrice > filters.maxPrice) {
      return false;
    }

    if (filters.minChangePct !== undefined && quote.regularMarketChangePercent < filters.minChangePct) {
      return false;
    }

    if (filters.minVolume !== undefined && (quote.regularMarketVolume || 0) < filters.minVolume) {
      return false;
    }

    if (filters.minMarketCap !== undefined && (quote.marketCap || 0) < filters.minMarketCap) {
      return false;
    }

    return true;
  });
}

module.exports = {
  getQuotes,
  getSingleQuote,
  getMarketDetails,
  getQuarterlyFinancials,
  calculatePortfolioAnalytics,
  runScreener,
};
