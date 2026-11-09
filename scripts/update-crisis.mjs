import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DAY = 86_400_000;
const USER_AGENT = 'Mozilla/5.0 (compatible; HorizonCrisis/1.0; public economic observations)';
const FRED = 'https://fred.stlouisfed.org/graph/fredgraph.csv';
const MULTPL = 'https://www.multpl.com';
export const MAX_AGE_DAYS = Object.freeze({ daily: 7, monthly: 75, quarterly: 160 });
const fredSource = (series) => ({ name: `FRED ${series}`, url: `${FRED}?id=${series}` });
const definitions = {};
function define(id, frequency, unit, source, kind = 'observed') {
  // Financial Accounts releases have a longer quarterly lag than most BEA/BLS series.
  definitions[id] = { frequency, unit, source, kind, maxAgeDays: id === 'CSUSHPINSA_YOY' ? 120 : id === 'CORP_DEBT_GDP' ? 180 : MAX_AGE_DAYS[frequency] };
}

const fredLevels = {
  DGS2: 'daily', DGS5: 'daily', DGS10: 'daily', DGS30: 'daily',
  T10Y2Y: 'daily', VIXCLS: 'daily', UNRATE: 'monthly', UMCSENT: 'monthly',
  DCCLACBS: 'quarterly', BAMLH0A0HYM2: 'daily', DFEDTARL: 'daily', DFEDTARU: 'daily',
};
// DCCLACBS is the public contract ID; FRED calls credit-card delinquency DRCCLACBS.
const fredAliases = { DCCLACBS: 'DRCCLACBS' };
for (const [id, frequency] of Object.entries(fredLevels)) {
  define(id, frequency, id === 'VIXCLS' || id === 'UMCSENT' ? 'index' : id === 'T10Y2Y' ? 'percentage points' : 'percent', fredSource(fredAliases[id] ?? id));
}
const fredYoy = {
  CPI_YOY: ['CPIAUCSL', 'monthly'],
  PCE_CORE_YOY: ['PCEPILFE', 'monthly'],
  CSUSHPINSA_YOY: ['CSUSHPINSA', 'monthly'],
  CORP_PROFIT_YOY: ['CP', 'quarterly'],
};
for (const [id, [series, frequency]] of Object.entries(fredYoy)) {
  define(id, frequency, 'percent YoY', fredSource(series), 'derived');
}
define('CORP_DEBT_GDP', 'quarterly', 'percent of annualized GDP', fredSource('BCNSDODNS'), 'derived');
define('CAPE', 'daily', 'ratio', { name: 'Multpl / Shiller CAPE', url: `${MULTPL}/shiller-pe/table/by-month` });
define('PE_TTM', 'daily', 'ratio (as-reported TTM; latest may be a source estimate)', { name: 'Multpl / Shiller as-reported TTM PE', url: `${MULTPL}/s-p-500-pe-ratio/table/by-month` });
define('EPS_TTM', 'quarterly', 'inflation-adjusted 12-month real EPS (source rebases to latest CPI; not nominal/operating EPS or consensus)', { name: 'Multpl / Shiller S&P 500 12-month real earnings', url: `${MULTPL}/s-p-500-earnings/table/by-year` });
define('CONCENTRATION', 'monthly', 'percent (S&P 500 top-10 weight)', { name: 'S&P Dow Jones Indices', url: 'https://www.spglobal.com/spdji/en/indices/equity/sp-500/' });

const markets = {
  SP500: { symbol: '^GSPC', stooq: '^spx', unit: 'index', fred: 'SP500' },
  NASDAQ: { symbol: '^IXIC', stooq: '^ndq', unit: 'index', fred: 'NASDAQCOM' },
  DXY: { symbol: 'DX-Y.NYB', stooq: 'dx.f', unit: 'index' },
  GOLD: { symbol: 'GC=F', stooq: 'xauusd', unit: 'USD per troy ounce', yahooKind: 'proxy', stooqKind: 'observed' },
  WTI: { symbol: 'CL=F', stooq: 'cl.f', unit: 'USD per barrel', yahooKind: 'proxy', stooqKind: 'proxy', fred: 'DCOILWTICO' },
  BTC: { symbol: 'BTC-USD', stooq: 'btcusd', unit: 'USD per BTC', fred: 'CBBTCUSD' },
};
for (const [id, market] of Object.entries(markets)) {
  const source = { name: `Yahoo Finance ${market.symbol}`, url: `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(market.symbol)}?range=2y&interval=1d` };
  define(id, 'daily', market.unit, source, market.yahooKind ?? 'observed');
  define(`${id}_YOY`, 'daily', 'percent 1Y price return (not total return)', source, 'derived');
}
export const METRIC_IDS = Object.freeze(Object.keys(definitions));
const fredFrequencies = {
  ...Object.fromEntries(Object.entries(fredLevels).map(([id, frequency]) => [fredAliases[id] ?? id, frequency])),
  ...Object.fromEntries(Object.values(fredYoy)), BCNSDODNS: 'quarterly', GDP: 'quarterly',
};
const CORE_METRIC_IDS = new Set([...Object.keys(fredLevels), ...Object.keys(fredYoy), 'CORP_DEBT_GDP', ...Object.keys(markets)]);

export function normalizeDate(input, now = new Date()) {
  if (typeof input !== 'string') throw new Error('Missing observation date');
  let date = input.trim();
  const quarter = /^(\d{4})-?Q([1-4])$/i.exec(date);
  if (quarter) date = `${quarter[1]}-${String((Number(quarter[2]) - 1) * 3 + 1).padStart(2, '0')}-01`;
  if (/^\d{4}-\d{2}$/.test(date)) date += '-01';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`Invalid observation date: ${input}`);
  const milliseconds = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== date) throw new Error(`Invalid calendar date: ${input}`);
  if (date > now.toISOString().slice(0, 10)) throw new Error(`Future observation date: ${input}`);
  return date;
}

// FRED uses period starts; the independent Multpl real-EPS table already uses ends.
// Never rewrite observationDate or age quarterly EPS as if it were a quarter start.
export function periodEnd(observationDate, frequency, now = new Date(), dateConvention = 'period-start') {
  const date = normalizeDate(observationDate, now);
  if (!Object.hasOwn(MAX_AGE_DAYS, frequency) || !['period-start', 'period-end'].includes(dateConvention)) throw new Error('Invalid reporting period settings');
  if (frequency === 'daily') return date;
  const [year, month, day] = date.split('-').map(Number);
  const endMonth = frequency === 'monthly' ? month : Math.ceil(month / 3) * 3;
  const end = new Date(Date.UTC(year, endMonth, 0)).toISOString().slice(0, 10);
  if (dateConvention === 'period-start') {
    if (day !== 1 || (frequency === 'quarterly' && (month - 1) % 3 !== 0)) throw new Error(`Expected ${frequency} period start: ${date}`);
  } else if (date !== end) throw new Error(`Expected ${frequency} period end: ${date}`);
  if (Date.parse(`${end}T00:00:00Z`) + DAY > now.getTime()) throw new Error(`Unfinished ${frequency} reporting period: ${date}`);
  return end;
}

export function observationAgeDays(end, now = new Date()) {
  return (now.getTime() - Date.parse(`${normalizeDate(end, now)}T00:00:00Z`)) / DAY;
}

export function checkFreshness(observationDate, frequency, now = new Date(), { maxAgeDays = MAX_AGE_DAYS[frequency], dateConvention = 'period-start' } = {}) {
  if (!Number.isFinite(maxAgeDays) || maxAgeDays <= 0) throw new Error('Invalid maxAgeDays');
  const end = periodEnd(observationDate, frequency, now, dateConvention);
  const ageDays = observationAgeDays(end, now);
  return { periodEnd: end, maxAgeDays, ageDays, status: ageDays > maxAgeDays ? 'stale' : 'ok' };
}

function metricFreshness(id, observationDate, now) {
  return checkFreshness(observationDate, definitions[id].frequency, now, {
    maxAgeDays: definitions[id].maxAgeDays, dateConvention: id === 'EPS_TTM' ? 'period-end' : 'period-start',
  });
}

function finiteNumber(text) {
  const value = String(text).trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) throw new Error(`Invalid numeric value: ${value.slice(0, 50)}`);
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error('Non-finite numeric value');
  return number;
}

export function parseCSV(text) {
  if (typeof text !== 'string' || !text.trim() || /^\s*</.test(text)) throw new Error('Expected CSV, received empty/HTML response');
  const rows = [];
  let row = [], field = '', quoted = false, closed = false;
  const body = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (quoted) {
      if (char === '"' && body[i + 1] === '"') { field += '"'; i++; }
      else if (char === '"') { quoted = false; closed = true; }
      else field += char;
    } else if (char === ',' || char === '\n') {
      row.push(field.trim()); field = ''; closed = false;
      if (char === '\n') { if (row.some((cell) => cell !== '')) rows.push(row); row = []; }
    } else if (char === '"' && field === '' && !closed) quoted = true;
    else {
      if (closed || char === '"') throw new Error('Malformed CSV quoting');
      field += char;
    }
  }
  if (quoted) throw new Error('Unterminated CSV quote');
  row.push(field.trim());
  if (row.some((cell) => cell !== '')) rows.push(row);
  if (rows.length < 2) throw new Error('CSV has no observations');
  const width = rows[0].length;
  if (rows.some((cells) => cells.length !== width)) throw new Error('CSV column count mismatch');
  return rows;
}

function sortedPoints(points) {
  if (!points.length) throw new Error('No numeric observations');
  const dates = new Set();
  for (const point of points) {
    if (dates.has(point.date)) throw new Error(`Duplicate observation date: ${point.date}`);
    dates.add(point.date);
  }
  return points.sort((a, b) => a.date.localeCompare(b.date));
}

export function parseFredCSV(text, series, now = new Date(), frequency = fredFrequencies[series] ?? 'daily') {
  const [header, ...rows] = parseCSV(text);
  const dateIndex = header.findIndex((value) => /^(observation_date|DATE)$/i.test(value));
  const valueIndex = header.indexOf(series);
  if (dateIndex < 0 || valueIndex < 0 || header.length !== 2 || dateIndex === valueIndex) throw new Error(`Unexpected FRED CSV header for ${series}`);
  const points = [];
  for (const row of rows) {
    const date = normalizeDate(row[dateIndex], now);
    if (row[valueIndex] === '.' || row[valueIndex] === '') continue;
    periodEnd(date, frequency, now);
    points.push({ date, value: finiteNumber(row[valueIndex]) });
  }
  return sortedPoints(points);
}

export function parseStooqCSV(text, now = new Date()) {
  const [header, ...rows] = parseCSV(text);
  if (header.join(',') !== 'Date,Open,High,Low,Close,Volume' && header.join(',') !== 'Date,Open,High,Low,Close') throw new Error('Unexpected Stooq CSV header');
  return sortedPoints(rows.flatMap((row) => {
    const date = normalizeDate(row[0], now);
    if (row[4] === '' || row[4] === 'N/D') return [];
    return [{ date, value: finiteNumber(row[4]) }];
  }));
}

function exchangeClock(instant, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant);
  const part = (type) => parts.find((entry) => entry.type === type)?.value;
  return { date: `${part('year')}-${part('month')}-${part('day')}`, minutes: Number(part('hour')) * 60 + Number(part('minute')) };
}

export function isYahooDailyClosed(date, symbol, timezone, now = new Date()) {
  normalizeDate(date, now);
  const local = exchangeClock(now, symbol === 'BTC-USD' ? 'UTC' : timezone);
  if (date < local.date) return true;
  // No invented holiday/early-close calendar. Equities wait past regular 16:00
  // exchange-local close plus 30 minutes; futures/DXY wait for a complete local day.
  return date === local.date && ['^GSPC', '^IXIC'].includes(symbol) && local.minutes >= 16 * 60 + 30;
}

export function parseYahooChart(payload, symbol, now = new Date()) {
  if (payload?.chart?.error) throw new Error(`Yahoo API error: ${payload.chart.error.code ?? 'unknown'} ${payload.chart.error.description ?? ''}`);
  const result = payload?.chart?.result?.[0];
  if (!result || result.meta?.symbol !== symbol || !Array.isArray(result.timestamp)) throw new Error('Unexpected Yahoo chart response/symbol');
  if (result.meta.dataGranularity && result.meta.dataGranularity !== '1d') throw new Error('Expected Yahoo daily bars');
  const closes = result.indicators?.quote?.[0]?.close;
  if (!Array.isArray(closes) || closes.length !== result.timestamp.length) throw new Error('Yahoo timestamp/close length mismatch');
  const timezone = symbol === 'BTC-USD' ? 'UTC' : result.meta?.exchangeTimezoneName;
  if (typeof timezone !== 'string') throw new Error('Yahoo exchange timezone missing');
  // Session opening timestamps are not evidence that the daily close is final.
  // Never substitute regularMarketPrice or an unfinished current daily candle.
  const points = result.timestamp.flatMap((timestamp, i) => {
    if (!Number.isFinite(timestamp) || timestamp <= 0 || timestamp * 1000 > now.getTime()) throw new Error('Invalid/future Yahoo timestamp');
    const date = normalizeDate(exchangeClock(new Date(timestamp * 1000), timezone).date, now);
    if (closes[i] === null) return [];
    if (typeof closes[i] !== 'number' || !Number.isFinite(closes[i])) throw new Error('Non-finite Yahoo close');
    if (!isYahooDailyClosed(date, symbol, timezone, now)) return [];
    return [{ date, value: closes[i] }];
  });
  return sortedPoints(points);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function stripHTML(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/&#(?:x[\da-f]+|\d+);|&(?:nbsp|thinsp|ensp|emsp);/gi, ' ').replace(/\s+/g, ' ').trim();
}
export function parseMultplTable(html, now = new Date()) {
  const table = /<table\b[^>]*\bid=["']datatable["'][^>]*>([\s\S]*?)<\/table>/i.exec(html)?.[1];
  if (!table) throw new Error('Multpl dated data table missing');
  for (const row of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)];
    if (cells.length !== 2) continue;
    const dateText = stripHTML(cells[0][1]);
    const match = /^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{1,2}), (\d{4})$/.exec(dateText);
    if (!match) throw new Error('Multpl date must include an explicit year');
    const date = normalizeDate(`${match[3]}-${String(MONTHS.indexOf(match[1]) + 1).padStart(2, '0')}-${match[2].padStart(2, '0')}`, now);
    const value = finiteNumber(stripHTML(cells[1][1]).replace(/†/g, '').trim());
    if (value <= 0) throw new Error('Multpl valuation must be positive');
    return { date, value, estimated: /Estimate|†/.test(cells[1][1]) };
  }
  throw new Error('Multpl has no dated numeric valuation');
}

function yearBefore(date) {
  const [year, month, day] = date.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year - 1, month, 0)).getUTCDate();
  return `${year - 1}-${String(month).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}
export function calculateYoY(points, frequency) {
  const latest = points.at(-1);
  if (!latest) throw new Error('No latest observation');
  const target = yearBefore(latest.date);
  const base = frequency === 'daily'
    ? points.filter((point) => point.date <= target).at(-1)
    : points.find((point) => point.date === target);
  if (!base || (frequency === 'daily' && (Date.parse(target) - Date.parse(base.date)) / DAY > 7)) throw new Error(`Missing exact 12-month baseline${frequency === 'daily' ? ' (previous trading day, maximum 7 days)' : ''}: ${target}`);
  if (!Number.isFinite(base.value) || base.value <= 0 || !Number.isFinite(latest.value)) throw new Error('Invalid/nonpositive YoY denominator or numerator');
  const value = (latest.value / base.value - 1) * 100;
  if (!Number.isFinite(value)) throw new Error('Non-finite YoY result');
  return { date: latest.date, value, inputs: [latest, base], target };
}

export function calculateDebtGDP(debt, gdp) {
  const denominator = new Map(gdp.map((point) => [point.date, point]));
  const latest = debt.filter((point) => denominator.has(point.date)).at(-1);
  if (!latest) throw new Error('No matching debt/GDP quarter');
  const base = denominator.get(latest.date);
  if (!Number.isFinite(latest.value) || latest.value < 0 || !Number.isFinite(base.value) || base.value <= 0) throw new Error('Invalid debt/GDP numerator or denominator');
  // BCNSDODNS: millions USD, quarter-end debt stock; GDP: billions USD, SAAR.
  const value = latest.value / 1000 / base.value * 100;
  if (!Number.isFinite(value)) throw new Error('Non-finite debt/GDP result');
  return { date: latest.date, value, inputs: [latest, base] };
}

export async function fetchText(url, { fetchImpl = globalThis.fetch, timeoutMs = 12_000, retries = 1 } = {}) {
  if (!url.startsWith('https://')) throw new Error('Only HTTPS sources are allowed');
  if (!Number.isInteger(retries) || retries < 0 || retries > 2 || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error('Invalid bounded fetch settings');
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': USER_AGENT, Accept: 'text/csv,application/json,text/html;q=0.8' } });
      if (!response.ok) {
        await response.body?.cancel();
        const error = new Error(`HTTP ${response.status}`);
        error.noRetry = response.status !== 429 && response.status < 500;
        throw error;
      }
      const text = await response.text();
      if (!text.trim()) { const error = new Error('Empty source response'); error.noRetry = true; throw error; }
      return text;
    } catch (error) {
      if (error.noRetry || attempt === retries) throw error;
    }
  }
}

export async function mapLimit(items, limit, callback) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 4) throw new Error('Concurrency must be between 1 and 4');
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(items.length, limit) }, async () => {
    while (index < items.length) { const current = index++; await callback(items[current], current); }
  }));
}

function isoUTC(value, now) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z')
    && Date.parse(value) <= now.getTime();
}
function validateMetric(metric, now, id) {
  if (!metric || !['daily', 'monthly', 'quarterly'].includes(metric.frequency) || typeof metric.unit !== 'string' || !metric.unit
    || !['ok', 'stale', 'unavailable', 'error'].includes(metric.status) || !['observed', 'derived', 'proxy', 'assumption'].includes(metric.kind)
    || typeof metric.source?.name !== 'string' || !metric.source.name || typeof metric.source.url !== 'string' || !/^https:\/\//.test(metric.source.url)) throw new Error('Invalid metric metadata');
  new URL(metric.source.url);
  if (id && metric.frequency !== definitions[id].frequency) throw new Error('Incompatible metric frequency');
  if (metric.maxAgeDays !== undefined && metric.maxAgeDays !== (id ? definitions[id].maxAgeDays : MAX_AGE_DAYS[metric.frequency])) throw new Error('Inconsistent maxAgeDays');
  if (metric.value === null) {
    // No source observation means no honest date. Never stamp missing data with today.
    if (metric.observationDate !== null || metric.fetchedAt !== null || !['unavailable', 'error'].includes(metric.status) || !metric.error) throw new Error('Invalid missing metric');
  } else {
    if (typeof metric.value !== 'number' || !Number.isFinite(metric.value) || metric.status === 'unavailable') throw new Error('Invalid metric value');
    normalizeDate(metric.observationDate, now);
    if (!isoUTC(metric.fetchedAt, now) || metric.observationDate > metric.fetchedAt.slice(0, 10)) throw new Error('Invalid fetchedAt');
    const freshness = id ? metricFreshness(id, metric.observationDate, new Date(metric.fetchedAt))
      : checkFreshness(metric.observationDate, metric.frequency, new Date(metric.fetchedAt));
    if (metric.periodEnd !== undefined && metric.periodEnd !== freshness.periodEnd) throw new Error('Inconsistent periodEnd');
    if (metric.status === 'error' && !metric.error) throw new Error('Retained metric requires failure reason');
  }
  if (metric.value === null && metric.periodEnd !== undefined && metric.periodEnd !== null) throw new Error('Missing metric has periodEnd');
  if (metric.kind === 'derived' && metric.value !== null && (!Array.isArray(metric.inputs) || metric.inputs.length < 2)) throw new Error('Derived metric inputs missing');
  if (metric.inputs !== undefined && !Array.isArray(metric.inputs)) throw new Error('Invalid inputs');
  for (const input of metric.inputs ?? []) {
    if (typeof input.value !== 'number' || !Number.isFinite(input.value) || !input.source?.name || !/^https:\/\//.test(input.source.url)) throw new Error('Invalid derivation input');
    normalizeDate(input.observationDate, now);
    if (!isoUTC(input.fetchedAt, now) || input.observationDate > input.fetchedAt.slice(0, 10)) throw new Error('Invalid input fetchedAt');
    if (id) metricFreshness(id, input.observationDate, new Date(input.fetchedAt));
  }
}

export function freshMetricIds(snapshot) {
  const at = new Date(snapshot.generatedAt);
  return METRIC_IDS.filter((id) => {
    const metric = snapshot.metrics[id];
    return metric?.status === 'ok' && metric.value !== null && metric.kind !== 'assumption'
      && (!snapshot.collectionStartedAt || Date.parse(metric.fetchedAt) >= Date.parse(snapshot.collectionStartedAt))
      && isoUTC(metric.fetchedAt, at) && metricFreshness(id, metric.observationDate, at).status === 'ok';
  });
}

function snapshotRunStatus(snapshot) {
  const fresh = freshMetricIds(snapshot);
  if (!fresh.some((id) => CORE_METRIC_IDS.has(id))) return 'failed';
  return fresh.length === METRIC_IDS.length ? 'ok' : 'partial';
}

export function validateSnapshot(snapshot, now = new Date()) {
  if (snapshot?.schemaVersion !== 1 || !isoUTC(snapshot.generatedAt, now) || !['ok', 'partial', 'failed'].includes(snapshot.runStatus)
    || !Array.isArray(snapshot.errors) || (snapshot.lastSuccessfulAt !== null && !isoUTC(snapshot.lastSuccessfulAt, now))) throw new Error('Invalid snapshot envelope');
  if (snapshot.lastSuccessfulAt !== null && Date.parse(snapshot.lastSuccessfulAt) > Date.parse(snapshot.generatedAt)) throw new Error('lastSuccessfulAt exceeds generatedAt');
  const generated = new Date(snapshot.generatedAt);
  if (snapshot.collectionStartedAt !== undefined && !isoUTC(snapshot.collectionStartedAt, generated)) throw new Error('Invalid collectionStartedAt');
  if (!snapshot.metrics || Object.keys(snapshot.metrics).length !== METRIC_IDS.length) throw new Error('Incomplete metric coverage');
  for (const id of METRIC_IDS) {
    const metric = snapshot.metrics[id];
    validateMetric(metric, generated, id);
    if (['ok', 'stale'].includes(metric.status)) {
      if (metric.kind === 'assumption' || metricFreshness(id, metric.observationDate, generated).status !== metric.status) throw new Error('Metric status disagrees with freshness');
      if (snapshot.collectionStartedAt && Date.parse(metric.fetchedAt) < Date.parse(snapshot.collectionStartedAt)) throw new Error('Retrieved metric predates this collection');
    }
  }
  if (snapshot.runStatus !== snapshotRunStatus(snapshot)) throw new Error('runStatus disagrees with fresh metric coverage');
  if (snapshot.runStatus !== 'failed' && Date.parse(snapshot.lastSuccessfulAt) !== generated.getTime()) throw new Error('Successful collection timestamp missing');
  if (snapshot.runStatus === 'failed' && snapshot.lastSuccessfulAt !== null
    && Date.parse(snapshot.lastSuccessfulAt) >= Date.parse(snapshot.collectionStartedAt ?? snapshot.generatedAt)) throw new Error('Failed collection cannot advance lastSuccessfulAt');
  if (snapshot.runStatus !== 'ok' && !snapshot.errors.length) throw new Error('Incomplete collection requires warnings');
  return snapshot;
}

export async function collectCrisis({ previous = null, now = () => new Date(), fetchImpl = globalThis.fetch, concurrency = 4, timeoutMs = 12_000, retries = 1 } = {}) {
  const metrics = {}, errors = [];
  const collectionStartedAt = now().toISOString();
  const request = (url) => fetchText(url, { fetchImpl, timeoutMs, retries });
  const input = (point, series) => ({ value: point.value, observationDate: point.date, fetchedAt: series.fetchedAt, source: series.source });
  const fail = (id, message, retain = true) => {
    errors.push({ metric: id, message });
    const old = retain && previous?.schemaVersion === 1 ? previous.metrics?.[id] : null;
    try {
      validateMetric(old, now(), id);
      // Never retain legacy price/PE-implied EPS under the independent real-EPS contract.
      if (id === 'EPS_TTM' && (old.kind !== definitions[id].kind || old.frequency !== definitions[id].frequency
        || old.unit !== definitions[id].unit || old.source.name !== definitions[id].source.name || old.source.url !== definitions[id].source.url)) throw new Error('Incompatible previous EPS source/definition');
      if (old.value !== null && old.kind !== 'assumption') { metrics[id] = { ...old, status: 'error', error: message }; return; }
    } catch { /* Invalid previous data is never used as a fallback. */ }
    metrics[id] = { ...definitions[id], value: null, observationDate: null, periodEnd: null, fetchedAt: null, status: 'unavailable', error: message };
  };
  const save = (id, point, series, inputs) => {
    const freshness = metricFreshness(id, point.date, now());
    const metric = { ...definitions[id], value: point.value, observationDate: point.date, periodEnd: freshness.periodEnd, fetchedAt: series.fetchedAt,
      status: freshness.status, source: series.source, kind: series.kind ?? definitions[id].kind,
      ...(series.closePolicy ? { closePolicy: series.closePolicy } : {}), ...(inputs ? { inputs } : {}) };
    validateMetric(metric, now(), id);
    metrics[id] = metric;
  };
  const getFred = async (series, years = 3) => {
    const start = `${now().getUTCFullYear() - years}-01-01`;
    const url = `${FRED}?id=${series}&cosd=${start}`;
    const text = await request(url);
    return { points: parseFredCSV(text, series, now()), source: { name: `FRED ${series}${series === 'CP' ? ' / BEA all-US corporate profits (not S&P 500 earnings)' : ''}`, url }, fetchedAt: now().toISOString() };
  };
  const tasks = [];
  for (const id of Object.keys(fredLevels)) tasks.push(async () => {
    try { const series = await getFred(fredAliases[id] ?? id); save(id, series.points.at(-1), series); }
    catch (error) { fail(id, error.message); }
  });
  for (const [id, [name, frequency]] of Object.entries(fredYoy)) tasks.push(async () => {
    try {
      const series = await getFred(name);
      const result = calculateYoY(series.points, frequency);
      save(id, result, series, result.inputs.map((point) => input(point, series)));
    } catch (error) { fail(id, error.message); }
  });
  tasks.push(async () => {
    try {
      // Sequential inside each task keeps total request concurrency <= concurrency.
      const debt = await getFred('BCNSDODNS');
      const gdp = await getFred('GDP');
      const result = calculateDebtGDP(debt.points, gdp.points);
      save('CORP_DEBT_GDP', result, { source: { name: 'FRED debt securities/loans (millions) / GDP (billions, SAAR)', url: `${FRED}?id=BCNSDODNS,GDP` }, fetchedAt: gdp.fetchedAt },
        [input(result.inputs[0], debt), input(result.inputs[1], gdp)]);
    } catch (error) { fail('CORP_DEBT_GDP', error.message); }
  });
  for (const id of ['CAPE', 'PE_TTM', 'EPS_TTM']) tasks.push(async () => {
    try {
      const source = definitions[id].source;
      const point = parseMultplTable(await request(source.url), now());
      if (id === 'EPS_TTM' && point.estimated) throw new Error('Real EPS requires an observed source row, not an estimate');
      save(id, point, { source, fetchedAt: now().toISOString(), kind: point.estimated ? 'proxy' : 'observed' });
    } catch (error) { fail(id, error.message); }
  });
  for (const [id, market] of Object.entries(markets)) tasks.push(async () => {
    const failures = [];
    const candidates = ['query1', 'query2'].map((host) => ({ name: host, load: async () => {
      const url = `https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(market.symbol)}?range=2y&interval=1d`;
      const text = await request(url);
      const closePolicy = market.symbol === 'BTC-USD' ? 'Completed UTC days only; current BTC daily candle excluded'
        : ['^GSPC', '^IXIC'].includes(market.symbol) ? 'Exchange-local 16:00 close plus 30-minute margin; no inferred market calendar'
          : 'Prior complete exchange-local day only; futures/DXY intentionally delayed to exclude unfinished sessions';
      return { points: parseYahooChart(JSON.parse(text), market.symbol, now()), source: { name: `Yahoo Finance ${market.symbol}${market.yahooKind === 'proxy' ? ' front-month futures (not spot)' : ''}`, url }, fetchedAt: now().toISOString(), kind: market.yahooKind ?? 'observed', closePolicy };
    } }));
    candidates.push({ name: 'Stooq', load: async () => {
      const end = now().toISOString().slice(0, 10).replaceAll('-', '');
      const start = `${now().getUTCFullYear() - 2}0101`;
      const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(market.stooq)}&i=d&d1=${start}&d2=${end}`;
      const text = await request(url);
      return { points: parseStooqCSV(text, now()), source: { name: `Stooq ${market.stooq}${market.stooq.endsWith('.f') ? ' futures proxy' : ''}`, url }, fetchedAt: now().toISOString(), kind: market.stooqKind ?? (market.stooq.endsWith('.f') ? 'proxy' : 'observed') };
    } });
    if (market.fred) candidates.push({ name: `FRED ${market.fred}`, load: async () => ({ ...await getFred(market.fred), kind: 'observed' }) });
    let best;
    // Bounded, sequential per-market fallback stays inside the global concurrency cap.
    for (const candidate of candidates.slice(0, 8)) {
      try {
        const series = await candidate.load();
        const latest = series.points.at(-1);
        const fresh = metricFreshness(id, latest.date, now()).status === 'ok';
        let result, yoyError;
        try { result = calculateYoY(series.points, 'daily'); }
        catch (error) { yoyError = error.message; }
        // Fresh level outranks any stale complete return. Within freshness, prefer
        // a complete same-source return, then the more recent source observation.
        const rank = (fresh ? 2 : 0) + (result ? 1 : 0);
        if (!best || rank > best.rank || (rank === best.rank && latest.date > best.latest.date)) best = { series, latest, result, yoyError, rank };
        if (fresh && result) break;
        failures.push(`${candidate.name}: ${!fresh ? `stale observation ${latest.date}` : yoyError}`);
      } catch (error) { failures.push(`${candidate.name}: ${error.message}`); }
    }
    if (!best) { fail(id, failures.join('; ')); fail(`${id}_YOY`, failures.join('; ')); return; }
    const { series, latest, result, yoyError } = best;
    try { save(id, latest, series); }
    catch (error) { fail(id, error.message); fail(`${id}_YOY`, error.message); return; }
    if (!result) { fail(`${id}_YOY`, `${yoyError}; fallbacks: ${failures.join('; ')}`, false); return; }
    try { save(`${id}_YOY`, result, { ...series, kind: 'derived' }, result.inputs.map((point) => input(point, series))); }
    catch (error) { fail(`${id}_YOY`, error.message, false); }
  });
  await mapLimit(tasks, concurrency, (task) => task());
  fail('CONCENTRATION', 'No reliable dated machine-readable top-10 index weight source configured; no static assumption substituted');
  const generatedAt = now().toISOString();
  for (const [id, metric] of Object.entries(metrics)) {
    if (!['ok', 'stale'].includes(metric.status)) continue;
    const freshness = metricFreshness(id, metric.observationDate, new Date(generatedAt));
    metric.status = freshness.status;
    if (metric.status === 'stale') errors.push({ metric: id, message: `Source period end ${freshness.periodEnd} is ${Math.floor(freshness.ageDays)} days old (threshold ${freshness.maxAgeDays} days)` });
  }
  const snapshot = { schemaVersion: 1, collectionStartedAt, generatedAt,
    metrics: Object.fromEntries(METRIC_IDS.map((id) => [id, metrics[id]])), errors };
  snapshot.runStatus = snapshotRunStatus(snapshot);
  snapshot.lastSuccessfulAt = snapshot.runStatus !== 'failed' ? generatedAt
    : isoUTC(previous?.lastSuccessfulAt, new Date(collectionStartedAt)) && Date.parse(previous.lastSuccessfulAt) < Date.parse(collectionStartedAt) ? previous.lastSuccessfulAt : null;
  return validateSnapshot(snapshot, now());
}

export function summarizeSnapshot(snapshot) {
  const counts = { ok: 0, stale: 0, unavailable: 0, error: 0 };
  for (const metric of Object.values(snapshot.metrics)) counts[metric.status]++;
  const fresh = freshMetricIds(snapshot).length;
  return { runStatus: snapshot.runStatus, generatedAt: snapshot.generatedAt, lastSuccessfulAt: snapshot.lastSuccessfulAt,
    fresh, retrieved: fresh, failed: counts.unavailable + counts.error, counts,
    observations: Object.fromEntries(Object.entries(snapshot.metrics).map(([id, metric]) => [id, { value: metric.value, date: metric.observationDate, periodEnd: metric.periodEnd ?? null, maxAgeDays: metric.maxAgeDays ?? definitions[id].maxAgeDays, status: metric.status, source: metric.source.name }])) };
}

async function main() {
  const output = fileURLToPath(new URL('../data/crisis-daily.json', import.meta.url));
  let previous = null;
  try { previous = JSON.parse(await readFile(output, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new Error(`Cannot read previous snapshot: ${error.message}`); }
  const snapshot = await collectCrisis({ previous });
  // The data directory is deliberately not created by this runtime script.
  await writeFile(output, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(summarizeSnapshot(snapshot), null, 2));
  if (snapshot.runStatus !== 'ok') {
    console.error(`${process.env.GITHUB_ACTIONS ? '::warning::' : ''}Crisis collection ${snapshot.runStatus}: ${snapshot.errors.map((error) => `${error.metric}: ${error.message}`).join(' | ')}`);
  }
  if (snapshot.runStatus === 'failed') process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`Crisis collector failed: ${error.message}`); process.exitCode = 1; });
}
