import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  COMPANIES, METRIC_KEYS, secURL, filingURL, validDate, fetchPublic, quarterize,
  parseCompanyFacts, contiguousQuarterCount, validateEvidenceInput, parseDisclosures,
  collectAICompanies, freshCompanyIds, validateSnapshot, runCollector,
} from '../scripts/update-ai-companies.mjs';

// Synthetic fixtures stay in memory or an isolated OS temporary directory;
// NEVER use them to populate data/ai-company-daily.json or evidence input.
const NOW = new Date('2026-02-20T00:25:00.000Z');
const NVDA = COMPANIES.find((company) => company.id === 'NVDA');
const response = (value, status = 200) => new Response(typeof value === 'string' ? value : JSON.stringify(value), { status });
const accn = '0001045810-26-000001';
function row(start, end, value, options = {}) {
  return { start, end, val: value, fy: 2025, fp: 'Q3', filed: '2025-11-01', form: '10-Q', accn, ...options };
}
function quarterlyFacts(cik = NVDA.cik) {
  const periods = [
    ['2025-04-01', '2025-06-30', '2025-07-25'],
    ['2025-07-01', '2025-09-30', '2025-10-25'],
    ['2025-10-01', '2025-12-31', '2026-01-25'],
  ];
  const tags = {};
  for (const [tag, values] of Object.entries({ Revenues: [100, 120, 150], CostOfRevenue: [40, 50, 60], GrossProfit: [60, 70, 90], PaymentsToAcquirePropertyPlantAndEquipment: [10, 12, 15], NetCashProvidedByUsedInOperatingActivities: [20, 24, 30], InventoryNet: [5, 6, 7] })) {
    tags[tag] = { units: { USD: periods.map(([start, end, filed], index) => row(start, end, values[index], { filed })) } };
  }
  return { cik, facts: { 'us-gaap': tags } };
}
function raw(start, end, value, options = {}) {
  return { start, end, value, filed: '2025-11-01', fiscalYear: 2025, tag: 'us-gaap:Revenues', currency: 'USD', accession: accn, form: '10-Q', source: { name: 'Fixture SEC fact', url: filingURL(NVDA.cik, accn) }, ...options };
}
const ytd = () => [
  raw('2025-01-01', '2025-03-31', 100, { filed: '2025-04-25' }),
  raw('2025-01-01', '2025-06-30', 250, { filed: '2025-07-25' }),
  raw('2025-01-01', '2025-09-30', 450, { filed: '2025-10-25' }),
  raw('2025-01-01', '2025-12-31', 700, { filed: '2026-01-25', form: '10-K' }),
];
function fixtureFetch(url) {
  if (url.includes('companyfacts')) return Promise.resolve(response(quarterlyFacts(Number(url.match(/CIK(\d+)\.json/)[1]))));
  if (url.includes('wp-json')) return Promise.resolve(response([{ date_gmt: '2026-01-28T02:00:00', link: 'https://news.skhynix.com/fixture-earnings/', title: { rendered: 'Record earnings &amp; investment' } }]));
  return Promise.resolve(response('WAF denied', 403));
}
const collect = (options = {}) => collectAICompanies({ now: () => NOW, fetchImpl: fixtureFetch, ...options });

test('company coverage, HTTPS CIK and actual filing accession URLs', () => {
  assert.deepEqual(COMPANIES.map(({ id }) => id), ['NVDA', 'AMD', 'TSM', 'SAMSUNG', 'SKHYNIX', 'MU', 'MSFT', 'AMZN', 'GOOG', 'META']);
  assert.equal(secURL(2488), 'https://data.sec.gov/api/xbrl/companyfacts/CIK0000002488.json');
  assert.equal(filingURL(1045810, accn), 'https://www.sec.gov/Archives/edgar/data/1045810/000104581026000001/0001045810-26-000001-index.html');
  for (const value of ['2026-02-30', '2026-02-21', '2026-2-01', '2026-01-01T00:00:00Z']) assert.throws(() => validDate(value, NOW));
});

test('direct 80–105 day quarters align costs/margins/inventory and preserve provenance', () => {
  const company = parseCompanyFacts(quarterlyFacts(), NVDA, NOW);
  assert.equal(company.quarters.length, 3);
  assert.equal(contiguousQuarterCount(company.quarters), 3);
  assert.ok(company.quarters.every((quarter) => quarter.sourceBasis === 'original_period_disclosure_not_automatically_restated'));
  assert.equal(COMPANIES.find(({ id }) => id === 'AMD').name, '超威半导体（AMD）');
  const quarter = company.quarters.at(-1);
  assert.equal(quarter.end, '2025-12-31');
  assert.equal(quarter.metrics.grossMargin.value, 60);
  assert.equal(quarter.metrics.grossMargin.unit, '%');
  assert.equal(quarter.metrics.grossMargin.inputs.length, 3);
  assert.equal(quarter.metrics.inventory.period.start, quarter.end);
  for (const key of METRIC_KEYS) {
    const metric = quarter.metrics[key];
    assert.equal(metric.scope, 'company'); assert.equal(metric.currency, 'USD');
    assert.equal(metric.period.end, quarter.end); assert.ok(metric.filed >= quarter.end);
    assert.equal(metric.accession, accn); assert.match(metric.source.url, /sec\.gov\/Archives/);
  }
  assert.match(company.reason, /非AI收入/);
  assert.match(company.crossCheck.reason, /unverified_single_source/);
});

test('YTD differences require complete same-year/tag/currency declarations; Q4 = annual - 9m', () => {
  const quarters = quarterize(ytd());
  assert.deepEqual(quarters.map(({ value }) => value), [100, 150, 200, 250]);
  assert.equal(quarters[3].start, '2025-10-01');
  assert.equal(quarters[3].kind, 'derived');
  assert.equal(quarters[3].inputs[0].start, '2025-01-01');
  assert.equal(quarters[3].inputs[1].end, '2025-09-30');
  for (const mutation of [
    (rows) => rows.splice(0, 1),
    (rows) => rows.splice(1, 1),
    (rows) => { rows[1].fiscalYear = 2024; },
    (rows) => { rows[1].currency = 'TWD'; },
    (rows) => { rows[1].tag = 'us-gaap:AnotherRevenue'; },
    (rows) => { rows[1].start = '2025-01-02'; },
    (rows) => { rows[1].filed = '2026-02-01'; },
  ]) {
    const rows = ytd(); mutation(rows);
    assert.ok(!quarterize(rows).some((quarter) => quarter.end === '2025-12-31'));
  }
  assert.equal(quarterize([ytd()[3]]).length, 0);
});

test('direct quarter beats derived YTD even when the declared numbers differ', () => {
  const rows = [...ytd(), raw('2025-07-01', '2025-09-30', 199)];
  const quarter = quarterize(rows).find(({ end }) => end === '2025-09-30');
  assert.equal(quarter.value, 199); assert.equal(quarter.kind, 'observed');
});

test('YTD never leaks as a quarterly amount and trailing gaps stay visible', () => {
  const payload = quarterlyFacts();
  payload.facts['us-gaap'].Revenues.units.USD = [row('2025-01-01', '2025-09-30', 999)];
  assert.equal(parseCompanyFacts(payload, NVDA, NOW).quarters.length, 0);
  const quarters = [raw('2025-01-01', '2025-03-31', 1), raw('2025-07-01', '2025-09-30', 1), raw('2025-10-01', '2025-12-31', 1)];
  assert.equal(contiguousQuarterCount(quarters), 2);
});

test('missing/misaligned costs and currency mismatches cannot produce gross margin', () => {
  for (const change of [
    (facts) => { delete facts.CostOfRevenue; },
    (facts) => { facts.CostOfRevenue.units.USD.at(-1).start = '2025-10-02'; },
    (facts) => { facts.CostOfRevenue.units.TWD = facts.CostOfRevenue.units.USD; delete facts.CostOfRevenue.units.USD; },
    (facts) => { facts.CostOfRevenue.units.USD.at(-1).fy = 2024; },
  ]) {
    const payload = quarterlyFacts(); change(payload.facts['us-gaap']);
    const metrics = parseCompanyFacts(payload, NVDA, NOW).quarters.at(-1).metrics;
    assert.equal(metrics.costOfRevenue.value, null); assert.equal(metrics.grossMargin.value, null);
    assert.deepEqual(Object.keys(metrics), METRIC_KEYS);
  }
});

test('reported GrossProfit disagreement flags derived margin error, not independent verification', () => {
  const payload = quarterlyFacts(); payload.facts['us-gaap'].GrossProfit.units.USD.at(-1).val = 10;
  const company = parseCompanyFacts(payload, NVDA, NOW);
  assert.equal(company.quarters.at(-1).metrics.grossMargin.status, 'error');
  assert.equal(company.crossCheck.status, 'unavailable');
});

test('productive assets including intangibles remain a separate key, never fake PPE capex', () => {
  const payload = quarterlyFacts();
  payload.facts['us-gaap'].PaymentsToAcquireProductiveAssets = payload.facts['us-gaap'].PaymentsToAcquirePropertyPlantAndEquipment;
  delete payload.facts['us-gaap'].PaymentsToAcquirePropertyPlantAndEquipment;
  const metrics = parseCompanyFacts(payload, NVDA, NOW).quarters.at(-1).metrics;
  assert.equal(metrics.capex.value, null);
  assert.equal(metrics.capitalInvestmentIncludingIntangibles.value, 15);
  assert.equal(metrics.capitalInvestmentIncludingIntangibles.tag, 'us-gaap:PaymentsToAcquireProductiveAssets');
});

test('invalid/future periods, filed-before-end and later comparatives are rejected', () => {
  for (const change of [
    (row) => { row.end = '2027-01-01'; },
    (row) => { row.filed = '2027-01-25'; },
    (row) => { row.filed = '2025-12-01'; },
    (row) => { row.filed = row.end; },
    (row) => { row.start = '2025-11-01'; },
    (row) => { row.val = NaN; },
    (row) => { row.accn = 'made-up'; },
    (row) => { row.form = '8-K'; },
  ]) {
    const payload = quarterlyFacts(); change(payload.facts['us-gaap'].Revenues.units.USD.at(-1));
    assert.equal(parseCompanyFacts(payload, NVDA, NOW).quarters.length, 2);
  }
  const payload = quarterlyFacts();
  const original = payload.facts['us-gaap'].Revenues.units.USD[0];
  payload.facts['us-gaap'].Revenues.units.USD.push({ ...original, val: 999, filed: '2026-01-25', fy: 2026 });
  assert.equal(parseCompanyFacts(payload, NVDA, NOW).quarters[0].metrics.revenue.value, 100);
  assert.throws(() => parseCompanyFacts({ ...payload, cik: 123 }, NVDA, NOW), /CIK/);
});

test('TSM annual IFRS facts stay stale metadata and never appear in quarters', () => {
  const company = COMPANIES.find(({ id }) => id === 'TSM');
  const payload = { cik: company.cik, facts: { 'ifrs-full': { Revenue: { units: { TWD: [row('2024-01-01', '2024-12-31', 10, { form: '20-F', filed: '2025-04-17' })] } } } } };
  const parsed = parseCompanyFacts(payload, company, NOW);
  assert.equal(parsed.status, 'stale'); assert.deepEqual(parsed.quarters, []);
  assert.match(parsed.reason, /2024-12-31/); assert.match(parsed.reason, /年报不充当季度/);
});

test('latest 8 actual quarter periods, noncalendar starts and 200-day staleness', () => {
  const payload = quarterlyFacts();
  payload.facts['us-gaap'].Revenues.units.USD = Array.from({ length: 12 }, (_, i) => {
    const start = new Date(Date.UTC(2023 + Math.floor(i / 4), i % 4 * 3, 1)).toISOString().slice(0, 10);
    const end = new Date(Date.UTC(2023 + Math.floor(i / 4), i % 4 * 3 + 3, 0)).toISOString().slice(0, 10);
    return row(start, end, 100, { filed: new Date(Date.parse(end) + 25 * 86_400_000).toISOString().slice(0, 10), fy: 2023 + Math.floor(i / 4) });
  });
  assert.equal(parseCompanyFacts(payload, NVDA, NOW).quarters.length, 8);
  assert.equal(parseCompanyFacts(payload, NVDA, new Date('2026-08-01T00:25:00Z')).status, 'stale');
  assert.equal(quarterize([raw('2025-07-28', '2025-10-26', 1)]).length, 1);
});

function evidenceRecord() {
  return { id: 'test-only', group: 'orders', companyId: 'NVDA', chainId: 'test-chain', periodStart: '2025-10-01', periodEnd: '2025-12-31', publishedAt: '2026-01-25T00:00:00Z', reviewedAt: '2026-01-26T00:00:00Z', reviewed: true, kind: 'direct', scope: 'AI', direction: 'stable', sources: [
    { name: 'Test official citation', url: 'https://example.org/test-only', publisher: 'Test issuer', type: 'official' },
    { name: 'Test independent citation', url: 'https://example.net/test-only', publisher: 'Test independent publisher', type: 'independent' },
  ], summary: 'Test-only reviewed record', metric: 'newOrders', value: 5, baseline: 5, unit: 'units', normalizationReviewed: true, confounders: [], procurementSide: 'supplier' };
}

test('real evidence schema preserves date-only/UTC stamps and explicit confounder decisions', () => {
  for (const [publishedAt, reviewedAt] of [
    ['2026-01-25', '2026-01-26'],
    ['2026-01-25T12:30:00Z', '2026-01-26T00:00:00.123Z'],
    ['2026-01-25', '2026-01-25T12:30:00.1Z'],
    ['2026-01-25T12:30:00.123456Z', '2026-01-26'],
  ]) {
    for (const confounders of [[], [{ name: 'Product mix', cleared: true }], [{ reason: 'Transition reconciled by reviewer', cleared: true }], [{ name: 'Export restriction', cleared: false }]]) {
      const record = { ...evidenceRecord(), publishedAt, reviewedAt, confounders };
      const before = structuredClone(record);
      const imported = validateEvidenceInput({ schemaVersion: 1, records: [record] }, NOW);
      assert.deepEqual(imported, [before]); assert.deepEqual(record, before);
      assert.notEqual(imported[0], record);
      if (confounders.length) assert.notEqual(imported[0].confounders[0], confounders[0]);
    }
  }
});

test('evidence publication must follow the complete period-end day; review is never fabricated', () => {
  const record = { ...evidenceRecord(), publishedAt: '2026-01-01', reviewedAt: '2026-01-01' };
  assert.deepEqual(validateEvidenceInput({ schemaVersion: 1, records: [record] }, NOW), [record]);
  for (const change of [
    { publishedAt: '2025-12-31' }, { publishedAt: '2025-12-31T23:59:59.999Z' },
    { publishedAt: '2026-01-25T12:00:00Z', reviewedAt: '2026-01-25' },
    { reviewedAt: undefined }, { reviewedAt: '2026-02-21' },
    { publishedAt: '2026-02-30' }, { reviewedAt: '2026-02-30T00:00:00Z' },
    { reviewedAt: '2026-01-26T24:00:00Z' }, { reviewedAt: '2026-01-26T00:60:00Z' },
    { publishedAt: '2026-01-25T00:00:00+00:00' },
    { periodStart: '2025-01-01' }, { periodStart: '2025-12-01' },
  ]) assert.throws(() => validateEvidenceInput({ schemaVersion: 1, records: [{ ...record, ...change }] }, NOW));
});

test('confounders require named objects with boolean cleared, never string-based clearance guesses', () => {
  for (const confounders of [undefined, null, ['cleared'], ['No confounders'], [null], [[]], [{}], [{ name: 'Product mix' }], [{ name: 'Product mix', cleared: 'true' }], [{ name: 'Product mix', cleared: 1 }], [{ name: ' ', cleared: true }]]) {
    assert.throws(() => validateEvidenceInput({ schemaVersion: 1, records: [{ ...evidenceRecord(), confounders }] }, NOW), /confounders/);
  }
});

test('evidence requires distinct HTTPS publishers/hosts and explicit official + independent source codes', () => {
  for (const mutate of [
    (sources) => sources.pop(),
    (sources) => { delete sources[0].type; },
    (sources) => { sources[0].type = 'SEC'; },
    (sources) => { sources[1].type = 'secondary'; },
    (sources) => { sources[1].type = 'official'; },
    (sources) => { sources[0].type = 'independent'; },
    (sources) => { sources[1].publisher = '  TEST ISSUER  '; },
    (sources) => { sources[1].url = 'https://www.example.org/another-page'; },
    (sources) => { sources[1].status = 'error'; },
    (sources) => { sources[1].url = undefined; },
    (sources) => { sources[1].url = ' https://example.net/test-only'; },
    (sources) => { sources[1].publisher = ''; },
  ]) {
    const record = evidenceRecord(); mutate(record.sources);
    assert.throws(() => validateEvidenceInput({ schemaVersion: 1, records: [record] }, NOW));
  }
});

test('application maturity requires a genuine deployment date and explicit 2–8-quarter window', () => {
  const record = { ...evidenceRecord(), group: 'application', metric: 'aiRevenue', unit: 'USD', deploymentDate: '2024-01-01', evaluationWindowQuarters: 8 };
  assert.deepEqual(validateEvidenceInput({ schemaVersion: 1, records: [record] }, NOW), [record]);
  for (const change of [
    { deploymentDate: undefined }, { deploymentDate: '2025-12-31' }, { deploymentDate: '2026-01-01' },
    { deploymentDate: '2024-02-30' }, { evaluationWindowQuarters: undefined },
    { evaluationWindowQuarters: 0 }, { evaluationWindowQuarters: 1 }, { evaluationWindowQuarters: 9 },
    { evaluationWindowQuarters: 2.5 }, { evaluationWindowQuarters: '2' },
  ]) assert.throws(() => validateEvidenceInput({ schemaVersion: 1, records: [{ ...record, ...change }] }, NOW));
  const edge = { ...record, deploymentDate: '2025-07-04', evaluationWindowQuarters: 2 };
  assert.deepEqual(validateEvidenceInput({ schemaVersion: 1, records: [edge] }, NOW), [edge]);
  assert.throws(() => validateEvidenceInput({ schemaVersion: 1, records: [{ ...edge, deploymentDate: '2025-07-05' }] }, NOW));
});

test('reviewed evidence is imported unchanged; no generation or low-level direction inference', () => {
  const input = { schemaVersion: 1, records: [evidenceRecord()] };
  assert.deepEqual(validateEvidenceInput(input, NOW), input.records);
  assert.deepEqual(validateEvidenceInput({ schemaVersion: 1, records: [] }, NOW), []);
  for (const mutate of [
    (record) => { delete record.direction; },
    (record) => { record.reviewed = false; },
    (record) => { record.scope = 'company'; },
    (record) => { record.kind = 'derived'; },
    (record) => { record.value = Infinity; },
    (record) => { record.periodEnd = '2026-02-21'; },
    (record) => { record.publishedAt = '2025-12-01T00:00:00Z'; },
    (record) => { record.reviewedAt = '2026-01-24T00:00:00Z'; },
    (record) => { record.sources = []; },
    (record) => { record.sources[0].url = 'http://example.org'; },
    (record) => { record.sources[0].url = 'https://secret:password@example.org'; },
    (record) => { delete record.sources[0].publisher; },
    (record) => { record.companyId = 'UNKNOWN'; },
    (record) => { record.normalizationReviewed = 'yes'; },
    (record) => { record.evaluationWindowQuarters = 1.5; },
    (record) => { record.procurementSide = 'other'; },
  ]) {
    const record = evidenceRecord(); mutate(record);
    assert.throws(() => validateEvidenceInput({ schemaVersion: 1, records: [record] }, NOW));
  }
  assert.throws(() => validateEvidenceInput({ schemaVersion: 2, records: [] }, NOW));
  assert.throws(() => validateEvidenceInput({ schemaVersion: 1, records: [evidenceRecord(), evidenceRecord()] }, NOW));
});

test('news metadata is disclosure only regardless of positive/negative title and future dates', () => {
  const posts = [{ date_gmt: '2026-01-28T02:00:00', link: 'https://news.skhynix.com/earnings/', title: { rendered: '<b>Record profits</b> &amp; collapsing orders' } }];
  const disclosures = parseDisclosures(posts, NOW);
  assert.equal(disclosures[0].title, 'Record profits & collapsing orders');
  assert.equal(disclosures[0].publishedAt, '2026-01-28T02:00:00Z');
  assert.equal(disclosures[0].direction, undefined);
  assert.deepEqual(parseDisclosures([{ ...posts[0], date_gmt: '2027-01-01T00:00:00' }], NOW), []);
});

test('bounded collection uses 8 SEC + 1 newsroom + 2 independent probes without WAF retries', async () => {
  const tried = [];
  const snapshot = await collect({ fetchImpl: (url, options) => { tried.push(url); return fixtureFetch(url, options); } });
  assert.equal(tried.length, 11); assert.equal(new Set(tried).size, 11);
  assert.equal(snapshot.runStatus, 'partial'); assert.equal(snapshot.lastSuccessfulAt, NOW.toISOString());
  assert.deepEqual(freshCompanyIds(snapshot), ['NVDA', 'AMD', 'MU', 'MSFT', 'AMZN', 'GOOG', 'META']);
  assert.equal(snapshot.companies.find(({ id }) => id === 'SAMSUNG').status, 'unavailable');
  const sk = snapshot.companies.find(({ id }) => id === 'SKHYNIX');
  assert.equal(sk.status, 'unavailable'); assert.equal(sk.disclosures.length, 1);
  assert.deepEqual(snapshot.evidence, []);
  for (const company of snapshot.companies) assert.equal(company.crossCheck.status, 'unavailable');
  assert.match(snapshot.companies[0].crossCheck.reason, /HTTP 403/);
  assert.equal(validateSnapshot(snapshot, NOW), snapshot);
});

test('unsupported precise secondary parsing is explicit even for HTTP 200', async () => {
  const snapshot = await collect({ fetchImpl: (url) => url.includes('stockanalysis.com') ? Promise.resolve(response('<html>Revenue 999</html>')) : fixtureFetch(url) });
  assert.match(snapshot.companies[0].crossCheck.reason, /HTTP 200.*未支持/);
  assert.equal(snapshot.companies[0].quarters.at(-1).metrics.revenue.value, 150);
});

test('all-source failures retain prior real quarters and fetchedAt but are not fresh', async () => {
  const previous = await collect({ now: () => new Date('2026-02-19T00:25:00Z') });
  const snapshot = await collect({ previous, fetchImpl: async () => response('denied', 403) });
  assert.equal(snapshot.runStatus, 'failed'); assert.deepEqual(freshCompanyIds(snapshot), []);
  assert.equal(snapshot.lastSuccessfulAt, previous.lastSuccessfulAt);
  const company = snapshot.companies[0];
  assert.equal(company.fetchedAt, previous.companies[0].fetchedAt);
  assert.equal(company.status, 'error');
  assert.equal(company.quarters.at(-1).metrics.revenue.value, 150);
  assert.equal(company.quarters.at(-1).metrics.revenue.status, 'error');
  assert.equal(company.quarters.at(-1).end, '2025-12-31');
});

test('partial collection preserves only failed company timestamps; invalid prior data rejected', async () => {
  const previous = await collect({ now: () => new Date('2026-02-19T00:25:00Z') });
  const failNVDA = async (url) => url === secURL(NVDA.cik) ? response('denied', 403) : fixtureFetch(url);
  const partial = await collect({ previous, fetchImpl: failNVDA });
  assert.equal(partial.runStatus, 'partial'); assert.equal(partial.companies[0].fetchedAt, previous.companies[0].fetchedAt);
  assert.equal(partial.companies[1].fetchedAt, NOW.toISOString());
  previous.companies[0].quarters.at(-1).metrics.revenue.value = NaN;
  const snapshot = await collect({ previous, fetchImpl: failNVDA });
  assert.deepEqual(snapshot.companies[0].quarters, []); assert.equal(snapshot.companies[0].fetchedAt, null);
});

test('stale-only and news-only are failed, not fresh; invalid reviewed input yields no evidence', async () => {
  const stale = await collect({ now: () => new Date('2026-12-01T00:25:00Z') });
  assert.equal(stale.runStatus, 'failed'); assert.equal(stale.lastSuccessfulAt, null);
  assert.deepEqual(freshCompanyIds(stale), []);
  const newsOnly = await collect({ fetchImpl: async (url) => url.includes('wp-json') ? fixtureFetch(url) : response('denied', 403) });
  assert.equal(newsOnly.runStatus, 'failed');
  const bad = evidenceRecord(); delete bad.direction;
  const invalid = await collect({ evidenceInput: { schemaVersion: 1, records: [bad] } });
  assert.deepEqual(invalid.evidence, []); assert.ok(invalid.errors.some(({ stage }) => stage === 'evidence'));
});

test('snapshot validates complete keys, periods, units, provenance and honest freshness envelopes', async () => {
  const snapshot = await collect();
  for (const mutate of [
    (copy) => { delete copy.companies[0].quarters[0].metrics.inventory; },
    (copy) => { copy.companies[0].quarters[0].metrics.revenue.value = NaN; },
    (copy) => { copy.companies[0].quarters[0].metrics.costOfRevenue.currency = 'TWD'; },
    (copy) => { copy.companies[0].quarters[0].end = '2027-01-01'; },
    (copy) => { copy.companies[0].quarters[0].start = '2025-01-01'; },
    (copy) => { copy.companies[0].quarters[0].metrics.grossMargin.inputs = []; },
    (copy) => { copy.companies[0].fetchedAt = '2027-01-01T00:00:00Z'; },
    (copy) => { copy.companies[0].source.url = 'https://password:secret@example.org'; },
    (copy) => { copy.runStatus = 'ok'; },
    (copy) => { copy.runStatus = 'failed'; },
    (copy) => { copy.lastSuccessfulAt = null; },
    (copy) => { copy.companies.pop(); },
  ]) {
    const copy = structuredClone(snapshot); mutate(copy); assert.throws(() => validateSnapshot(copy, NOW));
  }
});

test('native fetch enforces TLS/HTTPS, one attempt on 403, and a real abort timeout', async () => {
  let count = 0;
  await assert.rejects(fetchPublic('https://example.org', { fetchImpl: async () => { count++; return response('denied', 403); } }), /HTTP 403/);
  assert.equal(count, 1);
  await assert.rejects(fetchPublic('http://example.org'), /HTTPS/);
  await assert.rejects(fetchPublic('https://example.org', { timeoutMs: 0 }), /timeout/);
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout not enforced')), 500);
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
  await assert.rejects(fetchPublic('https://example.org', { timeoutMs: 10, fetchImpl }), /timeout|timed out/i);
  const code = await readFile(new URL('../scripts/update-ai-companies.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(code, /NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]0['"]|rejectUnauthorized\s*:\s*false/);
  assert.match(code, /fetchImpl !== fetch \|\| process\.env\.NODE_TLS_REJECT_UNAUTHORIZED !== '0'/);
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    // Inherit the host setting; never disable TLS in a test or issue a request.
    const originalFetch = globalThis.fetch;
    let requests = 0;
    globalThis.fetch = async () => { requests++; return response('must not fetch'); };
    try { await assert.rejects(fetchPublic('https://example.org'), /TLS verification disabled/); }
    finally { globalThis.fetch = originalFetch; }
    assert.equal(requests, 0);
  }
});

test('first-run all-source failure writes failed diagnostics, not fixture data or false success', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ai-company-test-'));
  try {
    const outputPath = join(directory, 'daily.json'), inputPath = join(directory, 'reviewed.json');
    await writeFile(inputPath, JSON.stringify({ schemaVersion: 1, records: [] }));
    const snapshot = await runCollector({ outputPath, inputPath, now: () => NOW, fetchImpl: async () => response('denied', 403) });
    const output = JSON.parse(await readFile(outputPath, 'utf8'));
    assert.deepEqual(output, snapshot); assert.equal(output.runStatus, 'failed');
    assert.equal(output.lastSuccessfulAt, null); assert.equal(output.companies.length, 10);
    assert.ok(output.companies.every(({ quarters, fetchedAt }) => !quarters.length && fetchedAt === null));
    assert.ok(output.errors.length > 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('SEC calendar frames must match real periods; fiscal quarter labels are not calendar dates', () => {
  const payload = quarterlyFacts();
  payload.facts['us-gaap'].Revenues.units.USD.at(-1).frame = 'CY2024Q4';
  assert.equal(parseCompanyFacts(payload, NVDA, NOW).quarters.length, 2);
  payload.facts['us-gaap'].Revenues.units.USD.at(-1).frame = 'CY2025Q4';
  assert.equal(parseCompanyFacts(payload, NVDA, NOW).quarters.length, 3);
  payload.facts['us-gaap'].Revenues.units.USD.at(-1).fp = 'Q1';
  assert.equal(parseCompanyFacts(payload, NVDA, NOW).quarters.at(-1).end, '2025-12-31');
});

test('nested YTD inputs retain continuity and validators reject altered subtraction or gross margins', async () => {
  const payload = quarterlyFacts();
  for (const [tag, multiplier] of [['Revenues', 1], ['CostOfRevenue', 0.4], ['GrossProfit', 0.6]]) {
    payload.facts['us-gaap'][tag].units.USD = ytd().map((fact) => row(fact.start, fact.end, fact.value * multiplier, { filed: fact.filed, form: fact.form }));
  }
  const snapshot = await collect({ fetchImpl: (url) => url === secURL(NVDA.cik) ? Promise.resolve(response(payload)) : fixtureFetch(url) });
  const latest = snapshot.companies[0].quarters.at(-1);
  assert.equal(latest.metrics.revenue.kind, 'derived');
  assert.equal(latest.metrics.revenue.inputs.length, 4);
  assert.equal(latest.metrics.grossMargin.inputs[0].inputs.length, 4);
  assert.equal(validateSnapshot(snapshot, NOW), snapshot);
  for (const mutate of [
    (copy) => { copy.companies[0].quarters.at(-1).metrics.revenue.value += 1; },
    (copy) => { copy.companies[0].quarters.at(-1).metrics.revenue.inputs.pop(); },
    (copy) => { copy.companies[0].quarters.at(-1).metrics.grossMargin.value += 1; },
    (copy) => { copy.companies[0].quarters.at(-1).metrics.grossMargin.inputs[0].inputs.pop(); },
    (copy) => { copy.companies[0].fetchedAt = '2025-12-31T00:00:00Z'; },
  ]) {
    const copy = structuredClone(snapshot); mutate(copy); assert.throws(() => validateSnapshot(copy, NOW));
  }
});

test('original quarter + CFO YTD + reported GrossProfit survive collection and JSON without dropped inputs', async () => {
  const payload = quarterlyFacts(), original = structuredClone(payload);
  payload.facts['us-gaap'].NetCashProvidedByUsedInOperatingActivities.units.USD = ytd().map((fact) => row(fact.start, fact.end, fact.value, { filed: fact.filed, form: fact.form }));
  const record = { ...evidenceRecord(), publishedAt: '2026-01-25', reviewedAt: '2026-01-26', confounders: [{ name: 'Product mix', cleared: true }] };
  const input = { schemaVersion: 1, records: [record] };
  const before = structuredClone(payload);
  const snapshot = await collect({ evidenceInput: input, fetchImpl: (url) => url === secURL(NVDA.cik) ? Promise.resolve(response(payload)) : fixtureFetch(url) });
  assert.deepEqual(payload, before); assert.deepEqual(input.records, [record]);
  assert.deepEqual(snapshot.evidence, [record]);
  const serialized = JSON.parse(JSON.stringify(snapshot)), latest = serialized.companies[0].quarters.at(-1);
  assert.equal(latest.metrics.revenue.kind, 'observed');
  assert.equal(latest.metrics.revenue.value, original.facts['us-gaap'].Revenues.units.USD.at(-1).val);
  const margin = latest.metrics.grossMargin;
  assert.equal(margin.inputs.length, 3);
  assert.deepEqual(margin.inputs.map(({ tag, value }) => [tag, value]), [['us-gaap:Revenues', 150], ['us-gaap:CostOfRevenue', 60], ['us-gaap:GrossProfit', 90]]);
  assert.ok(margin.inputs.every((fact) => fact.filed === '2026-01-25' && fact.accession === accn && fact.source.url === filingURL(NVDA.cik, accn)));
  const cfo = latest.metrics.operatingCashFlow;
  assert.equal(cfo.kind, 'derived'); assert.equal(cfo.value, 250); assert.equal(cfo.inputs.length, 4);
  assert.deepEqual(cfo.inputs.map(({ start, end, value }) => [start, end, value]), ytd().slice().reverse().map(({ start, end, value }) => [start, end, value]));
  assert.ok(cfo.inputs.every((fact) => fact.tag === 'us-gaap:NetCashProvidedByUsedInOperatingActivities' && fact.accession === accn && fact.source.url === filingURL(NVDA.cik, accn)));
  assert.equal(latest.sourceBasis, 'original_period_disclosure_not_automatically_restated');
  assert.equal(serialized.companies[0].crossCheck.status, 'unavailable');
  assert.equal(validateSnapshot(serialized, NOW), serialized);
  const lateReview = structuredClone(serialized);
  lateReview.evidence[0].reviewedAt = '2026-02-20T00:26:00Z';
  assert.throws(() => validateSnapshot(lateReview, new Date('2026-02-20T01:00:00Z')), /future timestamp/);
  for (const sourceBasis of [undefined, 'latest_restated']) {
    const copy = structuredClone(serialized); copy.companies[0].quarters.at(-1).sourceBasis = sourceBasis;
    assert.throws(() => validateSnapshot(copy, NOW), /source basis/);
  }
});

test('production evidence input is empty, explicit and never populated from synthetic fixtures', async () => {
  const input = JSON.parse(await readFile(new URL('../data/ai-evidence-input.json', import.meta.url), 'utf8'));
  assert.equal(input.schemaVersion, 1); assert.deepEqual(input.records, []);
  assert.equal(input.notice, '仅接收人工核验的AI专项证据；未披露不等于零；不得填入模型推断或生产测试夹具。');
});

test('P1-3: restated facts keep the latest filing and mark the period as restated', () => {
  const payload = quarterlyFacts();
  const originalAccn = '0001045810-26-000001', amendmentAccn = '0001045810-26-000002';
  // The original Q3 revenue filing (filed 2026-01-25, value 150) is already in quarterlyFacts.
  // Add a later 10-Q/A amendment with a different value for the same period.
  const revenueRows = payload.facts['us-gaap'].Revenues.units.USD;
  revenueRows.push({ start: '2025-10-01', end: '2025-12-31', val: 155, fy: 2025, fp: 'Q3',
    filed: '2026-02-10', form: '10-Q/A', accn: amendmentAccn });
  // Also add a matching cost amendment so grossMargin derivation stays consistent.
  payload.facts['us-gaap'].CostOfRevenue.units.USD.push(
    { start: '2025-10-01', end: '2025-12-31', val: 62, fy: 2025, fp: 'Q3', filed: '2026-02-10', form: '10-Q/A', accn: amendmentAccn });
  payload.facts['us-gaap'].GrossProfit.units.USD.push(
    { start: '2025-10-01', end: '2025-12-31', val: 93, fy: 2025, fp: 'Q3', filed: '2026-02-10', form: '10-Q/A', accn: amendmentAccn });
  const company = parseCompanyFacts(payload, NVDA, NOW);
  const latest = company.quarters.at(-1);
  // Latest filing wins: the restated revenue should be 155, not the original 150.
  assert.equal(latest.metrics.revenue.value, 155);
  assert.equal(latest.metrics.revenue.accession, amendmentAccn);
  assert.equal(latest.metrics.revenue.filed, '2026-02-10');
  // The restated flag should be set on the revenue fact.
  assert.equal(latest.metrics.revenue.restated, true);
  // GrossMargin derivation uses the restated inputs.
  assert.equal(latest.metrics.grossMargin.status, 'ok');
  assert.ok(Math.abs(latest.metrics.grossMargin.value - (155 - 62) / 155 * 100) < 1e-6);
});
