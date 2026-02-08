const EXCHANGE_SUFFIX_MAP = {
  NSE: '.NS',
  NS: '.NS',
  BSE: '.BO',
  BO: '.BO',
};

function extractScreenerCompanyCode(input) {
  const match = String(input || '').match(/screener\.in\/company\/(\d{5,6})/i);
  return match ? match[1] : '';
}

function normalizeIndianSymbol(input) {
  if (!input || typeof input !== 'string') {
    return '';
  }

  const screenerCode = extractScreenerCompanyCode(input);
  const normalizedInput = screenerCode || input;

  const trimmed = normalizedInput.trim().toUpperCase().replace(/\s+/g, '');
  if (!trimmed) {
    return '';
  }

  const match = trimmed.match(/^([A-Z0-9\-_.]+?)(?:\.(NSE|NS|BSE|BO))?$/);
  if (!match) {
    return trimmed;
  }

  const [, symbolPart, exchangePart] = match;
  const base = symbolPart.replace(/\.(NS|BO)$/i, '');
  if (!exchangePart) {
    // 6-digit numeric symbols are typically BSE scrip codes (use .BO).
    if (/^\d{5,6}$/.test(base)) {
      return `${base}.BO`;
    }
    return `${base}.NS`;
  }

  // If a numeric scrip code is explicitly passed with NSE suffix, remap to BSE.
  if (/^\d{5,6}$/.test(base) && (exchangePart === 'NSE' || exchangePart === 'NS')) {
    return `${base}.BO`;
  }

  return `${base}${EXCHANGE_SUFFIX_MAP[exchangePart]}`;
}

function toDisplaySymbol(symbol) {
  if (!symbol) {
    return '';
  }

  return symbol
    .toUpperCase()
    .replace(/\.NS$/, ' (NSE)')
    .replace(/\.BO$/, ' (BSE)');
}

function stripExchangeSuffix(symbol) {
  return symbol.toUpperCase().replace(/\.(NS|BO)$/, '');
}

module.exports = {
  normalizeIndianSymbol,
  toDisplaySymbol,
  stripExchangeSuffix,
};
