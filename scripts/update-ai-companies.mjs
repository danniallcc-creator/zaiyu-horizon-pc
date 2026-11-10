import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Public, as-reported consolidated financials are company proxies, NOT AI revenue,
// orders, deployment, prices or AI-attributable margins. No inferred AI evidence.
export const COMPANIES = [
  { id: 'NVDA', name: '英伟达', role: 'designer', cik: 1045810 },
  { id: 'AMD', name: '超威半导体（AMD）', role: 'designer', cik: 2488 },
  { id: 'TSM', name: '台积电', role: 'foundry', cik: 1046179 },
  { id: 'SAMSUNG', name: '三星', role: 'memory', ir: 'https://www.samsung.com/global/ir/financial-information/earnings-release/' },
  { id: 'SKHYNIX', name: 'SK海力士', role: 'memory', ir: 'https://news.skhynix.com/' },
  { id: 'MU', name: '美光', role: 'memory', cik: 723125 },
  { id: 'MSFT', name: '微软', role: 'buyer', cik: 789019 },
  { id: 'AMZN', name: '亚马逊', role: 'buyer', cik: 1018724 },
  { id: 'GOOG', name: '谷歌', role: 'buyer', cik: 1652044 },
  { id: 'META', name: 'Meta', role: 'buyer', cik: 1326801 },
];
export const METRIC_KEYS = ['revenue', 'costOfRevenue', 'grossMargin', 'inventory', 'capex', 'operatingCashFlow'];
export const MAX_QUARTER_AGE_DAYS = 200;
const DAY = 86_400_000;
const TAGS = {
  revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet'],
  costOfRevenue: ['CostOfRevenue', 'CostOfGoodsAndServicesSold'],
  grossProfit: ['GrossProfit'],
  inventory: ['InventoryNet'],
  capex: ['PaymentsToAcquirePropertyPlantAndEquipment'],
  operatingCashFlow: ['NetCashProvidedByUsedInOperatingActivities'],
  // Productive assets may include intangibles: never silently relabel as PPE.
  capitalInvestmentIncludingIntangibles: ['PaymentsToAcquireProductiveAssets'],
};
const NOTICE = '集团as-reported财务仅为company proxy，非AI收入、订单或归因毛利；未披露不等于零。';
export const secURL = (cik) => `https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, '0')}.json`;
export const filingURL = (cik, accession) => `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replaceAll('-', '')}/${accession}-index.html`;
const sourceFor = (company) => ({ name: company.cik ? 'SEC Company Facts / company proxy' : 'Official IR / disclosure only', url: company.cik ? secURL(company.cik) : company.ir });
function assert(condition, message) { if (!condition) throw new Error(message); }
export function validDate(value, now = new Date()) {
  assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), 'Invalid date');
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  assert(Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value, 'Impossible date');
  assert(value <= now.toISOString().slice(0, 10), 'Future date');
  return value;
}
function validTimestamp(value, now) {
  assert(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value), 'Expected ISO UTC timestamp');
  const date = new Date(value);
  assert(Number.isFinite(date.getTime()) && date.getTime() <= now.getTime(), 'Invalid/future timestamp');
  validDate(value.slice(0, 10), now);
  assert(date.toISOString().slice(0, 10) === value.slice(0, 10) && Number(value.slice(11, 13)) < 24 && Number(value.slice(14, 16)) < 60 && Number(value.slice(17, 19)) < 60, 'Impossible timestamp');
  return value;
}
function validStamp(value, now) {
  // Date-only disclosures/reviews mean UTC midnight, never an invented time.
  if (typeof value === 'string' && value.length === 10) validDate(value, now);
  else validTimestamp(value, now);
  return Date.parse(value);
}
function validSource(source) {
  assert(source && typeof source.name === 'string' && source.name.trim(), 'Source name required');
  assert(typeof source.url === 'string' && !/[\u0000-\u0020\u007f]/.test(source.url), 'Source URL string required');
  const url = new URL(source.url);
  assert(url.protocol === 'https:' && !url.username && !url.password, 'Source must be credential-free HTTPS');
  return source;
}
const duration = (start, end) => (Date.parse(end) - Date.parse(start)) / DAY + 1;
const nextDay = (date) => new Date(Date.parse(date) + DAY).toISOString().slice(0, 10);
const isQuarter = (start, end) => duration(start, end) >= 80 && duration(start, end) <= 105;
function isEvidenceQuarter(start, end) {
  const first = new Date(`${start}T00:00:00Z`);
  const canonicalEnd = Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 3, first.getUTCDate()) - DAY;
  return duration(start, end) >= 75 && duration(start, end) <= 105 && Math.abs(Date.parse(end) - canonicalEnd) <= 15 * DAY;
}
const ORIGINAL_SOURCE_BASIS = 'original_period_disclosure_not_automatically_restated';
const periodKey = (row) => `${row.start}/${row.end}`;
const sameBasis = (a, b) => a.tag === b.tag && a.currency === b.currency && a.fiscalYear === b.fiscalYear && a.start === b.start;

export async function fetchPublic(url, { fetchImpl = fetch, timeoutMs = 20_000 } = {}) {
  validSource({ name: 'Public source', url });
  assert(Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 60_000, 'Invalid timeout');
  assert(fetchImpl !== fetch || process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0', 'TLS verification disabled by environment; public collection refused');
  // One request per source. In particular, never retry WAF/403 responses.
  const response = await fetchImpl(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'ZaiyuHorizonPublicFinancialMonitor/1.0 contact horizon-monitor@users.noreply.github.com', Accept: 'application/json,text/html;q=0.5' },
  });
  assert(response.ok, `HTTP ${response.status}`);
  validSource({ name: 'Redirect destination', url: response.url || url });
  const text = await response.text();
  assert(text.trim(), 'Empty response');
  return text;
}

// Keep the latest original-period filing per period. When a 10-Q/A amendment
// restates a quarter, the restated value is consistent with subsequent YTD
// figures that reference it. The 150-day window above already rejects
// later-year comparatives, so within the window the latest filing is the
// most current authoritative statement.
function reportedFacts(payload, company, tag, currency, now, instant = false) {
  const rows = payload.facts?.['us-gaap']?.[tag]?.units?.[currency] || [];
  const selected = new Map();
  const filingCount = new Map();
  for (const row of rows) {
    try {
      validDate(row.end, now); validDate(row.filed, now);
      assert(row.filed > row.end, 'Filed before complete period-end day');
      assert(Number.isFinite(row.val) && Number.isInteger(row.fy), 'Invalid fact/year');
      assert(/^\d{10}-\d{2}-\d{6}$/.test(row.accn), 'Missing accession');
      assert(['10-Q', '10-K', '10-Q/A', '10-K/A'].includes(row.form), 'Unsupported quarterly filing');
      // Original 10-Q/10-K reporting windows; not a statement of freshness.
      assert(duration(row.end, row.filed) <= 150, 'Later comparative, not original period');
      if (!instant) { validDate(row.start, now); assert(row.start <= row.end, 'Invalid period'); }
      if (row.frame) {
        const calendar = /^CY(\d{4})(?:Q([1-4])(I)?)?$/.exec(row.frame);
        assert(calendar, 'Unsupported SEC calendar frame');
        const calendarEnd = Date.UTC(Number(calendar[1]), calendar[2] ? Number(calendar[2]) * 3 : 12, 0);
        // SEC frames allow non-calendar fiscal quarters (e.g. NVIDIA). Their
        // actual dates remain authoritative; fp is never a calendar quarter.
        assert(Math.abs(Date.parse(row.end) - calendarEnd) <= 35 * DAY, 'Calendar frame/period mismatch');
        if (!instant) assert(calendar[2] ? isQuarter(row.start, row.end) : duration(row.start, row.end) >= 350 && duration(row.start, row.end) <= 380, 'Calendar frame duration mismatch');
      }
      const fact = {
        value: row.val, start: instant ? row.end : row.start, end: row.end,
        filed: row.filed, accession: row.accn, fiscalYear: row.fy,
        fiscalPeriod: row.fp, form: row.form, tag: `us-gaap:${tag}`, currency,
        ...(row.frame ? { frame: row.frame } : {}),
        source: { name: 'SEC filed XBRL / company proxy', url: filingURL(company.cik, row.accn) },
      };
      const key = instant ? row.end : periodKey(fact);
      const old = selected.get(key);
      filingCount.set(key, (filingCount.get(key) || 0) + 1);
      // Latest filing wins: amendments restate the period and are consistent
      // with YTD figures in subsequent reports that reference them.
      if (!old || fact.filed > old.filed || (fact.filed === old.filed && fact.accession > old.accession)) selected.set(key, fact);
    } catch { /* Invalid or non-original facts do not become observations. */ }
  }
  return [...selected.entries()].map(([key, fact]) => filingCount.get(key) > 1 ? { ...fact, restated: true } : fact)
    .sort((a, b) => a.end.localeCompare(b.end) || a.start.localeCompare(b.start));
}

export function quarterize(rows) {
  const direct = rows.filter((row) => isQuarter(row.start, row.end));
  const output = new Map(direct.map((row) => [periodKey(row), { ...row, kind: 'observed' }]));
  // Require explicit Q1 -> 6m -> 9m -> annual declarations on the SAME tag,
  // unit, fiscal year and fiscal-year start. Never subtract across a data gap.
  for (const current of rows) {
    const days = duration(current.start, current.end);
    const stage = days >= 170 && days <= 210 ? 2 : days >= 250 && days <= 305 ? 3 : days >= 350 && days <= 380 && current.form.startsWith('10-K') ? 4 : 0;
    if (!stage) continue;
    const chain = [current];
    let cursor = current;
    for (let step = stage - 1; step >= 1; step--) {
      const candidates = rows.filter((base) => sameBasis(base, current) && base.end < cursor.end && base.filed <= cursor.filed
        && isQuarter(nextDay(base.end), cursor.end)
        && (step === 1 ? isQuarter(base.start, base.end) : step === 2 ? duration(base.start, base.end) >= 170 && duration(base.start, base.end) <= 210 : duration(base.start, base.end) >= 250 && duration(base.start, base.end) <= 305));
      if (candidates.length !== 1) break;
      cursor = candidates[0]; chain.push(cursor);
    }
    if (chain.length !== stage) continue;
    const base = chain[1];
    const derived = { ...current, start: nextDay(base.end), value: current.value - base.value, kind: 'derived', inputs: chain, fiscalYearStart: current.start };
    if (!Number.isFinite(derived.value) || !isQuarter(derived.start, derived.end)) continue;
    if (!output.has(periodKey(derived))) output.set(periodKey(derived), derived);
  }
  return [...output.values()].sort((a, b) => a.end.localeCompare(b.end));
}
function metricFrom(fact, status = 'ok') {
  return {
    value: fact.value, unit: fact.currency, currency: fact.currency,
    kind: fact.kind || 'observed', scope: 'company', status, source: fact.source, tag: fact.tag,
    period: { start: fact.start, end: fact.end }, filed: fact.filed, accession: fact.accession, fiscalYear: fact.fiscalYear,
    ...(fact.inputs ? { inputs: fact.inputs } : {}),
    ...(fact.restated ? { restated: true } : {}),
  };
}
function missingMetric(key, source, currency = 'USD') {
  return { value: null, unit: key === 'grossMargin' ? '%' : currency, currency, kind: key === 'grossMargin' ? 'derived' : 'observed', scope: 'company', status: 'unavailable', source, tag: (TAGS[key] || ['grossMargin']).map((tag) => `us-gaap:${tag}`).join('|') };
}
function seriesFor(payload, company, key, now) {
  const combined = new Map();
  for (const tag of TAGS[key]) {
    const rows = reportedFacts(payload, company, tag, 'USD', now, key === 'inventory');
    for (const row of key === 'inventory' ? rows : quarterize(rows)) {
      const index = key === 'inventory' ? row.end : periodKey(row);
      const old = combined.get(index);
      if (!old || (old.kind === 'derived' && row.kind !== 'derived')) combined.set(index, row);
    }
  }
  return combined;
}
export function contiguousQuarterCount(quarters) {
  let count = quarters.length ? 1 : 0;
  for (let i = quarters.length - 1; i > 0; i--) {
    if (nextDay(quarters[i - 1].end) !== quarters[i].start) break;
    count++;
  }
  return count;
}
function singleSource(company, reason = '精确的独立季度解析不可用；SEC API与SEC filing属于同一来源。') {
  return { status: 'unavailable', reason: `unverified_single_source: ${reason}`, ...(company.cik ? { source: { name: 'Stock Analysis quarterly / independent (not verified)', url: `https://stockanalysis.com/stocks/${company.id.toLowerCase()}/financials/?p=quarterly` } } : {}) };
}
function emptyCompany(company, status = 'unavailable', reason = NOTICE) {
  return { id: company.id, name: company.name, role: company.role, status, fetchedAt: null, source: sourceFor(company), quarters: [], crossCheck: singleSource(company), reason };
}
export function parseCompanyFacts(payload, company, now = new Date()) {
  assert(Number(payload.cik) === company.cik && payload.facts && typeof payload.facts === 'object', 'SEC CIK/facts mismatch');
  if (company.id === 'TSM') {
    // Current machine-readable quarterly IFRS statements are not available from
    // this feed. Do not pass a 20-F annual statement to a quarterly frontend.
    const annual = (payload.facts['ifrs-full']?.Revenue?.units?.TWD || []).filter((row) => {
      try { validDate(row.start, now); validDate(row.end, now); validDate(row.filed, now); return row.form === '20-F' && row.filed >= row.end && duration(row.start, row.end) >= 350 && duration(row.start, row.end) <= 380 && Number.isFinite(row.val); } catch { return false; }
    }).sort((a, b) => a.end.localeCompare(b.end));
    return { ...emptyCompany(company, annual.length ? 'stale' : 'unavailable', `${NOTICE} SEC IFRS仅有年度披露${annual.length ? `（最新年度结束${annual.at(-1).end}）` : ''}；没有可核验的当前机器季度，年报不充当季度。`), fetchedAt: now.toISOString() };
  }
  const series = Object.fromEntries(Object.keys(TAGS).map((key) => [key, seriesFor(payload, company, key, now)]));
  const revenues = [...series.revenue.values()].sort((a, b) => a.end.localeCompare(b.end)).slice(-8);
  const quarters = revenues.map((revenue) => {
    const key = periodKey(revenue), stale = (now.getTime() - Date.parse(revenue.end)) / DAY > MAX_QUARTER_AGE_DAYS;
    const status = stale ? 'stale' : 'ok';
    const metrics = Object.fromEntries(METRIC_KEYS.map((name) => [name, missingMetric(name, sourceFor(company))]));
    metrics.revenue = metricFrom(revenue, status);
    for (const name of ['costOfRevenue', 'capex', 'operatingCashFlow', 'capitalInvestmentIncludingIntangibles']) {
      const fact = series[name].get(key);
      if (fact && fact.currency === revenue.currency && fact.fiscalYear === revenue.fiscalYear) metrics[name] = metricFrom(fact, status);
    }
    const inventory = series.inventory.get(revenue.end);
    if (inventory && inventory.currency === revenue.currency) metrics.inventory = metricFrom(inventory, status);
    const cost = metrics.costOfRevenue;
    if (revenue.value > 0 && cost.value !== null) {
      const grossProfit = series.grossProfit.get(key);
      const inputs = [revenue, series.costOfRevenue.get(key)];
      let marginStatus = status;
      if (grossProfit && grossProfit.currency === revenue.currency && grossProfit.fiscalYear === revenue.fiscalYear) {
        inputs.push(grossProfit);
        // Filed gross profit is a validation input, not an independent source.
        if (Math.abs(grossProfit.value - (revenue.value - cost.value)) > Math.max(1, revenue.value * 0.00001)) marginStatus = 'error';
      }
      const latestInput = inputs.reduce((a, b) => a.filed >= b.filed ? a : b);
      metrics.grossMargin = { ...metricFrom({ ...latestInput, start: revenue.start, end: revenue.end, value: (revenue.value - cost.value) / revenue.value * 100, kind: 'derived', tag: 'derived:(revenue-costOfRevenue)/revenue', inputs }, marginStatus), unit: '%' };
    }
    return { start: revenue.start, end: revenue.end, filed: Object.values(metrics).reduce((latest, metric) => metric.filed > latest ? metric.filed : latest, revenue.filed), metrics, accession: revenue.accession, sourceBasis: ORIGINAL_SOURCE_BASIS };
  });
  const latest = quarters.at(-1);
  const stale = latest && latest.metrics.revenue.status === 'stale';
  return {
    ...emptyCompany(company, !latest ? 'unavailable' : stale ? 'stale' : 'partial'),
    fetchedAt: now.toISOString(), quarters,
    reason: `${NOTICE} ${!latest ? '没有可验证的季度收入。' : stale ? '最新报告期结束已超过200天。' : `近${quarters.length}季；最新连续${contiguousQuarterCount(quarters)}季；独立副源未核验，缺项保持null。`}`,
  };
}

// The human supplies direction AND citations; validation never infers direction
// from article text, financial proxies, a regex, or an empty evidence file.
export function validateEvidenceInput(input, now = new Date()) {
  assert(input?.schemaVersion === 1 && Array.isArray(input.records), 'Evidence schemaVersion/records invalid');
  const ids = new Set();
  for (const record of input.records) {
    assert(record && typeof record === 'object', 'Evidence record invalid');
    for (const key of ['id', 'chainId', 'summary', 'metric', 'unit']) assert(typeof record[key] === 'string' && record[key].trim(), `Evidence ${key} required`);
    assert(!ids.has(record.id), 'Duplicate evidence id'); ids.add(record.id);
    assert(COMPANIES.some((company) => company.id === record.companyId), 'Unknown companyId');
    assert(['application', 'orders', 'profit'].includes(record.group), 'Evidence group invalid');
    assert(record.reviewed === true && record.kind === 'direct' && record.scope === 'AI', 'Only reviewed direct AI evidence accepted');
    assert(['deteriorating', 'improving', 'stable'].includes(record.direction), 'Explicit reviewed direction required');
    validDate(record.periodStart, now); validDate(record.periodEnd, now);
    assert(isEvidenceQuarter(record.periodStart, record.periodEnd), 'Evidence quarter period invalid');
    const publishedAt = validStamp(record.publishedAt, now), reviewedAt = validStamp(record.reviewedAt, now);
    assert(Date.parse(record.periodEnd) + DAY <= publishedAt && publishedAt <= reviewedAt, 'Evidence publication/review order invalid');
    assert(Number.isFinite(record.value) && Number.isFinite(record.baseline), 'Evidence finite value/baseline required');
    assert(typeof record.normalizationReviewed === 'boolean', 'normalizationReviewed boolean required');
    // Preserve explicit false (unresolved) for the frontend gate; never infer
    // clearance from a string or turn structural validation into AI scoring.
    assert(Array.isArray(record.confounders) && record.confounders.every((value) => value && typeof value === 'object' && !Array.isArray(value)
      && typeof value.cleared === 'boolean' && [value.name, value.reason].some((label) => typeof label === 'string' && label.trim())), 'confounders require named objects with boolean cleared');
    assert(Array.isArray(record.sources) && record.sources.length >= 2, 'Evidence requires two sources');
    for (const source of record.sources) {
      validSource(source);
      assert(typeof source.publisher === 'string' && source.publisher.trim() && ['official', 'independent'].includes(source.type), 'Evidence publisher/type invalid');
      assert(source.status === undefined || source.status === 'ok', 'Evidence source status invalid');
    }
    assert(record.sources.some((source) => source.type === 'official') && record.sources.some((source) => source.type === 'independent')
      && new Set(record.sources.map((source) => source.publisher.trim().toLowerCase())).size >= 2
      && new Set(record.sources.map((source) => new URL(source.url).hostname.toLowerCase().replace(/^www\./, ''))).size >= 2, 'Evidence requires independent publishers/hosts and official + independent types');
    if (record.deploymentDate !== undefined || record.group === 'application') {
      validDate(record.deploymentDate, now); assert(record.deploymentDate <= record.periodEnd, 'Deployment after evaluation period');
    }
    if (record.evaluationWindowQuarters !== undefined || record.group === 'application') {
      assert(Number.isInteger(record.evaluationWindowQuarters) && record.evaluationWindowQuarters >= 2 && record.evaluationWindowQuarters <= 8, 'Invalid evaluation window (2–8 quarters required)');
    }
    if (record.group === 'application') assert(Date.parse(record.periodEnd) - Date.parse(record.deploymentDate) >= record.evaluationWindowQuarters * 90 * DAY, 'Application evaluation window not mature');
    if (record.procurementSide !== undefined) assert(['buyer', 'supplier'].includes(record.procurementSide), 'Invalid procurement side');
  }
  return structuredClone(input.records);
}
export function parseDisclosures(posts, now = new Date()) {
  assert(Array.isArray(posts), 'News metadata is not an array');
  return posts.slice(0, 3).flatMap((post) => {
    try {
      validSource({ name: 'SK hynix official newsroom / pending manual verification', url: post.link });
      assert(new URL(post.link).hostname === 'news.skhynix.com', 'Not official newsroom');
      const publishedAt = `${post.date_gmt}Z`;
      validTimestamp(publishedAt, now);
      assert(typeof post.title?.rendered === 'string', 'News title missing');
      // Strip presentation markup only. Never use title polarity as evidence.
      const title = post.title.rendered.replace(/<[^>]*>/g, '').replaceAll('&amp;', '&').replaceAll('&#8217;', '’').replaceAll('&quot;', '"');
      return [{ publishedAt, source: { name: 'SK hynix official newsroom / disclosure待人工核验', url: post.link }, title }];
    } catch { return []; }
  });
}

function validateMetric(metric, now, quarter) {
  assert(metric && (metric.value === null || Number.isFinite(metric.value)), 'Metric finite value/null required');
  assert(['USD', 'TWD', 'KRW'].includes(metric.currency) && typeof metric.unit === 'string', 'Metric currency/unit invalid');
  assert(['observed', 'derived'].includes(metric.kind) && metric.scope === 'company', 'Only company financial observations/derivations');
  assert(['ok', 'unavailable', 'stale', 'error'].includes(metric.status), 'Metric status invalid');
  validSource(metric.source); assert(typeof metric.tag === 'string', 'Metric tag required');
  if (metric.value !== null) {
    assert(metric.status !== 'unavailable', 'Unavailable value must be null');
    assert(metric.period && metric.period.end === quarter.end, 'Metric/quarter period mismatch');
    validDate(metric.period.start, now); validDate(metric.period.end, now); validDate(metric.filed, now);
    assert(metric.filed > quarter.end && metric.filed <= quarter.filed, 'Metric filing order invalid');
    assert(/^\d{10}-\d{2}-\d{6}$/.test(metric.accession), 'Metric accession required');
    assert(metric.currency === quarter.metrics.revenue.currency, 'Mixed quarter currencies');
    assert(metric.period.start === quarter.start || (metric.tag === 'us-gaap:InventoryNet' && metric.period.start === quarter.end), 'Metric start misalignment');
    if (metric.kind === 'derived') {
      assert(Array.isArray(metric.inputs) && metric.inputs.length >= 2, 'Derived metric inputs required');
      for (const fact of metric.inputs) { validateFactInput(fact, now, metric.currency); assert(fact.filed <= metric.filed, 'Derived metric predates input filing'); }
      validateDerivation({ ...metric, start: metric.period.start, end: metric.period.end });
    }
  } else assert(metric.status === 'unavailable' || metric.status === 'error', 'Null is not fresh financial data');
}
function validateDerivation(fact) {
  if (fact.tag === 'derived:(revenue-costOfRevenue)/revenue') {
    const [revenue, cost] = fact.inputs;
    assert(revenue.value > 0 && [revenue, cost].every((input) => input.start === fact.start && input.end === fact.end && input.currency === fact.currency && input.fiscalYear === fact.fiscalYear), 'Gross margin input alignment invalid');
    assert(Math.abs(fact.value - (revenue.value - cost.value) / revenue.value * 100) < 1e-8, 'Gross margin formula invalid');
  } else {
    const expected = quarterize(fact.inputs).find((quarter) => quarter.start === fact.start && quarter.end === fact.end && quarter.kind === 'derived');
    assert(expected && expected.tag === fact.tag && expected.currency === fact.currency && expected.fiscalYear === fact.fiscalYear && Math.abs(expected.value - fact.value) <= Math.max(1e-8, Math.abs(fact.value) * 1e-12), 'YTD continuity/formula invalid');
  }
}
function validateFactInput(fact, now, currency) {
  assert(fact && Number.isFinite(fact.value) && fact.currency === currency, 'Invalid derivation input');
  validDate(fact.start, now); validDate(fact.end, now); validDate(fact.filed, now);
  assert(fact.start <= fact.end && fact.filed > fact.end && typeof fact.tag === 'string', 'Input period/tag invalid');
  assert(/^\d{10}-\d{2}-\d{6}$/.test(fact.accession), 'Input accession invalid'); validSource(fact.source);
  if (fact.inputs) {
    for (const input of fact.inputs) { validateFactInput(input, now, currency); assert(input.filed <= fact.filed, 'Input publication order invalid'); }
    validateDerivation(fact);
  }
}
function validateCompany(company, now) {
  const definition = COMPANIES.find((entry) => entry.id === company.id);
  assert(definition && company.name === definition.name && company.role === definition.role, 'Company identity mismatch');
  assert(['ok', 'partial', 'error', 'unavailable', 'stale'].includes(company.status), 'Company status invalid');
  validSource(company.source);
  if (company.fetchedAt !== null) validTimestamp(company.fetchedAt, now);
  assert(Array.isArray(company.quarters) && company.quarters.length <= 8, 'Quarter count invalid');
  let lastEnd = '';
  for (const quarter of company.quarters) {
    validDate(quarter.start, now); validDate(quarter.end, now); validDate(quarter.filed, now);
    assert(isQuarter(quarter.start, quarter.end) && quarter.end > lastEnd && quarter.filed > quarter.end, 'Quarter period/order invalid'); lastEnd = quarter.end;
    assert(quarter.sourceBasis === ORIGINAL_SOURCE_BASIS, 'Quarter original-disclosure source basis required');
    assert(company.fetchedAt !== null && quarter.filed <= company.fetchedAt.slice(0, 10), 'Quarter filing after fetch');
    for (const key of METRIC_KEYS) { assert(Object.hasOwn(quarter.metrics, key), 'Incomplete metric keys'); validateMetric(quarter.metrics[key], now, quarter); }
    if (quarter.metrics.capitalInvestmentIncludingIntangibles) validateMetric(quarter.metrics.capitalInvestmentIncludingIntangibles, now, quarter);
    assert(quarter.metrics.revenue.value !== null && company.fetchedAt !== null, 'Financial quarter must have dated revenue');
    if (quarter.accession) assert(/^\d{10}-\d{2}-\d{6}$/.test(quarter.accession), 'Quarter accession invalid');
  }
  assert(['verified', 'unverified', 'disagreement', 'unavailable'].includes(company.crossCheck?.status) && typeof company.crossCheck.reason === 'string', 'Cross-check metadata invalid');
  if (company.crossCheck.source) validSource(company.crossCheck.source);
  if (company.disclosures) for (const disclosure of company.disclosures) { validTimestamp(disclosure.publishedAt, now); validSource(disclosure.source); assert(typeof disclosure.title === 'string', 'Disclosure title invalid'); }
  return company;
}
export function freshCompanyIds(snapshot) {
  return snapshot.companies.filter((company) => ['ok', 'partial'].includes(company.status) && company.fetchedAt === snapshot.generatedAt
    && company.quarters.at(-1)?.metrics.revenue.status === 'ok'
    && (Date.parse(snapshot.generatedAt) - Date.parse(company.quarters.at(-1).end)) / DAY <= MAX_QUARTER_AGE_DAYS).map((company) => company.id);
}
export function validateSnapshot(snapshot, now = new Date()) {
  assert(snapshot?.schemaVersion === 1 && Array.isArray(snapshot.companies) && Array.isArray(snapshot.errors) && Array.isArray(snapshot.evidence), 'Snapshot schema invalid');
  validTimestamp(snapshot.generatedAt, now);
  if (snapshot.lastSuccessfulAt !== null) { validTimestamp(snapshot.lastSuccessfulAt, now); assert(snapshot.lastSuccessfulAt <= snapshot.generatedAt, 'Success after generation'); }
  assert(snapshot.companies.length === COMPANIES.length && snapshot.companies.every((company, index) => company.id === COMPANIES[index].id), 'Company coverage/order invalid');
  for (const company of snapshot.companies) validateCompany(company, now);
  validateEvidenceInput({ schemaVersion: 1, records: snapshot.evidence }, new Date(snapshot.generatedAt));
  const fresh = freshCompanyIds(snapshot);
  const expected = !fresh.length ? 'failed' : snapshot.companies.every((company) => company.status === 'ok') && !snapshot.errors.length ? 'ok' : 'partial';
  assert(snapshot.runStatus === expected, 'False runStatus freshness');
  if (fresh.length) assert(snapshot.lastSuccessfulAt === snapshot.generatedAt, 'Fresh run must advance success timestamp');
  else assert(snapshot.lastSuccessfulAt === null || snapshot.lastSuccessfulAt < snapshot.generatedAt, 'Failed run cannot advance success');
  return snapshot;
}

export async function collectAICompanies({ now = () => new Date(), fetchImpl = fetch, previous = null, evidenceInput = { schemaVersion: 1, records: [] }, timeoutMs = 20_000 } = {}) {
  const at = now(), generatedAt = at.toISOString(), errors = [];
  let evidence = [];
  try { evidence = validateEvidenceInput(evidenceInput, at); } catch (error) { errors.push({ stage: 'evidence', message: error.message }); }
  const companies = [];
  for (const definition of COMPANIES) {
    let company = emptyCompany(definition, 'unavailable', `${NOTICE} 官方IR缺少支持严格日期/口径验证的机器季度指标；链接保留供人工核验。`);
    if (definition.cik) {
      try {
        company = parseCompanyFacts(JSON.parse(await fetchPublic(secURL(definition.cik), { fetchImpl, timeoutMs })), definition, at);
        validateCompany(company, at);
      } catch (error) {
        const reason = `SEC collection failed: ${error.message}`;
        const old = previous?.companies?.find((entry) => entry.id === definition.id);
        let retained = false;
        try {
          validateCompany(old, at);
          assert(old.quarters.length > 0, 'No previous financial values');
          company = structuredClone(old); company.status = 'error'; company.reason = `${NOTICE} ${reason}；保留上次原fetchedAt，不计fresh。`;
          for (const quarter of company.quarters) for (const metric of Object.values(quarter.metrics)) if (metric.value !== null) metric.status = 'error';
          company.crossCheck = singleSource(definition, '本次主源失败，旧副源核验不得视为当前核验。');
          retained = true;
        } catch { /* Prior unvalidated data must not enter production. */ }
        if (!retained) company = emptyCompany(definition, 'error', `${NOTICE} ${reason}`);
        errors.push({ companyId: definition.id, stage: 'primary', source: sourceFor(definition), message: reason });
      }
    }
    if (definition.id === 'SKHYNIX') {
      const url = 'https://news.skhynix.com/wp-json/wp/v2/posts?search=earnings&per_page=3';
      try {
        company.disclosures = parseDisclosures(JSON.parse(await fetchPublic(url, { fetchImpl, timeoutMs })), at);
        company.fetchedAt = generatedAt;
        company.reason += ' 新闻仅为disclosure待人工核验；不抽取财务、不regex计分。';
      } catch (error) { errors.push({ companyId: definition.id, stage: 'disclosure', source: { name: 'SK hynix official news metadata', url }, message: error.message }); }
    }
    companies.push(company);
  }
  // Bound independent-site probes to TWO companies for the whole run. A SEC
  // filing is NOT a second source. No approximate HTML-to-quarter matching.
  for (const id of ['NVDA', 'AMD']) {
    const company = companies.find((entry) => entry.id === id), url = company.crossCheck.source.url;
    let reason = 'HTTP 200，但精确季度日期/财务单位解析未支持；不使用近似数值。';
    try { await fetchPublic(url, { fetchImpl, timeoutMs }); } catch (error) { reason = error.message; }
    company.crossCheck = singleSource(COMPANIES.find((entry) => entry.id === id), `独立副源本次探测：${reason}；其余公司未重复探测同站点。`);
    errors.push({ companyId: id, stage: 'crossCheck', source: company.crossCheck.source, message: company.crossCheck.reason });
  }
  for (const company of companies) if (['stale', 'unavailable'].includes(company.status)) errors.push({ companyId: company.id, stage: 'coverage', source: company.source, message: company.reason });
  const snapshot = { schemaVersion: 1, generatedAt, lastSuccessfulAt: null, runStatus: 'failed', companies, evidence, errors };
  const fresh = freshCompanyIds(snapshot);
  if (fresh.length) { snapshot.lastSuccessfulAt = generatedAt; snapshot.runStatus = 'partial'; }
  else {
    try { validTimestamp(previous.lastSuccessfulAt, at); assert(previous.lastSuccessfulAt < generatedAt, 'Future prior success'); snapshot.lastSuccessfulAt = previous.lastSuccessfulAt; } catch { /* No verified prior success. */ }
  }
  return validateSnapshot(snapshot, at);
}
export async function runCollector({ outputPath = fileURLToPath(new URL('../data/ai-company-daily.json', import.meta.url)), inputPath = fileURLToPath(new URL('../data/ai-evidence-input.json', import.meta.url)), ...options } = {}) {
  let previous = null, evidenceInput;
  try { previous = JSON.parse(await readFile(outputPath, 'utf8')); } catch { /* First run. */ }
  try { evidenceInput = JSON.parse(await readFile(inputPath, 'utf8')); } catch { evidenceInput = null; }
  let snapshot;
  try { snapshot = await collectAICompanies({ previous, evidenceInput, ...options }); }
  catch (error) {
    const generatedAt = (options.now ? options.now() : new Date()).toISOString();
    snapshot = { schemaVersion: 1, generatedAt, lastSuccessfulAt: null, runStatus: 'failed', companies: COMPANIES.map((company) => emptyCompany(company, 'error', 'Collector failed before validated snapshot')), evidence: [], errors: [{ stage: 'collector', message: error.message }] };
  }
  // Even all-source failure writes a diagnostics envelope before exiting nonzero.
  await writeFile(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  return snapshot;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const snapshot = await runCollector();
  console.log(JSON.stringify({ runStatus: snapshot.runStatus, freshCompanies: freshCompanyIds(snapshot), companies: snapshot.companies.map(({ id, status, quarters }) => ({ id, status, quarters: quarters.length, latestPeriodEnd: quarters.at(-1)?.end || null })), evidence: snapshot.evidence.length, errors: snapshot.errors.length }));
  if (snapshot.runStatus === 'failed') process.exitCode = 1;
}
