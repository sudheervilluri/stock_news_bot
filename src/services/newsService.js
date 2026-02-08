const axios = require('axios');
const { config } = require('../config');
const { stripExchangeSuffix } = require('../utils/symbols');

const newsCache = new Map();
const DEFAULT_PAGE_LIMIT = 10;
const MAX_PAGE_LIMIT = 10;

function now() {
  return Date.now();
}

function cacheKey(symbols) {
  return symbols.slice().sort().join('|');
}

function isFresh(entry) {
  return entry && (now() - entry.fetchedAt) <= config.newsCacheTtlMs;
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
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizePublishedAt(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return new Date().toISOString();
  }
  return parsed.toISOString();
}

function inferRelatedSymbols(title, description, symbols) {
  const text = `${title} ${description}`.toUpperCase();
  return symbols.filter((symbol) => text.includes(stripExchangeSuffix(symbol)));
}

function normalizeArticles(articles, symbols) {
  return (articles || [])
    .map((article, index) => {
      const publishedAt = normalizePublishedAt(article.publishedAt || article.pubDate);
      const title = cleanText(article.title) || 'Untitled market update';
      const description = cleanText(article.description || article.content || '');
      const url = String(article.url || article.link || '#').trim() || '#';
      const source = cleanText(article.source || article.sourceName || article.provider || 'News Feed') || 'News Feed';

      return {
        id: url !== '#' ? url : `${title}-${index}`,
        title,
        description,
        url,
        source,
        imageUrl: article.imageUrl || article.urlToImage || '',
        publishedAt,
        relatedSymbols: inferRelatedSymbols(title, description, symbols),
      };
    })
    .filter((article) => Boolean(article.title));
}

function extractRssTag(itemXml, tagName) {
  const escapedTag = String(tagName || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`<${escapedTag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${escapedTag}>`, 'i');
  const match = String(itemXml || '').match(regex);
  return match ? cleanText(match[1]) : '';
}

function parseRssItems(xmlText, providerLabel) {
  const xml = String(xmlText || '');
  const items = [];
  const matches = xml.matchAll(/<item\b[\s\S]*?<\/item>/gi);

  for (const match of matches) {
    const itemXml = match[0];
    const title = extractRssTag(itemXml, 'title');
    const link = extractRssTag(itemXml, 'link');
    const description = extractRssTag(itemXml, 'description') || extractRssTag(itemXml, 'content:encoded');
    const pubDate = extractRssTag(itemXml, 'pubDate') || extractRssTag(itemXml, 'updated');
    const sourceTag = extractRssTag(itemXml, 'source');

    if (!title) {
      continue;
    }

    items.push({
      title,
      description,
      link,
      pubDate,
      source: sourceTag || providerLabel,
    });
  }

  return items;
}

function toSearchKeywords(symbols) {
  return Array.from(new Set(
    (symbols || [])
      .map((symbol) => stripExchangeSuffix(symbol))
      .map((base) => String(base || '').toUpperCase().replace(/[^A-Z0-9]/g, ''))
      .filter((token) => token.length >= 2),
  )).slice(0, 10);
}

function buildMarketQuery(symbols) {
  const keywords = toSearchKeywords(symbols);
  const lookbackDays = Math.min(Math.max(Number(config.googleNewsLookbackDays) || 7, 1), 30);
  if (keywords.length === 0) {
    return `india stock market when:${lookbackDays}d`;
  }

  return `(${keywords.join(' OR ')}) (stock OR shares OR results OR concall) when:${lookbackDays}d`;
}

function buildTwitterQuery(symbols) {
  const keywords = toSearchKeywords(symbols);
  if (keywords.length === 0) {
    return 'indian stock market';
  }
  return `(${keywords.join(' OR ')}) (stock OR shares OR earnings OR results OR concall)`;
}

async function fetchNewsApiArticles(symbols) {
  if (!config.newsApiKey) {
    return [];
  }

  const keywords = toSearchKeywords(symbols);
  const query = keywords.length > 0 ? keywords.join(' OR ') : 'india stock market';
  const response = await axios.get(config.newsApiBaseUrl, {
    params: {
      q: query,
      language: 'en',
      pageSize: 40,
      sortBy: 'publishedAt',
      apiKey: config.newsApiKey,
    },
    timeout: 9000,
    headers: {
      'User-Agent': 'stock-news-bot/2.0',
      Accept: 'application/json',
    },
  });

  if (!Array.isArray(response.data?.articles)) {
    throw new Error('Unexpected news response shape.');
  }

  return normalizeArticles(response.data.articles, symbols);
}

async function fetchGoogleNewsRssArticles(symbols) {
  const query = buildMarketQuery(symbols);
  const region = String(config.googleNewsRssRegion || 'IN').toUpperCase();
  const language = String(config.googleNewsRssLanguage || 'en').toLowerCase();
  const hl = `${language}-${region}`;
  const ceid = `${region}:${language}`;

  const response = await axios.get(config.googleNewsRssBaseUrl, {
    params: {
      q: query,
      hl,
      gl: region,
      ceid,
    },
    timeout: 9000,
    headers: {
      'User-Agent': 'stock-news-bot/2.0',
      Accept: 'application/rss+xml,application/xml,text/xml',
    },
  });

  const parsed = parseRssItems(response.data, 'Google News');
  return normalizeArticles(parsed, symbols);
}

async function fetchTwitterSearchRssArticles(symbols) {
  if (!config.twitterSearchRssUrl) {
    return [];
  }

  const query = buildTwitterQuery(symbols);
  const response = await axios.get(config.twitterSearchRssUrl, {
    params: {
      q: query,
      f: 'tweets',
      lang: 'en',
    },
    timeout: 9000,
    headers: {
      'User-Agent': 'stock-news-bot/2.0',
      Accept: 'application/rss+xml,application/xml,text/xml',
    },
  });

  const parsed = parseRssItems(response.data, 'Twitter');
  return normalizeArticles(parsed, symbols).map((item) => ({
    ...item,
    source: item.source || 'Twitter',
  }));
}

function dedupeAndSortArticles(articles) {
  const seen = new Set();
  const deduped = [];

  for (const article of articles || []) {
    const key = article.url && article.url !== '#'
      ? article.url
      : `${article.title}|${article.publishedAt}`;

    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(article);
  }

  deduped.sort((left, right) => new Date(right.publishedAt) - new Date(left.publishedAt));
  const maxItems = Math.min(Math.max(Number(config.feedMaxItems) || 1000, 10), 1000);
  return deduped.slice(0, maxItems);
}

function createFallbackNews(symbols) {
  const timestamp = new Date().toISOString();
  return symbols.map((symbol, index) => ({
    id: `${symbol}-${timestamp}-${index}`,
    title: `${stripExchangeSuffix(symbol)} market watch update`,
    description: 'No Google/Twitter/NewsAPI headlines were available right now. Try again in a few minutes.',
    url: '#',
    source: 'Local Fallback',
    imageUrl: '',
    publishedAt: timestamp,
    relatedSymbols: [symbol],
  }));
}

function normalizePageLimit(limitInput) {
  const parsed = Number(limitInput);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_PAGE_LIMIT;
  }
  return Math.min(Math.max(Math.floor(parsed), 1), MAX_PAGE_LIMIT);
}

function encodeCursor(offset) {
  return Buffer.from(`offset:${offset}`, 'utf8').toString('base64url');
}

function decodeCursor(cursorInput) {
  const raw = String(cursorInput || '').trim();
  if (!raw) {
    return 0;
  }

  if (/^\d+$/.test(raw)) {
    return Math.max(0, Number(raw));
  }

  try {
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    const match = decoded.match(/^offset:(\d+)$/i);
    if (!match) {
      return 0;
    }
    return Math.max(0, Number(match[1]));
  } catch (_error) {
    return 0;
  }
}

function paginateArticles(items, options = {}) {
  const limit = normalizePageLimit(options.limit);
  const offset = decodeCursor(options.cursor);
  const list = Array.isArray(items) ? items : [];
  const pageItems = list.slice(offset, offset + limit);
  const nextOffset = offset + pageItems.length;
  const hasMore = nextOffset < list.length;

  return {
    news: pageItems,
    total: list.length,
    limit,
    cursor: String(options.cursor || ''),
    nextCursor: hasMore ? encodeCursor(nextOffset) : '',
    hasMore,
    loaded: nextOffset,
  };
}

async function getWatchlistNewsCollection(symbols) {
  const sanitized = (symbols || []).filter(Boolean);
  if (sanitized.length === 0) {
    return [];
  }

  const key = cacheKey(sanitized);
  const cached = newsCache.get(key);
  if (isFresh(cached)) {
    return cached.value;
  }

  const providerResults = await Promise.allSettled([
    fetchGoogleNewsRssArticles(sanitized),
    fetchNewsApiArticles(sanitized),
    fetchTwitterSearchRssArticles(sanitized),
  ]);

  const merged = providerResults
    .filter((result) => result.status === 'fulfilled')
    .flatMap((result) => result.value || []);
  let articles = dedupeAndSortArticles(merged);

  if (articles.length === 0) {
    articles = createFallbackNews(sanitized);
  }

  newsCache.set(key, {
    value: articles,
    fetchedAt: now(),
  });

  return articles;
}

async function getWatchlistNewsPage(symbols, options = {}) {
  const collection = await getWatchlistNewsCollection(symbols);
  return paginateArticles(collection, options);
}

async function getWatchlistNews(symbols, options = {}) {
  const page = await getWatchlistNewsPage(symbols, options);
  return page.news;
}

module.exports = {
  getWatchlistNews,
  getWatchlistNewsPage,
};
