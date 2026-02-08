const { useEffect, useMemo, useRef, useState } = React;
const FEED_PAGE_LIMIT = 10;
const WATCHLIST_CHUNK_SIZE = 8;
const WATCHLIST_CHUNK_DELAY_MS = 120;

const numberFmt = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const currencyFmt = new Intl.NumberFormat('en-IN', {
  style: 'currency',
  currency: 'INR',
  maximumFractionDigits: 2,
});
const SOURCE_LABEL_MAP = Object.freeze({
  nseindia: 'NSE',
  bseindia: 'BSE',
  tradingview: 'TV',
  yahoo: 'YH',
  screener: 'SCR',
  twelvedata: 'TD',
  alphavantage: 'AV',
  unavailable: '--',
});
const STATUS_LABEL_MAP = Object.freeze({
  live: 'L',
  stale: 'S',
  cached: 'C',
  unavailable: '--',
});

function formatNum(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '--';
  }
  return numberFmt.format(Number(value || 0));
}

function formatCurrency(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '--';
  }
  return currencyFmt.format(Number(value || 0));
}

function formatMarketCapInCrores(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '--';
  }

  const crores = Number(value) / 10000000;
  return `INR ${formatNum(crores)} Cr`;
}

function pctClass(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return '';
  }
  return Number(value) >= 0 ? 'positive' : 'negative';
}

function formatPercent(value) {
  const formatted = formatNum(value);
  return formatted === '--' ? '--' : `${formatted}%`;
}

function chunkArray(items, size) {
  const list = Array.isArray(items) ? items : [];
  const chunkSize = Math.max(Number(size) || 1, 1);
  const chunks = [];
  for (let index = 0; index < list.length; index += chunkSize) {
    chunks.push(list.slice(index, index + chunkSize));
  }
  return chunks;
}

function mergeQuotesBySymbol(previous, nextQuotes) {
  const map = new Map((previous || []).map((quote) => [quote.symbol, quote]));
  for (const quote of nextQuotes || []) {
    if (quote && quote.symbol) {
      map.set(quote.symbol, quote);
    }
  }
  return Array.from(map.values());
}

function formatStage(value) {
  return value && String(value).trim() ? String(value) : '--';
}

function stageClass(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'markup') {
    return 'stage-markup';
  }
  if (normalized === 'markdown') {
    return 'stage-markdown';
  }
  if (normalized === 'accumulation') {
    return 'stage-accumulation';
  }
  if (normalized === 'distribution') {
    return 'stage-distribution';
  }
  return 'stage-unknown';
}

function eventTypeClass(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'results') {
    return 'event-type-results';
  }
  if (normalized === 'concall') {
    return 'event-type-concall';
  }
  return 'event-type-default';
}

function formatCalendarTimestamp(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '--';
  }
  return parsed.toLocaleString('en-IN');
}

function formatWatchlistTimestamp(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return '--';
  }
  return parsed.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function getLatestSalesPoint(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return null;
  }

  const sales = Array.isArray(snapshot.sales) ? snapshot.sales : [];
  const labels = Array.isArray(snapshot.quarterLabels) ? snapshot.quarterLabels : [];
  const salesYoy = Array.isArray(snapshot.salesYoy) ? snapshot.salesYoy : [];

  const index = sales.findIndex((value) => Number.isFinite(Number(value)));
  if (index < 0) {
    return null;
  }

  return {
    sales: sales[index],
    yoy: salesYoy[index],
    label: labels[index] || '',
  };
}

function formatSalesSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return '';
  }

  if (snapshot.dataStatus === 'error') {
    return 'Sales snapshot error';
  }

  if (snapshot.dataStatus && snapshot.dataStatus !== 'available') {
    return 'Sales data unavailable';
  }

  const latest = getLatestSalesPoint(snapshot);
  if (!latest) {
    return 'Sales data unavailable';
  }

  const parts = [`Sales ${formatNum(latest.sales)}`];
  const yoyText = formatPercent(latest.yoy);
  if (yoyText !== '--') {
    parts.push(`YoY ${yoyText}`);
  }
  if (latest.label) {
    parts.push(latest.label);
  }

  return parts.join(' · ');
}

function formatSourceCellValue(source, dataStatus) {
  const sourceKey = String(source || '').trim().toLowerCase();
  const statusKey = String(dataStatus || '').trim().toLowerCase();
  const compactSource = SOURCE_LABEL_MAP[sourceKey] || String(source || '--');
  const compactStatus = STATUS_LABEL_MAP[statusKey] || String(dataStatus || '--');

  if (compactSource === '--' && compactStatus === '--') {
    return '--';
  }
  if (compactStatus === '--') {
    return compactSource;
  }
  return `${compactSource}/${compactStatus}`;
}

function formatSourceTitle(quote) {
  const fullSource = `${quote?.source || '--'} / ${quote?.dataStatus || '--'}`;
  const trace = Array.isArray(quote?.providerTrace)
    ? quote.providerTrace.filter(Boolean).join(' | ')
    : '';
  return trace ? `${fullSource} | ${trace}` : fullSource;
}

function formatFinancialMetricValue(value, kind) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return '--';
  }

  const numberText = formatNum(parsed);
  if (kind === 'percent') {
    return `${numberText}%`;
  }
  return numberText;
}

function emaVsPriceClass(emaValue, currentPrice) {
  const ema = Number(emaValue);
  const price = Number(currentPrice);
  if (Number.isNaN(ema) || Number.isNaN(price)) {
    return '';
  }
  return ema >= price ? 'ema-below-price' : '';
}

function emaColorSortBucket(emaValue, currentPrice) {
  const ema = Number(emaValue);
  const price = Number(currentPrice);
  if (Number.isNaN(ema) || Number.isNaN(price)) {
    return null;
  }
  return ema >= price ? 0 : 1;
}

function compareSortValues(leftValue, rightValue) {
  const leftMissing = leftValue === null || leftValue === undefined || leftValue === '';
  const rightMissing = rightValue === null || rightValue === undefined || rightValue === '';

  if (leftMissing && rightMissing) {
    return 0;
  }
  if (leftMissing) {
    return 1;
  }
  if (rightMissing) {
    return -1;
  }

  if (typeof leftValue === 'number' && typeof rightValue === 'number') {
    return leftValue - rightValue;
  }

  return String(leftValue).localeCompare(String(rightValue), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function getWatchlistSortValue(row, key) {
  const quote = row?.quote || {};
  switch (key) {
    case 'symbol':
      return row.symbol;
    case 'price':
      return quote.regularMarketPrice;
    case 'change':
      return quote.regularMarketChangePercent;
    case 'volume':
      return quote.regularMarketVolume;
    case 'marketCap':
      return quote.marketCap;
    case 'ema50':
      return emaColorSortBucket(quote.ema50, quote.regularMarketPrice);
    case 'ema200':
      return emaColorSortBucket(quote.ema200, quote.regularMarketPrice);
    case 'stage':
      return quote.marketCycleStage || '';
    case 'liveData':
      return row.liveData ? 1 : 0;
    case 'lastUpdated': {
      const parsed = Date.parse(String(row.cachedAt || ''));
      return Number.isFinite(parsed) ? parsed : null;
    }
    case 'source':
      return `${quote.source || ''} ${quote.dataStatus || ''}`.trim();
    case 'action':
      return row.symbol;
    default:
      return row.symbol;
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body.error || `Request failed: ${response.status}`);
  }

  return body;
}

function sortIndicatorForColumn(sortState, key) {
  if (!sortState || sortState.key !== key) {
    return '⇅';
  }
  return sortState.direction === 'asc' ? '↑' : '↓';
}

function TabSection({
  title = '',
  description = '',
  toolbar = null,
  children = null,
  footer = null,
}) {
  return (
    <section className="tab-section">
      <header className="tab-section-header">
        <div className="tab-section-heading">
          {title ? <h3 className="tab-section-title">{title}</h3> : null}
          {description ? <p className="tab-section-description">{description}</p> : null}
        </div>
        {toolbar ? <div className="tab-section-toolbar">{toolbar}</div> : null}
      </header>
      <div className="tab-section-body">{children}</div>
      {footer ? <div className="tab-section-footer">{footer}</div> : null}
    </section>
  );
}

function DataTable({
  columns,
  rows,
  rowKey,
  sortState = null,
  onSort = null,
  onRowClick = null,
  onRowKeyDown = null,
  getRowClassName = null,
  getRowTitle = null,
  tableClassName = '',
  wrapClassName = '',
  pageSize = 25,
  minWidth = 1040,
  emptyMessage = 'No rows found.',
}) {
  const safeColumns = Array.isArray(columns) ? columns : [];
  const safeRows = Array.isArray(rows) ? rows : [];
  const safePageSize = Math.max(Number(pageSize) || 25, 1);
  const totalPages = Math.max(1, Math.ceil(safeRows.length / safePageSize));
  const [page, setPage] = useState(1);

  useEffect(() => {
    setPage(1);
  }, [safeRows.length, safePageSize, sortState?.key, sortState?.direction]);

  useEffect(() => {
    if (page > totalPages) {
      setPage(totalPages);
    }
  }, [page, totalPages]);

  const pagedRows = useMemo(() => {
    const start = (page - 1) * safePageSize;
    return safeRows.slice(start, start + safePageSize);
  }, [safeRows, page, safePageSize]);

  const hasPagination = safeRows.length > safePageSize;

  return (
    <>
      <div className={`table-wrap app-table-wrap ${wrapClassName}`.trim()}>
        <table className={`app-table ${tableClassName}`.trim()} style={{ minWidth: `${minWidth}px` }}>
          <thead>
            <tr>
              {safeColumns.map((column) => {
                const sortable = Boolean(column?.sortable && typeof onSort === 'function');
                const ariaSort = sortable && sortState?.key === column.key
                  ? (sortState.direction === 'asc' ? 'ascending' : 'descending')
                  : 'none';
                return (
                  <th key={column.key} className={column.className || ''} aria-sort={ariaSort}>
                    {sortable ? (
                      <button
                        className={`th-button ${sortState?.key === column.key ? 'active' : ''}`}
                        onClick={() => onSort(column.key)}
                        type="button"
                      >
                        <span>{column.label}</span>
                        <span className="sort-indicator">{sortIndicatorForColumn(sortState, column.key)}</span>
                      </button>
                    ) : (
                      <span>{column.label}</span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {pagedRows.length === 0 ? (
              <tr>
                <td colSpan={Math.max(safeColumns.length, 1)}>
                  <div className="empty-state table-empty-state">{emptyMessage}</div>
                </td>
              </tr>
            ) : (
              pagedRows.map((row, index) => {
                const absoluteIndex = ((page - 1) * safePageSize) + index;
                const key = typeof rowKey === 'function'
                  ? rowKey(row, absoluteIndex)
                  : row?.[rowKey];
                const rowClassName = typeof getRowClassName === 'function'
                  ? getRowClassName(row, absoluteIndex)
                  : '';
                const rowTitle = typeof getRowTitle === 'function'
                  ? getRowTitle(row, absoluteIndex)
                  : '';
                const clickable = typeof onRowClick === 'function';

                return (
                  <tr
                    key={String(key ?? absoluteIndex)}
                    className={rowClassName}
                    onClick={clickable ? () => onRowClick(row, absoluteIndex) : undefined}
                    onKeyDown={(event) => {
                      if (typeof onRowKeyDown === 'function') {
                        onRowKeyDown(event, row, absoluteIndex);
                        return;
                      }
                      if (!clickable) {
                        return;
                      }
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onRowClick(row, absoluteIndex);
                      }
                    }}
                    tabIndex={clickable ? 0 : undefined}
                    title={rowTitle || undefined}
                  >
                    {safeColumns.map((column) => (
                      <td
                        key={`${column.key}-${key ?? absoluteIndex}`}
                        className={typeof column.cellClassName === 'function'
                          ? column.cellClassName(row, absoluteIndex)
                          : (column.cellClassName || '')}
                      >
                        {typeof column.renderCell === 'function'
                          ? column.renderCell(row, absoluteIndex)
                          : row?.[column.key]}
                      </td>
                    ))}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {hasPagination ? (
        <div className="table-pagination">
          <button
            className="secondary table-page-btn"
            type="button"
            onClick={() => setPage((prev) => Math.max(1, prev - 1))}
            disabled={page <= 1}
          >
            Prev
          </button>
          <span className="table-page-status">Page {page} / {totalPages}</span>
          <button
            className="secondary table-page-btn"
            type="button"
            onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
            disabled={page >= totalPages}
          >
            Next
          </button>
        </div>
      ) : null}
    </>
  );
}

function App() {
  const [activeTab, setActiveTab] = useState('watchlist');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [watchlist, setWatchlist] = useState([]);
  const [quotes, setQuotes] = useState([]);
  const [salesSnapshots, setSalesSnapshots] = useState({});
  const [salesSnapshotStatus, setSalesSnapshotStatus] = useState({});
  const [watchlistLoading, setWatchlistLoading] = useState(false);
  const [watchlistChunkLoading, setWatchlistChunkLoading] = useState(false);
  const [salesRefreshLoading, setSalesRefreshLoading] = useState(false);
  const [portfolio, setPortfolio] = useState({ positions: [], summary: { invested: 0, current: 0, pnl: 0, pnlPercent: 0 } });
  const [news, setNews] = useState([]);
  const [feedPage, setFeedPage] = useState({
    total: 0,
    limit: FEED_PAGE_LIMIT,
    nextCursor: '',
    hasMore: false,
    loaded: 0,
  });
  const [feedLoadingMore, setFeedLoadingMore] = useState(false);

  const [newSymbol, setNewSymbol] = useState('');
  const [symbolSuggestions, setSymbolSuggestions] = useState([]);
  const [symbolLookupLoading, setSymbolLookupLoading] = useState(false);
  const [positionForm, setPositionForm] = useState({ symbol: '', quantity: '', avgPrice: '' });
  const [screenerFilters, setScreenerFilters] = useState({ minChangePct: '', minVolume: '', minPrice: '', maxPrice: '' });
  const [screener, setScreener] = useState({ total: 0, matched: 0, results: [] });
  const [eventsFilters, setEventsFilters] = useState({ scope: 'all', type: 'all', days: '45' });
  const [eventsCalendar, setEventsCalendar] = useState({ scope: 'all', total: 0, groups: [], updatedAt: '' });
  const [eventsLoading, setEventsLoading] = useState(false);
  const [watchlistSort, setWatchlistSort] = useState({ key: 'symbol', direction: 'asc' });
  const [quarterlyModal, setQuarterlyModal] = useState({
    open: false,
    symbol: '',
    loading: false,
    error: '',
    data: null,
  });
  const newsListRef = useRef(null);
  const feedLoadTriggerRef = useRef(null);
  const feedRequestInFlightRef = useRef(false);
  const watchlistChunkRequestRef = useRef(0);

  function applyWatchlistSnapshot(payload) {
    const nextWatchlist = Array.isArray(payload?.watchlistEntries)
      ? payload.watchlistEntries
      : (payload?.watchlist || []).map((symbol) => ({ symbol, liveData: false, cachedAt: '' }));
    setWatchlist(nextWatchlist);
    if (Array.isArray(payload?.quotes)) {
      setQuotes(payload.quotes);
    }
    if (payload?.salesSnapshots && typeof payload.salesSnapshots === 'object') {
      setSalesSnapshots(payload.salesSnapshots);
    }
    if (payload?.salesSnapshotStatus && typeof payload.salesSnapshotStatus === 'object') {
      setSalesSnapshotStatus(payload.salesSnapshotStatus);
    }
  }

  const quoteMap = useMemo(() => new Map(quotes.map((quote) => [quote.symbol, quote])), [quotes]);
  const watchlistRows = useMemo(() => watchlist
    .map((entry) => {
      const symbol = typeof entry === 'string' ? entry : entry?.symbol;
      if (!symbol) {
        return null;
      }

      const quote = quoteMap.get(symbol);
      const salesSnapshot = salesSnapshots?.[symbol] || null;
      const nameCandidate = quote?.shortName || salesSnapshot?.companyName || '';
      const displayName = nameCandidate && nameCandidate !== symbol
        ? nameCandidate
        : '';
      const salesSummary = formatSalesSnapshot(salesSnapshot);
      const salesStatus = salesSnapshot?.dataStatus || (salesSummary ? 'unavailable' : 'pending');
      return {
        symbol,
        quote,
        displayName,
        salesSummary,
        salesStatus,
        liveData: Boolean(entry?.liveData),
        cachedAt: entry?.cachedAt || quote?.watchlistCachedAt || '',
        sourceText: formatSourceCellValue(quote?.source, quote?.dataStatus),
        sourceTitle: formatSourceTitle(quote),
      };
    })
    .filter(Boolean), [watchlist, quoteMap, salesSnapshots]);

  const sortedWatchlistRows = useMemo(() => {
    const direction = watchlistSort.direction === 'desc' ? -1 : 1;
    return [...watchlistRows].sort((leftRow, rightRow) => {
      const leftValue = getWatchlistSortValue(leftRow, watchlistSort.key);
      const rightValue = getWatchlistSortValue(rightRow, watchlistSort.key);
      const compared = compareSortValues(leftValue, rightValue);
      if (compared !== 0) {
        return compared * direction;
      }
      return leftRow.symbol.localeCompare(rightRow.symbol, undefined, {
        numeric: true,
        sensitivity: 'base',
      });
    });
  }, [watchlistRows, watchlistSort]);

  useEffect(() => {
    const symbols = watchlist
      .map((entry) => (typeof entry === 'string' ? entry : entry?.symbol))
      .filter(Boolean);
    const requestId = watchlistChunkRequestRef.current + 1;
    watchlistChunkRequestRef.current = requestId;

    if (symbols.length === 0) {
      setWatchlistChunkLoading(false);
      return undefined;
    }

    const symbolSet = new Set(symbols);
    setQuotes((previous) => previous.filter((quote) => symbolSet.has(quote.symbol)));
    setSalesSnapshots((previous) => {
      const next = {};
      symbols.forEach((symbol) => {
        if (previous?.[symbol]) {
          next[symbol] = previous[symbol];
        }
      });
      return next;
    });

    setWatchlistChunkLoading(true);
    const chunks = chunkArray(symbols, WATCHLIST_CHUNK_SIZE);

    (async () => {
      for (const chunk of chunks) {
        if (requestId !== watchlistChunkRequestRef.current) {
          return;
        }
        try {
          const params = new URLSearchParams({ symbols: chunk.join(',') });
          const response = await fetchJson(`/api/watchlist/chunk?${params.toString()}`);
          if (requestId !== watchlistChunkRequestRef.current) {
            return;
          }

          if (Array.isArray(response.quotes)) {
            setQuotes((previous) => mergeQuotesBySymbol(previous, response.quotes));
          }
          if (response.salesSnapshots && typeof response.salesSnapshots === 'object') {
            setSalesSnapshots((previous) => ({ ...previous, ...response.salesSnapshots }));
          }
          if (response.salesSnapshotStatus && typeof response.salesSnapshotStatus === 'object') {
            setSalesSnapshotStatus(response.salesSnapshotStatus);
          }
        } catch (chunkError) {
          if (requestId === watchlistChunkRequestRef.current) {
            setError(chunkError.message);
          }
        }

        if (WATCHLIST_CHUNK_DELAY_MS > 0) {
          await new Promise((resolve) => setTimeout(resolve, WATCHLIST_CHUNK_DELAY_MS));
        }
      }

      if (requestId === watchlistChunkRequestRef.current) {
        setWatchlistChunkLoading(false);
      }
    })();

    return undefined;
  }, [watchlist]);

  async function loadAll() {
    setLoading(true);
    setWatchlistLoading(true);
    setEventsLoading(true);
    setFeedLoadingMore(false);
    feedRequestInFlightRef.current = false;
    setError('');

    try {
      const eventsParams = new URLSearchParams({
        scope: eventsFilters.scope,
        type: eventsFilters.type,
        days: String(eventsFilters.days),
      });
      const feedParams = new URLSearchParams({
        limit: String(FEED_PAGE_LIMIT),
      });

      const watchlistRes = await fetchJson('/api/watchlist/entries');
      applyWatchlistSnapshot(watchlistRes);
      setWatchlistLoading(false);
      setLoading(false);

      const [portfolioRes, feedRes, eventsRes] = await Promise.all([
        fetchJson('/api/portfolio'),
        fetchJson(`/api/feed/news?${feedParams.toString()}`),
        fetchJson(`/api/events?${eventsParams.toString()}`),
      ]);

      setPortfolio(portfolioRes);
      setNews(feedRes.news || []);
      setFeedPage({
        total: Number(feedRes.total || (feedRes.news || []).length),
        limit: Number(feedRes.limit || FEED_PAGE_LIMIT),
        nextCursor: String(feedRes.nextCursor || ''),
        hasMore: Boolean(feedRes.hasMore),
        loaded: Number(feedRes.loaded || (feedRes.news || []).length),
      });
      setEventsCalendar({
        scope: eventsRes.scope || eventsFilters.scope,
        total: Number(eventsRes.total || 0),
        groups: Array.isArray(eventsRes.groups) ? eventsRes.groups : [],
        updatedAt: eventsRes.updatedAt || '',
      });
    } catch (loadError) {
      setError(loadError.message);
    } finally {
      setLoading(false);
      setWatchlistLoading(false);
      setEventsLoading(false);
    }
  }

  async function loadMoreFeedNews() {
    if (feedRequestInFlightRef.current || !feedPage.hasMore || !feedPage.nextCursor) {
      return;
    }

    feedRequestInFlightRef.current = true;
    setFeedLoadingMore(true);

    try {
      const params = new URLSearchParams({
        limit: String(FEED_PAGE_LIMIT),
        cursor: feedPage.nextCursor,
      });
      const response = await fetchJson(`/api/feed/news?${params.toString()}`);
      const pageNews = Array.isArray(response.news) ? response.news : [];

      setNews((previous) => {
        if (pageNews.length === 0) {
          return previous;
        }
        const seen = new Set(previous.map((item) => item.id));
        const merged = [...previous];
        for (const item of pageNews) {
          if (seen.has(item.id)) {
            continue;
          }
          seen.add(item.id);
          merged.push(item);
        }
        return merged;
      });

      setFeedPage((previous) => ({
        total: Number(response.total || previous.total),
        limit: Number(response.limit || FEED_PAGE_LIMIT),
        nextCursor: String(response.nextCursor || ''),
        hasMore: Boolean(response.hasMore),
        loaded: Number(response.loaded || previous.loaded),
      }));
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      feedRequestInFlightRef.current = false;
      setFeedLoadingMore(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  useEffect(() => {
    if (activeTab !== 'feed') {
      return undefined;
    }

    const container = newsListRef.current;
    const trigger = feedLoadTriggerRef.current;
    if (!container || !trigger || !feedPage.hasMore) {
      return undefined;
    }

    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting);
      if (!visible) {
        return;
      }
      loadMoreFeedNews();
    }, {
      root: container,
      rootMargin: '220px 0px',
      threshold: 0,
    });

    observer.observe(trigger);
    return () => observer.disconnect();
  }, [activeTab, feedPage.hasMore, feedPage.nextCursor, feedLoadingMore]);

  useEffect(() => {
    const query = newSymbol.trim();
    if (activeTab !== 'watchlist' || query.length < 1) {
      setSymbolSuggestions([]);
      setSymbolLookupLoading(false);
      return undefined;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      setSymbolLookupLoading(true);
      try {
        const params = new URLSearchParams({
          q: query,
          limit: '8',
        });
        const response = await fetchJson(`/api/symbols/search?${params.toString()}`);
        if (!cancelled) {
          setSymbolSuggestions(Array.isArray(response.items) ? response.items : []);
        }
      } catch (_error) {
        if (!cancelled) {
          setSymbolSuggestions([]);
        }
      } finally {
        if (!cancelled) {
          setSymbolLookupLoading(false);
        }
      }
    }, 120);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [activeTab, newSymbol]);

  useEffect(() => {
    if (!quarterlyModal.open) {
      return undefined;
    }

    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        setQuarterlyModal((previous) => ({ ...previous, open: false }));
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [quarterlyModal.open]);

  function resolveSymbolInputToSuggestion(symbolInput) {
    const raw = String(symbolInput || '').trim();
    if (!raw) {
      return '';
    }

    const symbolHintMatch = raw.match(/\(([A-Z0-9._-]+)\)\s*$/i);
    if (symbolHintMatch && symbolHintMatch[1]) {
      return symbolHintMatch[1].toUpperCase();
    }

    const normalized = raw.toUpperCase();
    const matched = symbolSuggestions.find((item) => (
      String(item.symbol || '').toUpperCase() === normalized
      || String(item.baseSymbol || '').toUpperCase() === normalized
      || String(item.companyName || '').toUpperCase() === normalized
    ));

    return matched?.symbol || raw;
  }

  async function addWatchlistSymbol(symbolInput) {
    const resolvedInput = resolveSymbolInputToSuggestion(symbolInput);
    if (!resolvedInput) {
      return;
    }

    try {
      const response = await fetchJson('/api/watchlist', {
        method: 'POST',
        body: JSON.stringify({ symbol: resolvedInput }),
      });
      setNewSymbol('');
      setSymbolSuggestions([]);
      applyWatchlistSnapshot(response);
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function onAddToWatchlist(event) {
    event.preventDefault();
    await addWatchlistSymbol(newSymbol);
  }

  function onWatchlistInputChange(event) {
    const value = event.target.value;
    setNewSymbol(value);

    if (!value || !symbolSuggestions.length) {
      return;
    }

    const matched = symbolSuggestions.find((item) => (
      String(item.symbol || '').toUpperCase() === String(value).toUpperCase()
      || String(item.companyName || '').toUpperCase() === String(value).toUpperCase()
      || String(item.baseSymbol || '').toUpperCase() === String(value).toUpperCase()
      || `${item.companyName} (${item.symbol})`.toUpperCase() === String(value).toUpperCase()
    ));

    if (matched) {
      addWatchlistSymbol(matched.symbol);
    }
  }

  async function onDeleteWatchlist(symbol) {
    try {
      const response = await fetchJson(`/api/watchlist/${encodeURIComponent(symbol)}`, {
        method: 'DELETE',
      });
      applyWatchlistSnapshot(response);
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  function closeQuarterlyModal() {
    setQuarterlyModal((previous) => ({ ...previous, open: false }));
  }

  async function onOpenQuarterlyModal(symbol) {
    const normalizedSymbol = String(symbol || '').trim().toUpperCase();
    if (!normalizedSymbol) {
      return;
    }

    setQuarterlyModal({
      open: true,
      symbol: normalizedSymbol,
      loading: true,
      error: '',
      data: null,
    });

    try {
      const response = await fetchJson(`/api/market/financials/${encodeURIComponent(normalizedSymbol)}?limit=6`);
      setQuarterlyModal({
        open: true,
        symbol: normalizedSymbol,
        loading: false,
        error: '',
        data: response,
      });
    } catch (requestError) {
      setQuarterlyModal({
        open: true,
        symbol: normalizedSymbol,
        loading: false,
        error: requestError.message,
        data: null,
      });
    }
  }

  function onWatchlistRowKeyDown(event, symbol) {
    const target = event.target;
    if (target && typeof target.closest === 'function' && target.closest('button, a, input, select, textarea')) {
      return;
    }

    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onOpenQuarterlyModal(symbol);
    }
  }

  async function onToggleWatchlistLiveData(liveData) {
    try {
      const response = await fetchJson('/api/watchlist/live', {
        method: 'PATCH',
        body: JSON.stringify({ liveData }),
      });
      applyWatchlistSnapshot(response);
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function onRefreshWatchlistQuotes() {
    setWatchlistLoading(true);
    try {
      const response = await fetchJson('/api/watchlist/refresh', {
        method: 'POST',
      });
      applyWatchlistSnapshot(response);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setWatchlistLoading(false);
    }
  }

  async function onRefreshSalesSnapshot() {
    setSalesRefreshLoading(true);
    try {
      const response = await fetchJson('/api/sales/refresh', {
        method: 'POST',
      });
      setSalesSnapshotStatus(response);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSalesRefreshLoading(false);
    }
  }

  async function onAddPosition(event) {
    event.preventDefault();

    try {
      const response = await fetchJson('/api/portfolio', {
        method: 'POST',
        body: JSON.stringify({
          symbol: positionForm.symbol,
          quantity: Number(positionForm.quantity),
          avgPrice: Number(positionForm.avgPrice),
        }),
      });

      setPortfolio(response);
      setPositionForm({ symbol: '', quantity: '', avgPrice: '' });
      await loadAll();
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function onDeletePosition(id) {
    try {
      const response = await fetchJson(`/api/portfolio/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      setPortfolio(response);
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function onRunScreener(event) {
    event.preventDefault();

    try {
      const params = new URLSearchParams();
      Object.entries(screenerFilters).forEach(([key, value]) => {
        if (String(value).trim()) {
          params.set(key, value);
        }
      });

      const response = await fetchJson(`/api/screener?${params.toString()}`);
      setScreener(response);
      setActiveTab('screener');
    } catch (requestError) {
      setError(requestError.message);
    }
  }

  async function onLoadEvents(event) {
    event.preventDefault();
    setEventsLoading(true);

    try {
      const params = new URLSearchParams({
        scope: eventsFilters.scope,
        type: eventsFilters.type,
        days: String(eventsFilters.days),
      });
      const response = await fetchJson(`/api/events?${params.toString()}`);
      setEventsCalendar({
        scope: response.scope || eventsFilters.scope,
        total: Number(response.total || 0),
        groups: Array.isArray(response.groups) ? response.groups : [],
        updatedAt: response.updatedAt || '',
      });
      setActiveTab('events');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setEventsLoading(false);
    }
  }

  function onWatchlistSort(key) {
    setWatchlistSort((previous) => {
      if (previous.key === key) {
        return {
          key,
          direction: previous.direction === 'asc' ? 'desc' : 'asc',
        };
      }
      return { key, direction: 'asc' };
    });
  }

  const headerMetrics = [
    { label: 'Watchlist', value: watchlist.length },
    { label: 'Portfolio Value', value: formatCurrency(portfolio.summary.current) },
    { label: 'Net P&L', value: formatCurrency(portfolio.summary.pnl) },
    { label: 'P&L %', value: formatPercent(portfolio.summary.pnlPercent) },
  ];

  const watchlistLastUpdated = useMemo(() => {
    let maxMs = 0;
    for (const row of watchlistRows) {
      const parsed = Date.parse(String(row?.cachedAt || ''));
      if (Number.isFinite(parsed) && parsed > maxMs) {
        maxMs = parsed;
      }
    }
    return maxMs > 0 ? new Date(maxMs).toISOString() : '';
  }, [watchlistRows]);

  const watchlistAllLive = watchlistRows.length > 0 && watchlistRows.every((row) => row.liveData);
  const watchlistSomeLive = watchlistRows.some((row) => row.liveData);
  const quarterlyLabels = Array.isArray(quarterlyModal.data?.quarterLabels)
    ? quarterlyModal.data.quarterLabels
    : [];
  const quarterlyRows = Array.isArray(quarterlyModal.data?.rows)
    ? quarterlyModal.data.rows
    : [];
  const watchlistColumns = [
    {
      key: 'symbol',
      label: 'Symbol',
      sortable: true,
      renderCell: (row) => (
        <div className="symbol-cell">
          <div className="symbol-ticker">{row.symbol}</div>
          {row.displayName ? <div className="symbol-name">{row.displayName}</div> : null}
          {row.salesSummary ? (
            <div className={`symbol-sales ${row.salesStatus === 'available' ? '' : 'muted'}`}>{row.salesSummary}</div>
          ) : (
            <div className="symbol-sales muted">Sales snapshot pending</div>
          )}
        </div>
      ),
    },
    {
      key: 'price',
      label: 'Price',
      sortable: true,
      renderCell: (row) => formatCurrency(row.quote?.regularMarketPrice),
    },
    {
      key: 'change',
      label: 'Change %',
      sortable: true,
      cellClassName: (row) => pctClass(row.quote?.regularMarketChangePercent),
      renderCell: (row) => formatPercent(row.quote?.regularMarketChangePercent),
    },
    {
      key: 'volume',
      label: 'Volume',
      sortable: true,
      renderCell: (row) => formatNum(row.quote?.regularMarketVolume),
    },
    {
      key: 'marketCap',
      label: 'Market Cap',
      sortable: true,
      renderCell: (row) => formatMarketCapInCrores(row.quote?.marketCap),
    },
    {
      key: 'ema50',
      label: 'EMA 50',
      sortable: true,
      cellClassName: (row) => emaVsPriceClass(row.quote?.ema50, row.quote?.regularMarketPrice),
      renderCell: (row) => formatCurrency(row.quote?.ema50),
    },
    {
      key: 'ema200',
      label: 'EMA 200',
      sortable: true,
      cellClassName: (row) => emaVsPriceClass(row.quote?.ema200, row.quote?.regularMarketPrice),
      renderCell: (row) => formatCurrency(row.quote?.ema200),
    },
    {
      key: 'stage',
      label: 'Stage',
      sortable: true,
      renderCell: (row) => (
        <span className={`stage-pill ${stageClass(row.quote?.marketCycleStage)}`}>
          {formatStage(row.quote?.marketCycleStage)}
        </span>
      ),
    },
    {
      key: 'source',
      label: 'Source',
      sortable: true,
      className: 'source-col',
      cellClassName: 'source-cell',
      renderCell: (row) => (
        <span title={row.sourceTitle}>{row.sourceText}</span>
      ),
    },
    {
      key: 'action',
      label: 'Action',
      className: 'action-col',
      cellClassName: 'action-cell',
      renderCell: (row) => (
        <button
          className="icon-remove-btn"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onDeleteWatchlist(row.symbol);
          }}
          onKeyDown={(event) => event.stopPropagation()}
          title={`Remove ${row.symbol}`}
          aria-label={`Remove ${row.symbol} from watchlist`}
        >
          <span aria-hidden="true">Remove</span>
        </button>
      ),
    },
  ];
  const portfolioColumns = [
    { key: 'symbol', label: 'Symbol', renderCell: (row) => row.symbol },
    { key: 'quantity', label: 'Qty', renderCell: (row) => formatNum(row.quantity) },
    { key: 'avgPrice', label: 'Avg Price', renderCell: (row) => formatCurrency(row.avgPrice) },
    { key: 'ltp', label: 'LTP', renderCell: (row) => formatCurrency(row.quote?.regularMarketPrice) },
    { key: 'invested', label: 'Invested', renderCell: (row) => formatCurrency(row.invested) },
    { key: 'current', label: 'Current', renderCell: (row) => formatCurrency(row.current) },
    {
      key: 'pnl',
      label: 'P&L',
      cellClassName: (row) => pctClass(row.pnl),
      renderCell: (row) => `${formatCurrency(row.pnl)} (${formatPercent(row.pnlPercent)})`,
    },
    {
      key: 'action',
      label: 'Action',
      cellClassName: 'action-cell',
      renderCell: (row) => (
        <button className="danger" type="button" onClick={() => onDeletePosition(row.id)}>
          Delete
        </button>
      ),
    },
  ];
  const screenerColumns = [
    { key: 'symbol', label: 'Symbol', renderCell: (row) => row.symbol },
    { key: 'price', label: 'Price', renderCell: (row) => formatCurrency(row.regularMarketPrice) },
    {
      key: 'change',
      label: 'Change %',
      cellClassName: (row) => pctClass(row.regularMarketChangePercent),
      renderCell: (row) => formatPercent(row.regularMarketChangePercent),
    },
    { key: 'volume', label: 'Volume', renderCell: (row) => formatNum(row.regularMarketVolume) },
    { key: 'marketCap', label: 'Market Cap', renderCell: (row) => formatMarketCapInCrores(row.marketCap) },
    {
      key: 'source',
      label: 'Source',
      className: 'source-col',
      cellClassName: 'source-cell',
      renderCell: (row) => (
        <span title={formatSourceTitle(row)}>
          {formatSourceCellValue(row.source, row.dataStatus)}
        </span>
      ),
    },
  ];
  const quarterlyColumns = useMemo(() => [
    {
      key: 'metric',
      label: 'Metric',
      cellClassName: 'financial-row-label',
      renderCell: (row) => row.label,
    },
    ...quarterlyLabels.map((label, index) => ({
      key: `quarter-${index}`,
      label,
      cellClassName: (row) => (row.kind === 'percent' ? pctClass(row.values?.[index]) : ''),
      renderCell: (row) => formatFinancialMetricValue(row.values?.[index], row.kind),
    })),
  ], [quarterlyLabels]);

  return (
    <div className="app-shell">
      <section className="header-card">
        <h1 className="header-title">SignalDesk Market Console</h1>
        <div className="header-subtitle">
          Live watchlists, portfolio health, and event radar aligned in one calm trading workspace.
        </div>
        <div className="metrics-grid">
          {headerMetrics.map((metric) => (
            <div className="metric-chip" key={metric.label}>
              <div className="metric-label">{metric.label}</div>
              <div className={`metric-value ${metric.label === 'P&L %' ? pctClass(portfolio.summary.pnlPercent) : ''}`}>
                {metric.value}
              </div>
            </div>
          ))}
        </div>
      </section>

      {error && (
        <section className="panel alert-panel">
          <div className="panel-body alert-panel-body">
            {error}
          </div>
        </section>
      )}

      <div className="layout-grid single">
        <main className="panel">
          <div className="panel-header">
            <h2 className="panel-title">Market Workspace</h2>
            <div className="tabs">
              {[
                { key: 'watchlist', label: 'Watchlist' },
                { key: 'portfolio', label: 'Portfolio' },
                { key: 'screener', label: 'Screener' },
                { key: 'feed', label: 'Market Feed' },
                { key: 'events', label: 'Events' },
              ].map((tab) => (
                <button
                  key={tab.key}
                  className={`tab-button ${activeTab === tab.key ? 'active' : ''}`}
                  onClick={() => setActiveTab(tab.key)}
                  type="button"
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          <div className="panel-body">
            {loading && activeTab !== 'watchlist' ? <div className="empty-state">Syncing market data...</div> : null}

            {activeTab === 'watchlist' && (
              <TabSection
                title="Signal Watchlist"
                description="Track live and cached quotes, technical posture, and one-click quarterly fundamentals."
                toolbar={(
                  <div className="watchlist-table-tools">
                    <label className="live-toggle-control">
                      <input
                        type="checkbox"
                        checked={watchlistAllLive}
                        onChange={(event) => onToggleWatchlistLiveData(event.target.checked)}
                      />
                      <span>Enable live data for all</span>
                    </label>
                    <button className="secondary" type="button" onClick={onRefreshWatchlistQuotes}>
                      Refresh quotes
                    </button>
                    <button
                      className="secondary"
                      type="button"
                      onClick={onRefreshSalesSnapshot}
                      disabled={salesRefreshLoading}
                    >
                      {salesRefreshLoading ? 'Refreshing...' : 'Refresh sales'}
                    </button>
                    <span className="watchlist-table-note">
                      Last updated: {formatWatchlistTimestamp(watchlistLastUpdated)}
                      {watchlistSomeLive && !watchlistAllLive ? ' | Mixed Mode' : ''}
                      {salesSnapshotStatus?.updatedAt ? ` | Sales snapshot: ${formatCalendarTimestamp(salesSnapshotStatus.updatedAt)}` : ''}
                      {watchlistChunkLoading ? ' | Loading quotes in batches...' : ''}
                    </span>
                  </div>
                )}
              >
                <form className="action-row" onSubmit={onAddToWatchlist}>
                  <input
                    value={newSymbol}
                    onChange={onWatchlistInputChange}
                    placeholder="Add ticker or company (RELIANCE / 543928 / Reliance Industries)"
                    list="watchlist-symbol-suggestions"
                  />
                </form>
                <datalist id="watchlist-symbol-suggestions">
                  {symbolSuggestions.map((item) => (
                    <option
                      key={`${item.symbol}-${item.exchange}`}
                      value={`${item.companyName} (${item.symbol})`}
                      label={`${item.symbol} (${item.exchange})`}
                    />
                  ))}
                </datalist>

                {(symbolLookupLoading || symbolSuggestions.length > 0) ? (
                  <div className="symbol-suggest-wrap">
                    {symbolLookupLoading ? (
                      <div className="symbol-suggest-meta">Scanning symbol master...</div>
                    ) : null}
                    {symbolSuggestions.map((item) => (
                      <button
                        key={`${item.symbol}-${item.exchange}-quick`}
                        className="symbol-suggest-item"
                        type="button"
                        onClick={() => addWatchlistSymbol(item.symbol)}
                      >
                        <span className="symbol-suggest-symbol">{item.symbol}</span>
                        <span className="symbol-suggest-name">{item.companyName}</span>
                      </button>
                    ))}
                  </div>
                ) : null}

                {watchlistLoading && watchlist.length === 0 ? (
                  <div className="empty-state">Loading watchlist symbols...</div>
                ) : watchlist.length === 0 ? (
                  <div className="empty-state">Your watchlist is empty. Add a ticker to begin.</div>
                ) : (
                  <DataTable
                    columns={watchlistColumns}
                    rows={sortedWatchlistRows}
                    rowKey={(row) => row.symbol}
                    sortState={watchlistSort}
                    onSort={onWatchlistSort}
                    getRowClassName={() => 'watchlist-row-clickable'}
                    getRowTitle={(row) => `Open quarterly financials for ${row.symbol}`}
                    onRowClick={(row) => onOpenQuarterlyModal(row.symbol)}
                    onRowKeyDown={(event, row) => onWatchlistRowKeyDown(event, row.symbol)}
                    pageSize={100}
                    minWidth={1060}
                    emptyMessage="Your watchlist is empty. Add a ticker to begin."
                  />
                )}
              </TabSection>
            )}

            {!loading && activeTab === 'portfolio' && (
              <TabSection
                title="Portfolio Health"
                description="Review holdings, exposure, and live P&L in a single at-a-glance panel."
                footer={(
                  <span>
                    Summary: Invested {formatCurrency(portfolio.summary.invested)} | Current {formatCurrency(portfolio.summary.current)} |
                    <span className={pctClass(portfolio.summary.pnl)}> P&L {formatCurrency(portfolio.summary.pnl)} ({formatPercent(portfolio.summary.pnlPercent)})</span>
                  </span>
                )}
              >
                <form className="action-row" onSubmit={onAddPosition}>
                  <input
                    value={positionForm.symbol}
                    onChange={(event) => setPositionForm((prev) => ({ ...prev, symbol: event.target.value }))}
                    placeholder="Symbol"
                  />
                  <input
                    value={positionForm.quantity}
                    onChange={(event) => setPositionForm((prev) => ({ ...prev, quantity: event.target.value }))}
                    placeholder="Quantity"
                    type="number"
                    step="0.01"
                    min="0"
                  />
                  <input
                    value={positionForm.avgPrice}
                    onChange={(event) => setPositionForm((prev) => ({ ...prev, avgPrice: event.target.value }))}
                    placeholder="Average Buy Price"
                    type="number"
                    step="0.01"
                    min="0"
                  />
                  <button className="primary" type="submit">Add Position</button>
                </form>

                {portfolio.positions.length === 0 ? (
                  <div className="empty-state">No positions yet. Add your first holding above.</div>
                ) : (
                  <DataTable
                    columns={portfolioColumns}
                    rows={portfolio.positions}
                    rowKey={(row) => row.id}
                    pageSize={15}
                    minWidth={900}
                    emptyMessage="No positions yet. Add your first holding above."
                  />
                )}
              </TabSection>
            )}

            {!loading && activeTab === 'screener' && (
              <TabSection
                title="Momentum Screener"
                description="Filter tracked symbols with volume, price range, and momentum thresholds."
                footer={<span>Matched {screener.matched} of {screener.total} watchlist stocks.</span>}
              >
                <form className="action-row" onSubmit={onRunScreener}>
                  <input
                    placeholder="Min Change %"
                    value={screenerFilters.minChangePct}
                    onChange={(event) => setScreenerFilters((prev) => ({ ...prev, minChangePct: event.target.value }))}
                    type="number"
                    step="0.01"
                  />
                  <input
                    placeholder="Min Volume"
                    value={screenerFilters.minVolume}
                    onChange={(event) => setScreenerFilters((prev) => ({ ...prev, minVolume: event.target.value }))}
                    type="number"
                    step="1"
                  />
                  <input
                    placeholder="Min Price"
                    value={screenerFilters.minPrice}
                    onChange={(event) => setScreenerFilters((prev) => ({ ...prev, minPrice: event.target.value }))}
                    type="number"
                    step="0.01"
                  />
                  <input
                    placeholder="Max Price"
                    value={screenerFilters.maxPrice}
                    onChange={(event) => setScreenerFilters((prev) => ({ ...prev, maxPrice: event.target.value }))}
                    type="number"
                    step="0.01"
                  />
                  <button className="primary" type="submit">Run Screener</button>
                </form>

                {screener.results.length === 0 ? (
                  <div className="empty-state">No screener results yet. Set filters and run.</div>
                ) : (
                  <DataTable
                    columns={screenerColumns}
                    rows={screener.results}
                    rowKey={(row) => row.symbol}
                    pageSize={100}
                    minWidth={860}
                    emptyMessage="No screener results yet. Set filters and run."
                  />
                )}
              </TabSection>
            )}

            {!loading && activeTab === 'events' && (
              <TabSection
                title="Corporate Calendar"
                description="Track earnings, calls, and key events for the symbols you follow."
                footer={(
                  <span>
                    {eventsCalendar.total} upcoming events | Last refresh: {formatCalendarTimestamp(eventsCalendar.updatedAt)}
                  </span>
                )}
              >
                <form className="action-row" onSubmit={onLoadEvents}>
                  <select
                    value={eventsFilters.scope}
                    onChange={(event) => setEventsFilters((prev) => ({ ...prev, scope: event.target.value }))}
                  >
                    <option value="all">Watchlist + Portfolio</option>
                    <option value="watchlist">Watchlist only</option>
                    <option value="portfolio">Portfolio only</option>
                  </select>
                  <select
                    value={eventsFilters.type}
                    onChange={(event) => setEventsFilters((prev) => ({ ...prev, type: event.target.value }))}
                  >
                    <option value="all">Results + Concall</option>
                    <option value="results">Results</option>
                    <option value="concall">Concall</option>
                  </select>
                  <select
                    value={eventsFilters.days}
                    onChange={(event) => setEventsFilters((prev) => ({ ...prev, days: event.target.value }))}
                  >
                    <option value="15">Next 15 days</option>
                    <option value="30">Next 30 days</option>
                    <option value="45">Next 45 days</option>
                    <option value="90">Next 90 days</option>
                  </select>
                  <button className="primary" type="submit">Load Calendar</button>
                </form>

                {eventsLoading ? (
                  <div className="empty-state">Loading upcoming events...</div>
                ) : eventsCalendar.groups.length === 0 ? (
                  <div className="empty-state">No upcoming results or calls within this window.</div>
                ) : (
                  <div className="events-board">
                    {eventsCalendar.groups.map((group) => (
                      <section className="events-day-group" key={group.date}>
                        <header className="events-day-header">
                          <div className="events-day-title">{group.label || group.date}</div>
                          <span className="pill">{group.items.length}</span>
                        </header>
                        <div className="events-list">
                          {(group.items || []).map((item) => (
                            <article className="event-item" key={item.id}>
                              <div className="event-main">
                                <div className="event-title">{item.symbol} | {item.companyName || '--'}</div>
                                <div className="event-subtitle">{item.title}</div>
                                <div className="event-meta-row">
                                  <span className={`event-type-pill ${eventTypeClass(item.eventType)}`}>
                                    {item.eventLabel || item.eventType || 'Event'}
                                  </span>
                                  <span>{item.source || '--'}</span>
                                </div>
                              </div>
                              {item.url && item.url !== '#' ? (
                                <a className="event-link" href={item.url} target="_blank" rel="noreferrer">
                                  Source
                                </a>
                              ) : null}
                            </article>
                          ))}
                        </div>
                      </section>
                    ))}
                  </div>
                )}
              </TabSection>
            )}

            {!loading && activeTab === 'feed' && (
              <TabSection
                title="Market Feed"
                description="Unified coverage across sources for your tracked symbols."
                footer={(
                  <span>
                    Loaded {news.length} of {feedPage.total} posts
                    {feedPage.hasMore ? ' | Scroll down to load next 10' : ''}
                  </span>
                )}
              >
                {news.length === 0 ? (
                  <div className="empty-state">No news yet for the current watchlist.</div>
                ) : (
                  <div className="news-list" ref={newsListRef}>
                    {news.map((item) => (
                      <article className="news-card" key={item.id}>
                        <h3 className="news-title">{item.title}</h3>
                        <div className="news-meta">
                          <span className="pill">{item.source}</span>
                          <span className="news-meta-time">{new Date(item.publishedAt).toLocaleString()}</span>
                          {item.relatedSymbols?.length ? (
                            <span className="news-meta-tags">#{item.relatedSymbols.join(' #')}</span>
                          ) : null}
                        </div>
                        <p className="news-description">{item.description}</p>
                      </article>
                    ))}
                    {feedLoadingMore ? (
                      <div className="feed-loading">Loading the next 10 posts...</div>
                    ) : null}
                    {feedPage.hasMore ? <div className="feed-load-trigger" ref={feedLoadTriggerRef} /> : null}
                  </div>
                )}
                {feedPage.hasMore && !feedLoadingMore ? (
                  <button className="secondary" type="button" onClick={loadMoreFeedNews}>
                    Load more
                  </button>
                ) : null}
              </TabSection>
            )}
          </div>
        </main>
      </div>

      {quarterlyModal.open ? (
        <div className="financial-modal-backdrop" onClick={closeQuarterlyModal}>
          <section className="financial-modal" onClick={(event) => event.stopPropagation()}>
            <header className="financial-modal-header">
              <div>
                <h3 className="financial-modal-title">
                  {quarterlyModal.symbol} Quarterly Metrics
                </h3>
                <div className="financial-modal-subtitle">
                  {quarterlyModal.data?.companyName || '--'}
                  {quarterlyLabels.length > 0 ? ` | Last ${quarterlyLabels.length} quarters` : ''}
                </div>
              </div>
              <button
                className="financial-close-btn"
                type="button"
                onClick={closeQuarterlyModal}
                aria-label="Close quarterly financial popup"
              >
                <span aria-hidden="true">Close</span>
              </button>
            </header>

            <div className="financial-modal-body">
              {quarterlyModal.loading ? (
                <div className="empty-state">Loading quarterly financials...</div>
              ) : null}

              {!quarterlyModal.loading && quarterlyModal.error ? (
                <div className="empty-state">{quarterlyModal.error}</div>
              ) : null}

              {!quarterlyModal.loading && !quarterlyModal.error && quarterlyRows.length > 0 && quarterlyLabels.length > 0 ? (
                <DataTable
                  columns={quarterlyColumns}
                  rows={quarterlyRows}
                  rowKey={(row) => row.key}
                  tableClassName="financial-table"
                  wrapClassName="financial-table-wrap"
                  pageSize={20}
                  minWidth={780}
                />
              ) : null}

              {!quarterlyModal.loading && !quarterlyModal.error && (quarterlyRows.length === 0 || quarterlyLabels.length === 0) ? (
                <div className="empty-state">
                  {quarterlyModal.data?.message || 'Quarterly metrics are not available for this stock.'}
                </div>
              ) : null}

              <div className="financial-modal-note">
                Source: {quarterlyModal.data?.source || '--'}
                {quarterlyModal.data?.sourceUrl ? (
                  <>
                    {' '}
                    | <a href={quarterlyModal.data.sourceUrl} target="_blank" rel="noreferrer">Open Source</a>
                  </>
                ) : null}
                {quarterlyModal.data?.updatedAt ? (
                  <> | Updated: {formatCalendarTimestamp(quarterlyModal.data.updatedAt)}</>
                ) : null}
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
