import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  METRIC_IDS, MAX_AGE_DAYS, normalizeDate, periodEnd, observationAgeDays, checkFreshness,
  parseCSV, parseFredCSV, parseYahooChart, isYahooDailyClosed, parseStooqCSV,
  parseMultplTable, calculateYoY, calculateDebtGDP, fetchText, mapLimit,
  collectCrisis, validateSnapshot, summarizeSnapshot, freshMetricIds,
} from '../scripts/update-crisis.mjs';

// Deterministic parser fixtures, never written to the live daily data file.
const NOW = new Date('2026-11-09T08:00:00.000Z');
const clock = () => new Date(NOW);
const response = (text, status = 200) => new Response(text, { status });
const csv = (series, rows) => `observation_date,${series}\n${rows.map((point) => `${point.date},${point.value}`).join('\n')}\n`;
function yahoo(symbol, dates = ['2025-11-06', '2026-11-06'], closes = [100, 120]) {
  return { chart: { error: null, result: [{ meta: { symbol, exchangeTimezoneName: 'America/New_York' },
    timestamp: dates.map((date) => Date.parse(`${date}T16:00:00Z`) / 1000),
    indicators: { quote: [{ close: closes }] } }] } };
}
function multpl(value = 25, date = 'Nov 6, 2026', estimate = false) {
  return `<html><table id="datatable"><tr><th>Date</th><th>Value</th></tr><tr class="odd"><td>${date}</td><td>${estimate ? '<abbr title="Estimate">†</abbr>' : '&#x2002;'}${value}</td></tr></table></html>`;
}
const EPS_URL = 'https://www.multpl.com/s-p-500-earnings/table/by-year';
const EPS_UNIT = 'inflation-adjusted 12-month real EPS (source rebases to latest CPI; not nominal/operating EPS or consensus)';
function multplEarnings() {
  return '<html><h1>S&P 500 Earnings by Year</h1><p>12-month real earnings, inflation adjusted.</p><table id="datatable"><tr><th>Date</th><th>Value</th></tr>'
    + '<tr class="odd"><td>Jun 30, 2026</td><td>&#x2002;298.03</td></tr>'
    + '<tr class="even"><td>Dec 31, 2025</td><td>250.20</td></tr>'
    + '<tr class="odd"><td>Dec 31, 2024</td><td>224.38</td></tr></table></html>';
}
function fixtureFetch(url) {
  const parsed = new URL(url);
  if (parsed.hostname.endsWith('yahoo.com')) {
    return Promise.resolve(response(JSON.stringify(yahoo(decodeURIComponent(parsed.pathname.split('/').at(-1))))));
  }
  if (url === EPS_URL) return Promise.resolve(response(multplEarnings()));
  if (parsed.hostname === 'www.multpl.com') return Promise.resolve(response(multpl(25, 'Nov 6, 2026', parsed.pathname.includes('s-p-500'))));
  if (parsed.hostname === 'fred.stlouisfed.org') {
    const id = parsed.searchParams.get('id');
    const monthly = ['CPIAUCSL', 'PCEPILFE', 'CSUSHPINSA'];
    let rows = [{ date: '2026-11-06', value: 5 }];
    if (id === 'DCCLACBS') return Promise.resolve(response('No such FRED series', 404));
    if (monthly.includes(id)) rows = [{ date: '2025-10-01', value: 100 }, { date: '2026-10-01', value: 103 }];
    if (['UNRATE', 'UMCSENT'].includes(id)) rows = [{ date: '2026-10-01', value: 5 }];
    if (['CP', 'BCNSDODNS', 'GDP'].includes(id)) rows = [
      { date: '2025-04-01', value: id === 'BCNSDODNS' ? 15_000_000 : 30_000 },
      { date: '2026-04-01', value: id === 'BCNSDODNS' ? 16_000_000 : 32_000 },
    ];
    if (id === 'DRCCLACBS') rows = [{ date: '2026-04-01', value: 2.85 }];
    if (['SP500', 'NASDAQCOM', 'CBBTCUSD', 'DCOILWTICO'].includes(id)) rows = [{ date: '2025-11-06', value: 100 }, { date: '2026-11-06', value: 120 }];
    return Promise.resolve(response(csv(id, rows)));
  }
  return Promise.resolve(response('blocked', 403));
}
const collect = (options = {}) => collectCrisis({ now: clock, fetchImpl: fixtureFetch, retries: 0, ...options });

test('date normalization preserves reporting periods and rejects impossible/future dates', () => {
  assert.equal(normalizeDate('2026-10', NOW), '2026-10-01');
  assert.equal(normalizeDate('2026Q3', NOW), '2026-07-01');
  assert.equal(normalizeDate('2026-Q2', NOW), '2026-04-01');
  assert.equal(normalizeDate('2024-02-29', NOW), '2024-02-29');
  for (const date of [null, '', '2026-02-29', '2026-13-01', '2026-11-10', '2027-Q1', 'Nov 6']) {
    assert.throws(() => normalizeDate(date, NOW));
  }
});

test('CSV validates headers, quotes, widths, BOM and missing observations', () => {
  const points = parseFredCSV('\uFEFF"DATE","CPIAUCSL"\r\n"2025-10-01","100"\r\n"2026-10-01","103"\r\n2026-11-01,.\r\n', 'CPIAUCSL', NOW);
  assert.deepEqual(points, [{ date: '2025-10-01', value: 100 }, { date: '2026-10-01', value: 103 }]);
  assert.deepEqual(parseCSV('a,b\n"hello, world","escaped ""quote"""\n'), [['a', 'b'], ['hello, world', 'escaped "quote"']]);
  for (const text of ['<html>error</html>', '', 'DATE,X\n2026-10-01,1', 'DATE,CPIAUCSL\n2026-10-01,1,2', 'DATE,CPIAUCSL\n2026-10-01,"1', 'DATE,CPIAUCSL\n2026-10-01,NaN', 'DATE,CPIAUCSL\n2026-10-01,Infinity', 'DATE,CPIAUCSL\n2026-10-01,1e999', 'DATE,CPIAUCSL\n2026-10-01,0\n2026-10-01,1', 'DATE,CPIAUCSL\n2027-01-01,.', 'DATE,CPIAUCSL\n2026-10-01,.', 'DATE,CPIAUCSL\n2026-10-01,"1"x']) {
    assert.throws(() => parseFredCSV(text, 'CPIAUCSL', NOW));
  }
});

test('YoY requires exact 12-month monthly/quarterly baseline, never the 12th available row', () => {
  const points = [{ date: '2025-10-01', value: 100 }, { date: '2026-09-01', value: 102 }, { date: '2026-10-01', value: 103 }];
  assert.ok(Math.abs(calculateYoY(points, 'monthly').value - 3) < 1e-10);
  assert.throws(() => calculateYoY(points.slice(1), 'monthly'), /baseline/);
  assert.throws(() => calculateYoY([{ date: '2025-07-01', value: 100 }, { date: '2026-04-01', value: 103 }], 'quarterly'), /baseline/);
  assert.ok(Math.abs(calculateYoY([{ date: '2025-04-01', value: 100 }, { date: '2026-04-01', value: 110 }], 'quarterly').value - 10) < 1e-10);
  for (const value of [0, -1, NaN, Infinity]) assert.throws(() => calculateYoY([{ date: '2025-10-01', value }, points.at(-1)], 'monthly'), /denominator/);
});

test('daily price returns use prior trading session within seven days and clamp leap anniversaries', () => {
  const points = [{ date: '2025-11-06', value: 100 }, { date: '2025-11-10', value: 999 }, { date: '2026-11-09', value: 120 }];
  const result = calculateYoY(points, 'daily');
  assert.equal(result.inputs[1].date, '2025-11-06');
  assert.ok(Math.abs(result.value - 20) < 1e-10);
  assert.throws(() => calculateYoY([{ date: '2025-10-01', value: 100 }, points.at(-1)], 'daily'), /baseline/);
  assert.equal(calculateYoY([{ date: '2023-02-28', value: 100 }, { date: '2024-02-29', value: 110 }], 'daily').target, '2023-02-28');
});

test('debt/GDP aligns quarter and converts millions to GDP billions (SAAR)', () => {
  const debt = [{ date: '2026-04-01', value: 16_000_000 }, { date: '2026-07-01', value: 17_000_000 }];
  const gdp = [{ date: '2026-04-01', value: 32_000 }];
  assert.equal(calculateDebtGDP(debt, gdp).value, 50);
  assert.equal(calculateDebtGDP(debt, gdp).date, '2026-04-01');
  assert.throws(() => calculateDebtGDP(debt, [{ date: '2026-04-01', value: 0 }]), /denominator/);
  assert.throws(() => calculateDebtGDP(debt, [{ date: '2026-01-01', value: 32_000 }]), /matching/);
});

test('Yahoo uses dated closes and exchange-local date; validates API errors and numeric data', () => {
  assert.equal(parseYahooChart(yahoo('^GSPC'), '^GSPC', NOW).at(-1).date, '2026-11-06');
  const local = yahoo('^GSPC', ['2026-11-06'], [120]);
  local.chart.result[0].timestamp = [Date.parse('2026-11-07T00:30:00Z') / 1000];
  assert.equal(parseYahooChart(local, '^GSPC', NOW)[0].date, '2026-11-06');
  const btc = yahoo('BTC-USD', ['2026-11-06'], [120]);
  btc.chart.result[0].timestamp = local.chart.result[0].timestamp;
  assert.equal(parseYahooChart(btc, 'BTC-USD', NOW)[0].date, '2026-11-07');
  assert.throws(() => parseYahooChart({ chart: { error: { code: 'Not Found', description: 'no symbol' } } }, '^GSPC', NOW), /API error/);
  assert.throws(() => parseYahooChart(yahoo('wrong'), '^GSPC', NOW), /symbol/);
  assert.throws(() => parseYahooChart(yahoo('^GSPC', ['2027-01-01'], [100]), '^GSPC', NOW), /future/);
  assert.throws(() => parseYahooChart(yahoo('^GSPC', ['2026-11-06'], [NaN]), '^GSPC', NOW), /Non-finite/);
  assert.throws(() => parseYahooChart(yahoo('^GSPC', ['2026-11-06'], ['100']), '^GSPC', NOW), /Non-finite/);
  assert.throws(() => parseYahooChart(yahoo('^GSPC', ['2026-11-06'], []), '^GSPC', NOW), /length/);
  assert.throws(() => parseYahooChart(yahoo('^GSPC', ['2026-11-06'], [null]), '^GSPC', NOW), /No numeric/);
  const undated = yahoo('^GSPC');
  delete undated.chart.result[0].meta.exchangeTimezoneName;
  assert.throws(() => parseYahooChart(undated, '^GSPC', NOW), /timezone/);
});

test('Stooq validates historical close CSV and rejects errors and future dates', () => {
  const text = 'Date,Open,High,Low,Close,Volume\n2025-11-06,100,101,99,100,10\n2026-11-06,119,121,118,120,20\n';
  assert.equal(parseStooqCSV(text, NOW).at(-1).value, 120);
  for (const invalid of ['No data', '<html>denied</html>', text.replace('2026-11-06', '2027-01-01'), text.replace('Close', 'Price'), text.replace(',120,', ',NaN,')]) {
    assert.throws(() => parseStooqCSV(invalid, NOW));
  }
});

test('Multpl only pairs value with explicitly dated table row, flags source estimates', () => {
  assert.deepEqual(parseMultplTable(multpl(25.14, 'Nov 6, 2026', true), NOW), { date: '2026-11-06', value: 25.14, estimated: true });
  assert.deepEqual(parseMultplTable(multplEarnings(), NOW), { date: '2026-06-30', value: 298.03, estimated: false });
  for (const text of ['<div id="current">25<div id="timestamp">4:00 PM EST, Fri Nov 6</div></div>', multpl(25, 'Nov 6'), multpl(25, 'Nov 10, 2026'), multpl('NaN'), multpl(0), multpl(25, 'Feb 30, 2026')]) {
    assert.throws(() => parseMultplTable(text, NOW));
  }
});

test('bounded request retries 5xx but not 403, and validates empty/HTTPS/settings', async () => {
  let attempts = 0;
  assert.equal(await fetchText('https://example.org', { fetchImpl: async () => ++attempts === 1 ? response('busy', 503) : response('data'), retries: 1 }), 'data');
  assert.equal(attempts, 2);
  attempts = 0;
  await assert.rejects(fetchText('https://example.org', { fetchImpl: async () => { attempts++; return response('denied', 403); }, retries: 2 }), /HTTP 403/);
  assert.equal(attempts, 1);
  attempts = 0;
  await assert.rejects(fetchText('https://example.org', { fetchImpl: async () => { attempts++; throw new Error('offline'); }, retries: 1 }), /offline/);
  assert.equal(attempts, 2);
  await assert.rejects(fetchText('https://example.org', { fetchImpl: async () => response('') }), /Empty/);
  await assert.rejects(fetchText('http://example.org'), /HTTPS/);
  await assert.rejects(fetchText('https://example.org', { retries: 99 }), /settings/);
});

test('native timeout aborts a stalled request and bounds retries', async () => {
  let attempts = 0;
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    attempts++;
    const keepAlive = setTimeout(() => reject(new Error('timeout not enforced')), 500);
    signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(signal.reason); }, { once: true });
  });
  await assert.rejects(fetchText('https://example.org', { fetchImpl, timeoutMs: 15, retries: 1 }), /timeout|timed out/i);
  assert.equal(attempts, 2);
});

test('all request paths including sequential fallbacks respect global concurrency <= 4', async () => {
  let active = 0, maximum = 0;
  const fetchImpl = async (url) => {
    active++; maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 2));
    active--;
    if (url.includes('yahoo.com')) return response('blocked', 403);
    return fixtureFetch(url);
  };
  const snapshot = await collect({ fetchImpl, concurrency: 3 });
  assert.ok(maximum <= 3);
  assert.ok(maximum > 1);
  assert.equal(snapshot.metrics.SP500.status, 'ok');
  await assert.rejects(mapLimit([1], 5, async () => {}), /Concurrency/);
});

test('complete attempted coverage, provenance, publication dates and non-assumption missing data', async () => {
  const snapshot = await collect();
  assert.equal(METRIC_IDS.length, 33);
  assert.deepEqual(Object.keys(snapshot.metrics), METRIC_IDS);
  assert.equal(snapshot.runStatus, 'partial');
  assert.equal(snapshot.lastSuccessfulAt, NOW.toISOString());
  assert.equal(snapshot.metrics.UNRATE.observationDate, '2026-10-01');
  assert.equal(snapshot.metrics.UNRATE.fetchedAt, NOW.toISOString());
  assert.equal(snapshot.metrics.CPI_YOY.kind, 'derived');
  assert.equal(snapshot.metrics.CORP_PROFIT_YOY.frequency, 'quarterly');
  assert.match(snapshot.metrics.CORP_PROFIT_YOY.source.name, /BEA all-US/);
  assert.equal(snapshot.metrics.CORP_DEBT_GDP.value, 50);
  assert.equal(snapshot.metrics.CONCENTRATION.value, null);
  assert.equal(snapshot.metrics.CONCENTRATION.observationDate, null);
  assert.match(snapshot.metrics.CONCENTRATION.error, /No reliable dated/);
  assert.equal(snapshot.metrics.PE_TTM.kind, 'proxy');
  assert.equal(snapshot.metrics.GOLD.kind, 'proxy');
  assert.equal(snapshot.metrics.GOLD_YOY.kind, 'derived');
  assert.equal(snapshot.metrics.EPS_TTM.frequency, 'quarterly');
  assert.equal(snapshot.metrics.EPS_TTM.kind, 'observed');
  assert.equal(snapshot.metrics.EPS_TTM.value, 298.03);
  assert.equal(snapshot.metrics.EPS_TTM.observationDate, '2026-06-30');
  assert.equal(snapshot.metrics.EPS_TTM.fetchedAt, NOW.toISOString());
  assert.equal(snapshot.metrics.EPS_TTM.status, 'ok');
  assert.equal(snapshot.metrics.EPS_TTM.unit, EPS_UNIT);
  assert.equal(snapshot.metrics.EPS_TTM.source.name, 'Multpl / Shiller S&P 500 12-month real earnings');
  assert.equal(snapshot.metrics.EPS_TTM.source.url, EPS_URL);
  assert.equal(snapshot.metrics.EPS_TTM.inputs, undefined);
  assert.notEqual(snapshot.metrics.EPS_TTM.value, snapshot.metrics.SP500.value / snapshot.metrics.PE_TTM.value);
  assert.equal(validateSnapshot(snapshot, NOW), snapshot);
  assert.equal(summarizeSnapshot(snapshot).retrieved, 32);
});

test('Yahoo query2, Stooq and FRED fallback preserve real observation provenance', async () => {
  const tried = [];
  const fetchImpl = async (url) => {
    tried.push(url);
    if (url.includes('query1')) return response('blocked', 403);
    if (url.includes('query2') && url.includes('%5EGSPC')) return fixtureFetch(url);
    if (url.includes('yahoo.com')) return response('blocked', 403);
    if (url.includes('stooq.com') && new URL(url).searchParams.get('s') === 'xauusd') return response('Date,Open,High,Low,Close\n2025-11-06,100,101,99,100\n2026-11-06,119,121,118,120\n');
    return fixtureFetch(url);
  };
  const snapshot = await collect({ fetchImpl });
  assert.match(snapshot.metrics.SP500.source.url, /query2/);
  assert.match(snapshot.metrics.NASDAQ.source.name, /FRED NASDAQCOM/);
  assert.equal(snapshot.metrics.GOLD.source.name, 'Stooq xauusd');
  assert.equal(snapshot.metrics.GOLD.kind, 'observed');
  assert.match(snapshot.metrics.WTI.source.name, /DCOILWTICO/);
  assert.equal(snapshot.metrics.WTI.kind, 'observed');
  assert.equal(snapshot.metrics.WTI_YOY.kind, 'derived');
  assert.match(snapshot.metrics.BTC.source.name, /CBBTCUSD/);
  assert.equal(snapshot.metrics.DCCLACBS.source.name, 'FRED DRCCLACBS');
  assert.equal(snapshot.metrics.DCCLACBS.value, 2.85);
  assert.equal(snapshot.metrics.DCCLACBS.observationDate, '2026-04-01');
  assert.equal(snapshot.metrics.DXY.value, null);
  assert.equal(snapshot.metrics.DXY.status, 'unavailable');
  assert.match(snapshot.metrics.DXY.error, /query1.*query2.*Stooq/);
  assert.ok(tried.some((url) => url.includes('query2')));
});

test('a level can succeed while its 1Y baseline is unavailable; independent EPS ignores price/PE dates', async () => {
  const fetchImpl = async (url) => {
    if (url.includes('yahoo.com') && url.includes('%5EGSPC')) return response(JSON.stringify(yahoo('^GSPC', ['2026-11-05'], [120])));
    if (new URL(url).searchParams.get('id') === 'SP500') return response('denied', 403);
    return fixtureFetch(url);
  };
  const snapshot = await collect({ fetchImpl });
  assert.equal(snapshot.metrics.SP500.status, 'ok');
  assert.equal(snapshot.metrics.SP500_YOY.value, null);
  assert.match(snapshot.metrics.SP500_YOY.error, /baseline/);
  assert.notEqual(snapshot.metrics.SP500.observationDate, snapshot.metrics.PE_TTM.observationDate);
  assert.equal(snapshot.metrics.EPS_TTM.value, 298.03);
  assert.equal(snapshot.metrics.EPS_TTM.observationDate, '2026-06-30');
  assert.equal(snapshot.metrics.EPS_TTM.frequency, 'quarterly');
  assert.equal(snapshot.metrics.EPS_TTM.kind, 'observed');
  assert.equal(snapshot.metrics.EPS_TTM.status, 'ok');
  assert.notEqual(snapshot.metrics.EPS_TTM.value, snapshot.metrics.SP500.value / snapshot.metrics.PE_TTM.value);
  assert.ok(!snapshot.errors.some((error) => error.metric === 'EPS_TTM'));
});

test('EPS reads changing earnings-table values even when price and PE sources fail', async () => {
  const fetchImpl = async (url) => {
    if (url === EPS_URL) return response(multplEarnings().replace('298.03', '301.17'));
    if (url.includes('yahoo.com') || url.includes('stooq.com') || url.includes('id=SP500') || url.includes('s-p-500-pe-ratio')) return response('denied', 403);
    return fixtureFetch(url);
  };
  const snapshot = await collect({ fetchImpl });
  assert.equal(snapshot.metrics.SP500.value, null);
  assert.equal(snapshot.metrics.PE_TTM.value, null);
  assert.equal(snapshot.metrics.EPS_TTM.value, 301.17);
  assert.equal(snapshot.metrics.EPS_TTM.observationDate, '2026-06-30');
  assert.equal(snapshot.metrics.EPS_TTM.status, 'ok');
  assert.equal(snapshot.metrics.EPS_TTM.kind, 'observed');
  assert.equal(snapshot.metrics.EPS_TTM.source.url, EPS_URL);
});

test('EPS source failures leave null or retain only prior real EPS with error and original timestamps', async () => {
  const previous = await collect({ now: () => new Date('2026-11-08T08:00:00.000Z') });
  for (const [text, status, reason] of [
    ['denied', 403, /HTTP 403/],
    ['<html>No dated earnings table</html>', 200, /table missing/],
    [multpl('NaN', 'Jun 30, 2026'), 200, /Invalid numeric/],
    [multpl(298.03, 'Jun 30, 2026', true), 200, /not an estimate/],
    [multpl(298.03, 'Jun 30, 2027'), 200, /Future/],
  ]) {
    const fetchImpl = async (url) => url === EPS_URL ? response(text, status) : fixtureFetch(url);
    const missing = await collect({ fetchImpl });
    assert.equal(missing.metrics.SP500.status, 'ok');
    assert.equal(missing.metrics.PE_TTM.value, 25);
    assert.equal(missing.metrics.EPS_TTM.value, null);
    assert.equal(missing.metrics.EPS_TTM.observationDate, null);
    assert.equal(missing.metrics.EPS_TTM.fetchedAt, null);
    assert.equal(missing.metrics.EPS_TTM.status, 'unavailable');
    assert.equal(missing.metrics.EPS_TTM.frequency, 'quarterly');
    assert.equal(missing.metrics.EPS_TTM.kind, 'observed');
    assert.equal(missing.metrics.EPS_TTM.unit, EPS_UNIT);
    assert.equal(missing.metrics.EPS_TTM.source.url, EPS_URL);
    assert.match(missing.metrics.EPS_TTM.error, reason);
    assert.ok(missing.errors.some((error) => error.metric === 'EPS_TTM' && reason.test(error.message)));
    const retained = await collect({ previous, fetchImpl });
    assert.deepEqual(retained.metrics.EPS_TTM, { ...previous.metrics.EPS_TTM, status: 'error', error: missing.metrics.EPS_TTM.error });
    assert.equal(retained.metrics.SP500.fetchedAt, NOW.toISOString());
  }
});

test('EPS source failure never falls back to legacy price/PE-derived EPS', async () => {
  const previous = await collect();
  const index = previous.metrics.SP500, pe = previous.metrics.PE_TTM;
  previous.metrics.EPS_TTM = {
    ...previous.metrics.EPS_TTM, frequency: 'daily', kind: 'derived', value: index.value / pe.value,
    unit: 'index earnings (implied as-reported TTM; not operating EPS or forecast)',
    source: { name: 'Derived S&P 500 / Multpl as-reported TTM PE', url: pe.source.url },
    observationDate: index.observationDate,
    inputs: [index, pe].map(({ value, observationDate, fetchedAt, source }) => ({ value, observationDate, fetchedAt, source })),
  };
  assert.throws(() => validateSnapshot(previous, NOW), /frequency/);
  const snapshot = await collect({ previous, fetchImpl: async (url) => url === EPS_URL ? response('denied', 403) : fixtureFetch(url) });
  assert.equal(snapshot.metrics.EPS_TTM.value, null);
  assert.equal(snapshot.metrics.EPS_TTM.observationDate, null);
  assert.equal(snapshot.metrics.EPS_TTM.fetchedAt, null);
  assert.equal(snapshot.metrics.EPS_TTM.status, 'unavailable');
  assert.equal(snapshot.metrics.EPS_TTM.kind, 'observed');
  assert.equal(snapshot.metrics.EPS_TTM.source.url, EPS_URL);
  assert.match(snapshot.metrics.EPS_TTM.error, /HTTP 403/);
});

test('stale source dates stay source dates, not generatedAt', async () => {
  const fetchImpl = async (url) => url.includes('id=UNRATE')
    ? response(csv('UNRATE', [{ date: '2026-01-01', value: 4 }])) : fixtureFetch(url);
  const snapshot = await collect({ fetchImpl });
  assert.equal(snapshot.metrics.UNRATE.status, 'stale');
  assert.equal(snapshot.metrics.UNRATE.observationDate, '2026-01-01');
  assert.equal(snapshot.metrics.UNRATE.fetchedAt, NOW.toISOString());
  assert.ok(snapshot.errors.some((error) => error.metric === 'UNRATE' && error.message.includes('days old')));
});

test('all-source failure writes honest failed envelope and retains prior values/dates/timestamps', async () => {
  const previous = await collect({ now: () => new Date('2026-11-08T08:00:00.000Z') });
  const snapshot = await collect({ previous, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(snapshot.runStatus, 'failed');
  assert.equal(snapshot.lastSuccessfulAt, previous.lastSuccessfulAt);
  assert.equal(snapshot.generatedAt, NOW.toISOString());
  for (const id of METRIC_IDS) {
    const old = previous.metrics[id], metric = snapshot.metrics[id];
    if (old.value !== null) {
      assert.equal(metric.value, old.value);
      assert.equal(metric.observationDate, old.observationDate);
      assert.equal(metric.fetchedAt, old.fetchedAt);
      assert.equal(metric.status, 'error');
    } else {
      assert.equal(metric.status, 'unavailable');
      assert.equal(metric.fetchedAt, null);
    }
    assert.ok(metric.error);
  }
  assert.equal(summarizeSnapshot(snapshot).retrieved, 0);
  assert.equal(summarizeSnapshot(snapshot).failed, 33);
});

test('first-run failure has null dates and success time; invalid prior values are rejected', async () => {
  const fetchImpl = async () => response('denied', 403);
  const snapshot = await collect({ fetchImpl });
  assert.equal(snapshot.runStatus, 'failed');
  assert.equal(snapshot.lastSuccessfulAt, null);
  assert.ok(Object.values(snapshot.metrics).every((metric) => metric.value === null && metric.observationDate === null && metric.fetchedAt === null));
  const previous = await collect();
  previous.metrics.UNRATE.observationDate = '2027-01-01';
  previous.metrics.DGS2.value = NaN;
  previous.metrics.UMCSENT.kind = 'assumption';
  previous.lastSuccessfulAt = '2027-01-01T00:00:00.000Z';
  const failed = await collect({ previous, fetchImpl });
  assert.equal(failed.lastSuccessfulAt, null);
  assert.equal(failed.metrics.UNRATE.value, null);
  assert.equal(failed.metrics.DGS2.value, null);
  assert.equal(failed.metrics.UMCSENT.value, null);
});

test('partial failures preserve only failed fields; newly retrieved values alone get fetchedAt', async () => {
  const previous = await collect({ now: () => new Date('2026-11-08T08:00:00.000Z') });
  const snapshot = await collect({ previous, fetchImpl: async (url) => url.includes('id=UNRATE') ? response('denied', 403) : fixtureFetch(url) });
  assert.equal(snapshot.runStatus, 'partial');
  assert.equal(snapshot.metrics.UNRATE.fetchedAt, previous.metrics.UNRATE.fetchedAt);
  assert.equal(snapshot.metrics.UNRATE.status, 'error');
  assert.equal(snapshot.metrics.DGS2.fetchedAt, NOW.toISOString());
  assert.equal(snapshot.lastSuccessfulAt, NOW.toISOString());
});

test('JSON contract rejects NaN, future timestamps, incomplete metrics and undated numbers', async () => {
  const snapshot = await collect();
  for (const mutate of [
    (copy) => { copy.metrics.UNRATE.value = NaN; },
    (copy) => { copy.metrics.UNRATE.fetchedAt = '2027-01-01T00:00:00Z'; },
    (copy) => { copy.metrics.UNRATE.observationDate = null; },
    (copy) => { delete copy.metrics.BTC; },
    (copy) => { copy.metrics.CPI_YOY.inputs = []; },
    (copy) => { copy.metrics.CPI_YOY.inputs[0].observationDate = '2027-01-01'; },
    (copy) => { copy.metrics.UNRATE.source.url = 'http://example.org'; },
    (copy) => { copy.generatedAt = '2026-11-09T08:00:00+00:00'; },
  ]) {
    const copy = structuredClone(snapshot);
    mutate(copy);
    assert.throws(() => validateSnapshot(copy, NOW));
  }
});

test('workflow tests before collection, fails after diagnostics, commits only data and deploys an allowlist', async () => {
  const yaml = await readFile(new URL('../.github/workflows/update-crisis.yml', import.meta.url), 'utf8');
  assert.match(yaml, /cron: '25 0 \* \* \*'/);
  assert.match(yaml, /workflow_dispatch:/);
  assert.match(yaml, /node-version: '22'/);
  assert.ok(yaml.indexOf('node --test') < yaml.indexOf('node scripts/update-crisis.mjs'));
  assert.ok(yaml.indexOf('actions/upload-artifact@v4') < yaml.indexOf('Fail visibly'));
  assert.match(yaml, /git add -- "\$DATA_FILE"/);
  assert.match(yaml, /DATA_FILE: data\/crisis-daily.json/);
  assert.doesNotMatch(yaml, /git add (?:\.|-A)|git push .*--force|--no-verify/);
  assert.match(yaml, /for asset in index.html m wm js data \.nojekyll/);
  assert.match(yaml, /actions\/upload-pages-artifact@v3/);
  assert.match(yaml, /actions\/deploy-pages@v4/);
  assert.match(yaml, /pages: write\n      id-token: write/);
  assert.match(yaml, /cancel-in-progress: false/);
  assert.match(yaml, /node --test tests\/crisis-\*\.test\.mjs/);
  assert.match(yaml, /GIT_AUTHOR_NAME: github-actions\[bot\]/);
  assert.match(yaml, /GIT_AUTHOR_EMAIL:/);
  assert.match(yaml, /GIT_COMMITTER_NAME: github-actions\[bot\]/);
  assert.match(yaml, /GIT_COMMITTER_EMAIL:/);
  assert.doesNotMatch(yaml, /git config|git -c user\.|--no-gpg-sign|commit\.gpgsign/);
  const globalPermissions = yaml.split('\npermissions:\n')[1].split('\n\n')[0];
  assert.equal(globalPermissions.trim(), 'contents: write');
  const pushPaths = yaml.split('    paths:\n')[1].split('\n\n')[0];
  for (const entry of ['index.html', 'm/**', 'js/**', 'wm/**', 'tests/crisis-model.test.mjs']) assert.ok(pushPaths.includes(`- ${entry}`));
  assert.doesNotMatch(pushPaths, /data\/|worldmonitor/);
});

test('pure period-end aging uses shared limits, leap month ends and distinct EPS convention', () => {
  assert.deepEqual(MAX_AGE_DAYS, { daily: 7, monthly: 75, quarterly: 160 });
  assert.equal(periodEnd('2024-02-01', 'monthly', NOW), '2024-02-29');
  assert.equal(periodEnd('2026-04-01', 'quarterly', NOW), '2026-06-30');
  assert.equal(periodEnd('2026-06-30', 'quarterly', NOW, 'period-end'), '2026-06-30');
  assert.equal(periodEnd('2025-12-31', 'quarterly', NOW, 'period-end'), '2025-12-31');
  assert.equal(periodEnd('2026-11-06', 'daily', NOW), '2026-11-06');
  assert.ok(Math.abs(observationAgeDays('2026-06-30', NOW) - (132 + 1 / 3)) < 1e-9);
  assert.equal(checkFreshness('2026-04-01', 'quarterly', NOW).status, 'ok');
  assert.equal(checkFreshness('2026-04-01', 'quarterly', new Date('2026-11-27T00:25:00Z')).status, 'ok');
  assert.equal(checkFreshness('2026-06-30', 'quarterly', NOW, { dateConvention: 'period-end' }).status, 'ok');
  assert.equal(checkFreshness('2026-08-01', 'monthly', NOW).status, 'ok');
  assert.equal(checkFreshness('2026-07-01', 'monthly', NOW).status, 'stale');
  const boundary = new Date('2026-11-13T00:00:00Z');
  assert.equal(checkFreshness('2026-11-06', 'daily', boundary).status, 'ok');
  assert.equal(checkFreshness('2026-11-06', 'daily', new Date(boundary.getTime() + 1)).status, 'stale');
  assert.throws(() => checkFreshness('2026-11-06', 'daily', NOW, { maxAgeDays: NaN }), /maxAgeDays/);
  assert.throws(() => observationAgeDays('2026-11-10', NOW), /Future/);
});

test('FRED quarters require exact season starts and completed quarters; EPS accepts only ends', () => {
  for (const id of ['DRCCLACBS', 'CP', 'BCNSDODNS', 'GDP']) {
    assert.equal(parseFredCSV(csv(id, [{ date: '2026-04-01', value: 100 }]), id, NOW)[0].date, '2026-04-01');
    for (const date of ['2026-04-02', '2026-05-01', '2026-06-30', '2026-10-01']) {
      assert.throws(() => parseFredCSV(csv(id, [{ date, value: 100 }]), id, NOW), /period start|Unfinished/);
    }
  }
  assert.throws(() => periodEnd('2026-04-01', 'quarterly', new Date('2026-06-30T23:59:59Z')), /Unfinished/);
  assert.equal(periodEnd('2026-04-01', 'quarterly', new Date('2026-07-01T00:00:00Z')), '2026-06-30');
  assert.throws(() => periodEnd('2026-04-01', 'quarterly', NOW, 'period-end'), /period end/);
  assert.throws(() => periodEnd('2026-06-29', 'quarterly', NOW, 'period-end'), /period end/);
  assert.throws(() => periodEnd('2026-11-01', 'monthly', NOW), /Unfinished/);
});

test('Case-Shiller August stays fresh throughout November with original date and 120-day limit', async () => {
  const november = new Date('2026-11-24T00:25:00Z');
  const snapshot = await collect({ now: () => new Date(november), fetchImpl: async (url) => new URL(url).searchParams.get('id') === 'CSUSHPINSA'
    ? response(csv('CSUSHPINSA', [{ date: '2025-08-01', value: 100 }, { date: '2026-08-01', value: 102 }])) : fixtureFetch(url) });
  const metric = snapshot.metrics.CSUSHPINSA_YOY;
  assert.equal(metric.observationDate, '2026-08-01');
  assert.equal(metric.periodEnd, '2026-08-31');
  assert.equal(metric.maxAgeDays, 120);
  assert.equal(metric.status, 'ok');
  assert.equal(snapshot.metrics.CORP_DEBT_GDP.observationDate, '2026-04-01');
  assert.equal(snapshot.metrics.CORP_DEBT_GDP.periodEnd, '2026-06-30');
  assert.equal(snapshot.metrics.CORP_DEBT_GDP.status, 'ok');
  assert.equal(snapshot.metrics.EPS_TTM.periodEnd, '2026-06-30');
  assert.equal(snapshot.metrics.UNRATE.maxAgeDays, 75);
});

test('BTC UTC00:25 excludes current unfinished daily candle and derives YoY from the same closed day', async () => {
  const at = new Date('2026-11-09T00:25:00Z');
  const payload = yahoo('BTC-USD', ['2025-11-08', '2026-11-08', '2026-11-09'], [100, 120, 999]);
  payload.chart.result[0].meta.exchangeTimezoneName = 'America/New_York';
  payload.chart.result[0].meta.regularMarketPrice = 9999;
  payload.chart.result[0].timestamp = ['2025-11-08', '2026-11-08', '2026-11-09'].map((date) => Date.parse(`${date}T00:00:00Z`) / 1000);
  assert.equal(parseYahooChart(payload, 'BTC-USD', at).at(-1).date, '2026-11-08');
  const snapshot = await collect({ now: () => new Date(at), fetchImpl: async (url) => url.includes('yahoo.com') && url.includes('BTC-USD') ? response(JSON.stringify(payload)) : fixtureFetch(url) });
  assert.equal(snapshot.metrics.BTC.value, 120);
  assert.equal(snapshot.metrics.BTC.observationDate, '2026-11-08');
  assert.equal(snapshot.metrics.BTC_YOY.observationDate, '2026-11-08');
  assert.ok(Math.abs(snapshot.metrics.BTC_YOY.value - 20) < 1e-10);
  assert.equal(snapshot.metrics.BTC.source.url, snapshot.metrics.BTC_YOY.source.url);
  assert.match(snapshot.metrics.BTC.closePolicy, /Completed UTC/);
  assert.equal(isYahooDailyClosed('2026-11-09', 'BTC-USD', 'UTC', at), false);
  assert.equal(isYahooDailyClosed('2026-11-08', 'BTC-USD', 'UTC', at), true);
});

test('equity sessions wait until local16:30 in EST and EDT; futures/DXY exclude the entire current local day', () => {
  for (const [date, utcHour] of [['2026-11-09', '21'], ['2026-07-06', '20']]) {
    for (const symbol of ['^GSPC', '^IXIC']) {
      const payload = yahoo(symbol, ['2025-11-06', date], [100, 999]);
      const before = new Date(`${date}T${utcHour}:29:59Z`);
      const after = new Date(`${date}T${utcHour}:30:00Z`);
      assert.equal(parseYahooChart(payload, symbol, before).at(-1).value, 100);
      assert.equal(parseYahooChart(payload, symbol, after).at(-1).value, 999);
      assert.equal(isYahooDailyClosed(date, symbol, 'America/New_York', before), false);
      assert.equal(isYahooDailyClosed(date, symbol, 'America/New_York', after), true);
    }
  }
  const afterClose = new Date('2026-11-09T23:59:00Z');
  for (const symbol of ['DX-Y.NYB', 'GC=F', 'CL=F']) {
    assert.equal(parseYahooChart(yahoo(symbol, ['2026-11-06', '2026-11-09'], [100, 999]), symbol, afterClose).at(-1).value, 100);
    assert.equal(isYahooDailyClosed('2026-11-09', symbol, 'America/New_York', afterClose), false);
    assert.equal(isYahooDailyClosed('2026-11-09', symbol, 'America/New_York', new Date('2026-11-10T05:00:00Z')), true);
  }
  // UTC midnight is still the previous New York day, which is not complete yet.
  assert.equal(isYahooDailyClosed('2026-11-08', 'GC=F', 'America/New_York', new Date('2026-11-09T00:25:00Z')), false);
});

test('stale parsed Yahoo never blocks fresh FRED fallback and level/return retain same-source provenance', async () => {
  const tried = [];
  const snapshot = await collect({ fetchImpl: async (url) => {
    tried.push(url);
    if (url.includes('yahoo.com') && url.includes('%5EGSPC')) return response(JSON.stringify(yahoo('^GSPC', ['2025-09-01', '2026-09-01'], [100, 777])));
    return fixtureFetch(url);
  } });
  assert.equal(snapshot.metrics.SP500.status, 'ok');
  assert.equal(snapshot.metrics.SP500.value, 120);
  assert.match(snapshot.metrics.SP500.source.name, /FRED SP500/);
  assert.equal(snapshot.metrics.SP500.source.url, snapshot.metrics.SP500_YOY.source.url);
  assert.ok(snapshot.metrics.SP500_YOY.inputs.every((input) => input.source.url === snapshot.metrics.SP500.source.url));
  assert.ok(tried.some((url) => url.includes('query2') && url.includes('%5EGSPC')));
  assert.ok(tried.some((url) => url.includes('stooq.com') && new URL(url).searchParams.get('s') === '^spx'));
});

test('missing Yahoo baseline attempts a complete fresh source instead of publishing missing YoY prematurely', async () => {
  const snapshot = await collect({ fetchImpl: async (url) => url.includes('yahoo.com') && url.includes('%5EGSPC')
    ? response(JSON.stringify(yahoo('^GSPC', ['2026-11-06'], [777]))) : fixtureFetch(url) });
  assert.equal(snapshot.metrics.SP500.value, 120);
  assert.match(snapshot.metrics.SP500.source.name, /FRED SP500/);
  assert.equal(snapshot.metrics.SP500_YOY.status, 'ok');
  assert.ok(Math.abs(snapshot.metrics.SP500_YOY.value - 20) < 1e-10);
  assert.equal(snapshot.metrics.SP500.source.url, snapshot.metrics.SP500_YOY.source.url);
});

test('fresh level without any baseline outranks stale complete return and clears retained incompatible YoY', async () => {
  const previous = await collect({ now: () => new Date('2026-11-08T08:00:00Z') });
  const snapshot = await collect({ previous, fetchImpl: async (url) => {
    if (url.includes('query1') && url.includes('%5EGSPC')) return response(JSON.stringify(yahoo('^GSPC', ['2026-11-06'], [777])));
    if (url.includes('query2') && url.includes('%5EGSPC')) return response(JSON.stringify(yahoo('^GSPC', ['2025-09-01', '2026-09-01'], [100, 200])));
    if (new URL(url).searchParams.get('id') === 'SP500') return response('denied', 403);
    return fixtureFetch(url);
  } });
  assert.equal(snapshot.metrics.SP500.value, 777);
  assert.equal(snapshot.metrics.SP500.status, 'ok');
  assert.equal(snapshot.metrics.SP500_YOY.value, null);
  assert.equal(snapshot.metrics.SP500_YOY.status, 'unavailable');
  assert.match(snapshot.metrics.SP500_YOY.error, /baseline/);
});

test('only stale market alternatives remain stale after exhausting bounded candidates, not fresh success', async () => {
  const tried = [];
  const snapshot = await collect({ fetchImpl: async (url) => {
    if (url.includes('yahoo.com') && url.includes('%5EGSPC')) {
      tried.push(url);
      return response(JSON.stringify(yahoo('^GSPC', ['2025-09-01', '2026-09-01'], [100, 200])));
    }
    if (new URL(url).searchParams.get('id') === 'SP500') { tried.push(url); return response('denied', 403); }
    if (url.includes('stooq.com')) tried.push(url);
    return fixtureFetch(url);
  } });
  assert.equal(snapshot.metrics.SP500.value, 200);
  assert.equal(snapshot.metrics.SP500.status, 'stale');
  assert.equal(snapshot.metrics.SP500_YOY.status, 'stale');
  assert.equal(snapshot.metrics.SP500.source.url, snapshot.metrics.SP500_YOY.source.url);
  assert.equal(tried.length, 4);
  assert.ok(!freshMetricIds(snapshot).includes('SP500'));
  assert.ok(snapshot.errors.some((error) => error.metric === 'SP500' && /period end/.test(error.message)));
});

test('0 fresh + 3 stale + 30 missing is failed and never advances prior success', async () => {
  const previous = await collect({ now: () => new Date('2026-11-08T08:00:00Z') });
  const fetchImpl = async (url) => new URL(url).hostname === 'www.multpl.com'
    ? response(multpl(25, url === EPS_URL ? 'Dec 31, 2025' : 'Jan 1, 2026')) : response('denied', 403);
  const first = await collect({ fetchImpl });
  assert.equal(first.runStatus, 'failed');
  assert.equal(first.lastSuccessfulAt, null);
  assert.deepEqual(summarizeSnapshot(first).counts, { ok: 0, stale: 3, unavailable: 30, error: 0 });
  assert.equal(summarizeSnapshot(first).retrieved, 0);
  assert.equal(summarizeSnapshot(first).fresh, 0);
  assert.equal(validateSnapshot(first, NOW), first);
  const retained = await collect({ previous, fetchImpl });
  assert.equal(retained.runStatus, 'failed');
  assert.equal(retained.lastSuccessfulAt, previous.lastSuccessfulAt);
  assert.equal(summarizeSnapshot(retained).fresh, 0);
  for (const runStatus of ['ok', 'partial']) assert.throws(() => validateSnapshot({ ...first, runStatus }, NOW), /runStatus/);
  assert.throws(() => validateSnapshot({ ...first, lastSuccessfulAt: first.generatedAt }, NOW), /cannot advance/);
});

test('one fresh market/rates/macro metric is honest partial with warnings; valuation-only freshness is failed', async () => {
  const partial = await collect({ fetchImpl: async (url) => new URL(url).searchParams.get('id') === 'DGS10'
    ? response(csv('DGS10', [{ date: '2026-11-06', value: 4.5 }])) : response('denied', 403) });
  assert.equal(partial.runStatus, 'partial');
  assert.equal(summarizeSnapshot(partial).fresh, 1);
  assert.equal(partial.lastSuccessfulAt, NOW.toISOString());
  assert.ok(partial.errors.length > 0);
  assert.equal(validateSnapshot(partial, NOW), partial);
  const valuationOnly = await collect({ fetchImpl: async (url) => url === EPS_URL ? response(multplEarnings()) : response('denied', 403) });
  assert.equal(summarizeSnapshot(valuationOnly).fresh, 1);
  assert.equal(valuationOnly.metrics.EPS_TTM.status, 'ok');
  assert.equal(valuationOnly.runStatus, 'failed');
  assert.equal(valuationOnly.lastSuccessfulAt, null);
});

test('snapshot validation rejects false envelopes, stale-ok mismatches and inconsistent freshness metadata', async () => {
  const partial = await collect();
  const failed = await collect({ fetchImpl: async () => response('denied', 403) });
  assert.throws(() => validateSnapshot({ ...failed, runStatus: 'ok', lastSuccessfulAt: NOW.toISOString() }, NOW), /runStatus/);
  assert.throws(() => validateSnapshot({ ...failed, runStatus: 'partial', lastSuccessfulAt: NOW.toISOString() }, NOW), /runStatus/);
  assert.throws(() => validateSnapshot({ ...partial, runStatus: 'ok' }, NOW), /runStatus/);
  assert.throws(() => validateSnapshot({ ...partial, runStatus: 'failed' }, NOW), /runStatus/);
  for (const mutate of [
    (copy) => { copy.metrics.UNRATE.maxAgeDays = 100; },
    (copy) => { copy.metrics.UNRATE.periodEnd = '2026-10-01'; },
    (copy) => { copy.metrics.EPS_TTM.periodEnd = '2026-09-30'; },
    (copy) => { copy.metrics.CORP_DEBT_GDP.inputs[0].observationDate = '2026-05-01'; },
    (copy) => { copy.metrics.UNRATE.status = 'stale'; },
    (copy) => { copy.metrics.UNRATE.fetchedAt = '2026-11-08T08:00:00Z'; },
    (copy) => { copy.collectionStartedAt = '2026-11-10T00:00:00Z'; },
    (copy) => { copy.errors = []; },
    (copy) => { copy.lastSuccessfulAt = '2026-11-08T08:00:00Z'; },
  ]) {
    const copy = structuredClone(partial);
    mutate(copy);
    assert.throws(() => validateSnapshot(copy, NOW));
  }
});
