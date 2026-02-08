const axios = require('axios');
const { config } = require('../config');
const { normalizeIndianSymbol, stripExchangeSuffix } = require('../utils/symbols');

const eventsCache = new Map();
const pageCache = new Map();

const MONTH_INDEX = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

const RESULT_KEYWORDS = [
  'financial result',
  'financial results',
  'quarterly result',
  'quarterly results',
  'unaudited result',
  'audited result',
  'earnings result',
  'board meeting',
];

const CONCALL_KEYWORDS = [
  'conference call',
  'con call',
  'concall',
  'earnings call',
  'analyst call',
  'analyst meet',
  'analyst / investor meet',
  'analyst and investor meet',
  'investor meet',
  'investor meeting',
  'institutional investor',
];

function now() {
  return Date.now();
}

function toStartOfDay(dateInput) {
  const date = new Date(dateInput);
  date.setHours(0, 0, 0, 0);
  return date;
}

function toIsoDate(dateInput) {
  const date = new Date(dateInput);
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();
  return `${year}-${month}-${day}`;
}

function fromIsoDate(isoDate) {
  if (!isoDate) {
    return null;
  }
  const match = String(isoDate).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }
  const [, yyyyRaw, mmRaw, ddRaw] = match;
  const parsed = new Date(Number(yyyyRaw), Number(mmRaw) - 1, Number(ddRaw));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDayLabel(isoDate) {
  const parsed = fromIsoDate(isoDate);
  if (!parsed) {
    return isoDate;
  }
  return parsed.toLocaleDateString('en-IN', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function isFresh(entry, ttlMs) {
  return entry && (now() - entry.fetchedAt) <= ttlMs;
}

function asUniqueSymbols(symbols) {
  return Array.from(new Set(
    (symbols || [])
      .map((symbol) => normalizeIndianSymbol(symbol))
      .filter(Boolean),
  ));
}

function decodeHtmlEntities(raw) {
  return String(raw || '')
    .replace(/&#8377;|&\#x20B9;|&inr;/gi, 'INR')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function cleanText(raw) {
  return decodeHtmlEntities(String(raw || ''))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseFlexibleDate(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) {
    return null;
  }

  const nativeParsed = new Date(raw);
  if (!Number.isNaN(nativeParsed.getTime())) {
    return toStartOfDay(nativeParsed);
  }

  let match = raw.match(/^(\d{1,2})[\/\-\s]([A-Za-z]{3,9})[,\-\s]+(\d{2,4})$/);
  if (match) {
    const day = Number(match[1]);
    const monthIndex = MONTH_INDEX[String(match[2]).toLowerCase()];
    const year = Number(match[3].length === 2 ? `20${match[3]}` : match[3]);
    if (monthIndex !== undefined) {
      const parsed = new Date(year, monthIndex, day);
      return Number.isNaN(parsed.getTime()) ? null : toStartOfDay(parsed);
    }
  }

  match = raw.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})$/);
  if (match) {
    const monthIndex = MONTH_INDEX[String(match[1]).toLowerCase()];
    const day = Number(match[2]);
    const year = Number(match[3]);
    if (monthIndex !== undefined) {
      const parsed = new Date(year, monthIndex, day);
      return Number.isNaN(parsed.getTime()) ? null : toStartOfDay(parsed);
    }
  }

  match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (match) {
    const day = Number(match[1]);
    const month = Number(match[2]) - 1;
    const year = Number(match[3]);
    const parsed = new Date(year, month, day);
    return Number.isNaN(parsed.getTime()) ? null : toStartOfDay(parsed);
  }

  return null;
}

function extractDatesFromText(text) {
  const results = [];
  const patterns = [
    /\b([A-Za-z]{3,9}\s+\d{1,2},\s*\d{4})\b/g,
    /\b(\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})\b/g,
    /\b(\d{1,2}-[A-Za-z]{3,9}-\d{4})\b/g,
    /\b(\d{1,2}\/\d{1,2}\/\d{4})\b/g,
    /\b(\d{4}-\d{1,2}-\d{1,2})\b/g,
  ];

  for (const pattern of patterns) {
    for (const match of String(text || '').matchAll(pattern)) {
      const date = parseFlexibleDate(match[1]);
      if (!date) {
        continue;
      }
      results.push({
        raw: match[1],
        index: typeof match.index === 'number' ? match.index : 0,
        date,
      });
    }
  }

  return results;
}

function inferEventType(textInput) {
  const text = String(textInput || '').toLowerCase();
  if (!text) {
    return '';
  }

  if (CONCALL_KEYWORDS.some((keyword) => text.includes(keyword))) {
    return 'concall';
  }

  const hasBoardMeeting = text.includes('board meeting');
  const hasResultContext = text.includes('result') || text.includes('earnings') || text.includes('financial');
  if (hasBoardMeeting && !hasResultContext) {
    return '';
  }

  if (RESULT_KEYWORDS.some((keyword) => text.includes(keyword))) {
    return 'results';
  }

  return '';
}

function stripRelativePrefix(text) {
  return String(text || '')
    .replace(/^\d+\s*(?:m|min|h|d|w|mo|y)\s*-\s*/i, '')
    .trim();
}

function toEventTypeLabel(type) {
  if (type === 'results') {
    return 'Results';
  }
  if (type === 'concall') {
    return 'Concall';
  }
  return 'Event';
}

function toScreenerCompanyCandidates(symbol) {
  const normalized = normalizeIndianSymbol(symbol);
  const base = stripExchangeSuffix(normalized);
  const candidates = [];

  if (/^\d{5,6}$/.test(base)) {
    candidates.push(base);
  }

  if (/^[A-Z][A-Z0-9\-_.]{1,24}$/.test(base)) {
    candidates.push(base);
  }

  return Array.from(new Set(candidates));
}

function toScreenerUrls(symbol) {
  const companyCandidates = toScreenerCompanyCandidates(symbol);
  const urls = [];
  for (const companyId of companyCandidates) {
    urls.push(`https://www.screener.in/company/${companyId}/consolidated/`);
    urls.push(`https://www.screener.in/company/${companyId}/standalone/`);
    urls.push(`https://www.screener.in/company/${companyId}/`);
  }
  return Array.from(new Set(urls));
}

function toAbsoluteUrl(urlInput) {
  const url = String(urlInput || '').trim();
  if (!url) {
    return '';
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }
  if (url.startsWith('/')) {
    return `https://www.screener.in${url}`;
  }
  return `https://www.screener.in/${url}`;
}

function extractCompanyName(html, symbol) {
  const match = String(html || '').match(/<h1[^>]*>\s*([\s\S]*?)\s*<\/h1>/i);
  const parsed = cleanText(match?.[1] || '');
  return parsed || stripExchangeSuffix(symbol);
}

function selectEventDate(text, today, maxDate) {
  const dateCandidates = extractDatesFromText(text);
  if (dateCandidates.length === 0) {
    return null;
  }

  const futureDates = dateCandidates
    .map((item) => item.date)
    .filter((date) => date >= today && date <= maxDate)
    .sort((left, right) => left - right);
  if (futureDates.length > 0) {
    return futureDates[0];
  }

  return null;
}

function parseEventsFromScreenerHtml(symbol, html, today, maxDate) {
  const companyName = extractCompanyName(html, symbol);
  const parsedEvents = [];
  const seenKeys = new Set();
  const anchorRegex = /<a[^>]*href=(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;

  for (const match of String(html || '').matchAll(anchorRegex)) {
    const href = toAbsoluteUrl(match[2]);
    const anchorText = stripRelativePrefix(cleanText(match[3]));
    if (!anchorText || anchorText.length < 25 || anchorText.length > 550) {
      continue;
    }

    const eventType = inferEventType(anchorText);
    if (!eventType) {
      continue;
    }

    const eventDate = selectEventDate(anchorText, today, maxDate);
    if (!eventDate) {
      continue;
    }

    const eventDateIso = toIsoDate(eventDate);
    const idText = anchorText.toUpperCase().replace(/[^A-Z0-9]+/g, '-').slice(0, 90);
    const key = `${symbol}|${eventType}|${eventDateIso}|${idText}`;
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);

    parsedEvents.push({
      id: key,
      symbol,
      companyName,
      eventType,
      eventLabel: toEventTypeLabel(eventType),
      eventDate: eventDateIso,
      dayLabel: formatDayLabel(eventDateIso),
      title: anchorText,
      source: 'screener',
      url: href || '#',
    });
  }

  return parsedEvents;
}

async function fetchPage(url) {
  const ttl = config.eventsCacheTtlMs;
  const cached = pageCache.get(url);
  if (isFresh(cached, ttl)) {
    return cached.value;
  }

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

    const html = response.status < 400 ? String(response.data || '') : '';
    pageCache.set(url, { value: html, fetchedAt: now() });
    return html;
  } catch (error) {
    pageCache.set(url, { value: '', fetchedAt: now() });
    return '';
  }
}

async function fetchSymbolEvents(symbol, today, maxDate) {
  const urls = toScreenerUrls(symbol);
  if (urls.length === 0) {
    return [];
  }

  for (const url of urls) {
    const html = await fetchPage(url);
    if (!html) {
      continue;
    }

    const parsed = parseEventsFromScreenerHtml(symbol, html, today, maxDate);
    if (parsed.length > 0) {
      return parsed;
    }
  }

  return [];
}

function groupEventsByDay(events) {
  const groups = [];
  const byDate = new Map();

  for (const event of events) {
    const key = event.eventDate;
    if (!byDate.has(key)) {
      byDate.set(key, {
        date: key,
        label: formatDayLabel(key),
        items: [],
      });
      groups.push(byDate.get(key));
    }
    byDate.get(key).items.push(event);
  }

  return groups;
}

function normalizeTypeFilter(typeInput) {
  const type = String(typeInput || 'all').trim().toLowerCase();
  if (type === 'results' || type === 'concall') {
    return type;
  }
  return 'all';
}

function cacheKey(symbols, daysAhead, typeFilter) {
  return `${symbols.slice().sort().join('|')}::${daysAhead}::${typeFilter}`;
}

async function getUpcomingCorporateEvents(symbols, options = {}) {
  const sanitizedSymbols = asUniqueSymbols(symbols);
  const daysAhead = Math.min(Math.max(Number(options.daysAhead) || 45, 1), 180);
  const typeFilter = normalizeTypeFilter(options.typeFilter);

  if (sanitizedSymbols.length === 0) {
    return {
      symbols: [],
      daysAhead,
      typeFilter,
      total: 0,
      events: [],
      groups: [],
      updatedAt: new Date().toISOString(),
    };
  }

  const key = cacheKey(sanitizedSymbols, daysAhead, typeFilter);
  const cached = eventsCache.get(key);
  if (isFresh(cached, config.eventsCacheTtlMs)) {
    return cached.value;
  }

  const today = toStartOfDay(new Date());
  const maxDate = new Date(today);
  maxDate.setDate(maxDate.getDate() + daysAhead);

  const eventBatches = await Promise.all(
    sanitizedSymbols.map((symbol) => fetchSymbolEvents(symbol, today, maxDate)),
  );

  let events = eventBatches
    .flat()
    .filter((event) => event && event.eventDate)
    .sort((left, right) => {
      if (left.eventDate !== right.eventDate) {
        return left.eventDate.localeCompare(right.eventDate);
      }
      return left.symbol.localeCompare(right.symbol, undefined, {
        numeric: true,
        sensitivity: 'base',
      });
    });

  if (typeFilter !== 'all') {
    events = events.filter((event) => event.eventType === typeFilter);
  }

  const groups = groupEventsByDay(events);
  const payload = {
    symbols: sanitizedSymbols,
    daysAhead,
    typeFilter,
    total: events.length,
    events,
    groups,
    updatedAt: new Date().toISOString(),
  };

  eventsCache.set(key, {
    value: payload,
    fetchedAt: now(),
  });

  return payload;
}

module.exports = {
  getUpcomingCorporateEvents,
};
