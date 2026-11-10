import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {COMPANIES, parseCompanyFacts, filingURL} from '../scripts/update-ai-companies.mjs';
const require = createRequire(import.meta.url);
const ai = require('../js/ai-realization.js');
const NOW = '2026-07-02T12:00:00Z', GENERATED = '2026-07-02T10:00:00Z';
const periods = [['2026-01-01', '2026-03-31'], ['2026-04-01', '2026-06-30']];
const clone = s => structuredClone(s);
function fixture(deteriorating = ['application', 'orders', 'profit']) {
  const evidence = [];
  for (const [group, people, metric] of [
    ['application', [['MSFT', 'a'], ['GOOG', 'b']], 'aiRevenue'],
    ['orders', [['MSFT', 'a', 'buyer'], ['NVDA', 'a', 'supplier'], ['GOOG', 'b', 'buyer'], ['AMD', 'b', 'supplier']], 'newOrders'],
    ['profit', [['NVDA', 'a'], ['AMD', 'b']], 'normalizedGrossMargin']
  ]) for (const [companyId, chainId, procurementSide] of people) for (const [periodStart, periodEnd] of periods) {
    const direction = deteriorating.includes(group) ? 'deteriorating' : 'stable';
    evidence.push({id: `${group}-${companyId}-${periodEnd}`, group, companyId, chainId, periodStart, periodEnd,
      publishedAt: GENERATED, reviewedAt: GENERATED, reviewed: true, kind: 'direct', scope: 'AI', direction,
      sources: [{name: 'Fixture official', url: `https://${companyId.toLowerCase()}.example.org/${group}/${periodEnd}`, publisher: companyId, type: 'official'},
        {name: 'Fixture independent', url: `https://research.example.net/${group}/${companyId}/${periodEnd}`, publisher: 'Independent research', type: 'independent'}],
      summary: 'Test-only reviewed AI disclosure, not production evidence', metric,
      value: group === 'profit' ? direction === 'stable' ? 60 : 55 : direction === 'stable' ? 100 : 80,
      baseline: group === 'profit' ? 60 : 100, unit: group === 'profit' ? '%' : group === 'orders' ? 'count' : 'USD',
      normalizationReviewed: true, confounders: [],
      ...(group === 'application' ? {deploymentDate: '2024-01-01', evaluationWindowQuarters: 4} : {}),
      ...(procurementSide ? {procurementSide} : {})});
  }
  return {schemaVersion: 1, generatedAt: GENERATED, lastSuccessfulAt: GENERATED, runStatus: 'ok', companies: [], evidence, errors: []};
}
const state = s => ai.compute(s, {now: NOW});
const insufficient = s => { const result = state(s); assert.equal(result.score, null); assert.equal(result.level, 'insufficient'); assert.equal(result.coverage, 0); return result; };
function metric(value, id, currency = 'USD') {
  return {value, unit: id === 'grossMargin' ? '%' : currency, currency, kind: 'observed', scope: 'company', status: 'ok', source: {name: 'Company report', url: 'https://investor.example.org/report'}, tag: id};
}
function companyFixture(currency = 'USD') {
  const s = fixture(); s.evidence = [];
  s.companies = [{id: 'NVDA', name: 'NVIDIA', role: 'designer', status: 'ok', fetchedAt: GENERATED,
    source: {name: 'Company filings', url: 'https://investor.example.org/'}, crossCheck: {status: 'verified', reason: 'Fixture manual crosscheck'},
    quarters: [['2025-07-01', '2025-09-30'], ['2025-10-01', '2025-12-31'], ...periods].map(([start, end], i) => ({start, end, filed: GENERATED,
      metrics: Object.fromEntries(Object.entries({revenue: 1e9, costOfRevenue: 4e8, grossMargin: 60 - i * 2, inventory: (2 + i) * 1e8, capex: 1e8, operatingCashFlow: 1e8}).map(([id, value]) => [id, metric(value, id, currency)]))}))}];
  return s;
}

test('browser and CommonJS expose the same pure API without network requests', () => {
  const context = vm.createContext({window: {}, URL, Date, console, setTimeout, clearTimeout});
  vm.runInContext(readFileSync(new URL('../js/ai-realization.js', import.meta.url), 'utf8'), context);
  assert.equal(typeof context.window.AiRealization.compute, 'function');
  assert.deepEqual(JSON.parse(JSON.stringify(context.window.AiRealization.compute(fixture(), {now: NOW}))), state(fixture()));
  const input = fixture(), before = clone(input); state(input); assert.deepEqual(input, before);
});
for (const [groups, expected] of [[[], 0], [['application'], 35], [['application', 'orders'], 65], [['application', 'orders', 'profit'], 85]]) {
  test(`complete independent two-quarter chain produces ${expected}, including stable zero`, () => {
    const result = state(fixture(groups)); assert.equal(result.score, expected); assert.equal(result.coverage, 1); assert.equal(result.evidenceCoverage, 1);
    assert.ok(result.groups.every(g => g.sufficient && g.chainCount === 2));
  });
}
test('new stable/improving evidence automatically downgrades sustained pressure', () => {
  const s = fixture(); assert.equal(state(s).score, 85);
  for (const r of s.evidence.filter(r => r.periodEnd === '2026-06-30')) { r.direction = 'improving'; r.value = r.group === 'profit' ? 65 : 120; }
  assert.equal(state(s).score, 0); assert.equal(state(s).level, 'low');
});
for (const [name, mutate] of [
  ['missing application', s => { s.evidence = s.evidence.filter(r => r.group !== 'application'); }],
  ['proxy', s => { s.evidence.forEach(r => { r.kind = 'proxy'; }); }],
  ['assumption', s => { s.evidence.forEach(r => { r.kind = 'assumption'; }); }],
  ['one quarter', s => { s.evidence = s.evidence.filter(r => r.periodEnd === '2026-06-30'); }],
  ['one chain', s => { s.evidence.forEach(r => { r.chainId = 'a'; }); }],
  ['one company', s => { s.evidence = s.evidence.filter(r => r.companyId === 'MSFT'); }],
  ['supplier missing', s => { s.evidence = s.evidence.filter(r => r.procurementSide !== 'supplier'); }],
  ['buyer missing', s => { s.evidence = s.evidence.filter(r => r.procurementSide !== 'buyer'); }],
  ['unreviewed', s => { s.evidence.forEach(r => { r.reviewed = false; }); }],
  ['future review', s => { s.evidence.forEach(r => { r.reviewedAt = '2027-01-01'; }); }],
  ['review precedes publication', s => { s.evidence.forEach(r => { r.reviewedAt = '2026-07-01'; }); }],
  ['future generated', s => { s.generatedAt = '2027-07-02T10:00:00Z'; }],
  ['failed run', s => { s.runStatus = 'failed'; }],
  ['normalization missing', s => { s.evidence.forEach(r => { r.normalizationReviewed = false; }); }],
  ['confounder unresolved', s => { s.evidence.filter(r => r.group === 'profit').forEach(r => { r.confounders = [{name: 'Blackwell transition', cleared: false}]; }); }],
  ['bare GAAP gross margin', s => { s.evidence.filter(r => r.group === 'profit').forEach(r => { r.metric = 'grossMargin'; }); }],
  ['missing deployment', s => { s.evidence.filter(r => r.group === 'application').forEach(r => { delete r.deploymentDate; }); }],
  ['immature deployment', s => { s.evidence.filter(r => r.group === 'application').forEach(r => { r.deploymentDate = '2026-01-01'; }); }],
  ['window missing', s => { s.evidence.filter(r => r.group === 'application').forEach(r => { delete r.evaluationWindowQuarters; }); }],
  ['window over 8', s => { s.evidence.filter(r => r.group === 'application').forEach(r => { r.evaluationWindowQuarters = 9; }); }],
  ['window under 2', s => { s.evidence.filter(r => r.group === 'application').forEach(r => { r.evaluationWindowQuarters = 1; }); }],
  ['window noninteger', s => { s.evidence.filter(r => r.group === 'application').forEach(r => { r.evaluationWindowQuarters = 2.5; }); }],
  ['direction numeric mismatch', s => { s.evidence.forEach(r => { r.value = r.baseline; }); }],
  ['unit missing', s => { s.evidence.forEach(r => { r.unit = ''; }); }],
  ['zero baseline', s => { s.evidence.forEach(r => { r.baseline = 0; }); }],
  ['same publisher', s => { s.evidence.forEach(r => { r.sources[1].publisher = r.sources[0].publisher; }); }],
  ['same host disguised independent', s => { s.evidence.forEach(r => { r.sources[1].url = r.sources[0].url; }); }],
  ['unsafe source', s => { s.evidence.forEach(r => { r.sources[1].url = 'javascript:alert(1)'; }); }],
  ['unknown company', s => { s.evidence.forEach(r => { r.companyId = 'UNKNOWN'; }); }],
  ['annual instead of quarter', s => { s.evidence.forEach(r => { r.periodStart = '2025-07-01'; }); }],
  ['invalid real date', s => { s.evidence.forEach(r => { r.periodEnd = '2026-02-30'; }); }]
]) test(`${name} remains null, never red/high`, () => { const s = fixture(); mutate(s); insufficient(s); });
test('stale evidence cannot be refreshed merely by a new generatedAt', () => {
  const s = fixture(); s.generatedAt = s.lastSuccessfulAt = '2027-02-01T10:00:00Z';
  const result = ai.compute(s, {now: s.generatedAt}); assert.equal(result.score, null); assert.ok(result.diagnostics.some(d => /200天/.test(d.reason)));
});
test('future period and mismatched or disconnected quarters cannot count', () => {
  for (const patch of [{periodStart: '2026-07-01', periodEnd: '2026-09-30'}, {periodStart: '2026-03-01', periodEnd: '2026-05-31'}]) {
    const s = fixture(); s.evidence.filter(r => r.periodEnd === '2026-06-30').forEach(r => Object.assign(r, patch)); insufficient(s);
  }
});
test('latest cross-group period alignment prevents splicing older and newer chain segments', () => {
  const s = fixture(); s.evidence.filter(r => r.group === 'profit').forEach(r => {
    const index = r.periodEnd === '2026-03-31' ? 0 : 1;
    [r.periodStart, r.periodEnd] = index === 0 ? ['2025-11-01', '2026-01-31'] : ['2026-02-01', '2026-04-30'];
  });
  const result = insufficient(s); assert.ok(result.groups.every(g => g.sufficient)); assert.equal(result.aligned, false);
});
test('exact duplicates do not multiply coverage; renamed same events cannot make second chains', () => {
  const s = fixture(); s.evidence = s.evidence.filter(r => r.chainId === 'a');
  s.evidence.push(...clone(s.evidence)); insufficient(s);
  const renamed = clone(s.evidence).map((r, i) => ({...r, id: 'renamed-' + i, chainId: 'b'}));
  s.evidence.push(...renamed); insufficient(s);
});
test('conflicting same-quarter evidence blocks the group, even duplicate keys', () => {
  const s = fixture(), r = clone(s.evidence[0]); r.id += '-conflict'; r.direction = 'improving'; r.value = 120; s.evidence.push(r);
  const result = insufficient(s); assert.match(result.groups[0].reason, /冲突/);
});
test('sameSkuPrice requires same SKU, configuration, currency and delivery terms', () => {
  const s = fixture(); s.evidence.filter(r => r.group === 'profit').forEach(r => { r.metric = 'sameSkuPrice'; r.unit = 'USD'; r.value = 80; r.baseline = 100; });
  insufficient(s);
  s.evidence.filter(r => r.group === 'profit').forEach(r => { r.comparableTerms = {sku: 'Same SKU', currency: 'USD', configuration: '80GB', deliveryTerms: 'same contract / delivery'}; });
  assert.equal(state(s).score, 85);
  for (const r of s.evidence.filter(r => r.group === 'profit' && r.periodEnd === '2026-06-30')) r.comparableTerms.sku = 'replacement SKU';
  insufficient(s);
});
test('cleared confounders and valid 2-quarter predeclared windows may qualify', () => {
  const s = fixture(); s.evidence.forEach(r => { r.confounders = [{name: 'Product mix', cleared: true}]; if (r.group === 'application') r.evaluationWindowQuarters = 2; });
  assert.equal(state(s).score, 85);
});
test('all observed company metrics stay proxy/null even when margins and inventory worsen', () => {
  const s = companyFixture(), result = insufficient(s), c = result.companies[0];
  assert.equal(c.trend.marginPP, -4); assert.ok(c.trend.inventoryRevenueChange > 0); assert.equal(c.trend.watch, true);
  const html = ai.renderHTML(result); assert.match(html, /观察（公司财报代理）/); assert.match(html, /10 亿 USD/); assert.match(html, /未披露=N\/A/);
  assert.match(html, /AI orders 缺失/); assert.match(html, /54%/); assert.equal(c.trend.revenueYoY, null);
});
test('proxy trends need three continuous quarters and valid dates; unverified trends stay observation only', () => {
  for (const mutate of [s => { s.companies[0].quarters = s.companies[0].quarters.slice(-2); },
    s => { s.companies[0].quarters.at(-1).filed = '2026-06-29'; }, s => { s.companies[0].fetchedAt = '2027-01-01T00:00:00Z'; }]) {
    const s = companyFixture(); mutate(s); const c = state(s).companies[0]; assert.equal(c.trend.watch, false); assert.equal(c.trend.marginPP, null);
  }
  const s = companyFixture(); s.companies[0].crossCheck.status = 'unverified';
  const c = insufficient(s).companies[0]; assert.equal(c.trend.watch, false); assert.equal(c.trend.marginPP, -4);
  assert.equal(c.trend.crossCheck, '单源观察/未独立交验');
});
test('company monetary units are currency-isolated and missing/unknown units do not become zero', () => {
  for (const currency of ['USD', 'TWD', 'KRW']) assert.match(ai.renderHTML(state(companyFixture(currency))), new RegExp('10 亿 ' + currency));
  const s = companyFixture(); s.companies[0].quarters.at(-1).metrics.revenue.value = null;
  assert.equal(state(s).companies[0].latest.metrics.revenue.value, null);
  s.companies[0].quarters.at(-1).metrics.inventory.unit = 'ambiguous'; assert.equal(state(s).companies[0].latest.metrics.inventory.usable, false);
});
test('annual company data and stale/error company status do not impersonate quarterly AI evidence', () => {
  for (const status of ['error', 'stale', 'unavailable']) {
    const s = companyFixture(); s.companies[0].status = status; assert.equal(state(s).companies[0].latest.metrics.revenue.usable, false); insufficient(s);
  }
  const s = companyFixture(); s.companies[0].quarters = [{...s.companies[0].quarters.at(-1), start: '2025-07-01'}];
  assert.equal(state(s).companies[0].latest, null);
});
test('render escapes evidence/company/formula-looking text and permits only safe HTTPS links', () => {
  const s = companyFixture(), x = '<img src=x onerror="alert(1)">';
  s.companies[0].name = x; s.companies[0].crossCheck.reason = x; s.errors = [x];
  s.companies[0].source.url = 'javascript:alert(1)'; s.evidence = fixture().evidence; s.evidence[0].summary = x;
  const html = ai.renderHTML(state(s)); assert.doesNotMatch(html, /<img|href="javascript:|NaN|Infinity/); assert.match(html, /&lt;img/);
  assert.equal(ai.httpsURL('https://user:pass@example.org'), null); assert.equal(ai.httpsURL('http://example.org'), null);
  assert.match(html, /focus-visible/); assert.match(html, /overscroll-behavior-x:contain/); assert.match(html, /<details><summary>原始来源/);
});
test('AI standalone loader retains dates and rejects future/decreased generations', async () => {
  await ai.load({now: NOW, fetch: async () => ({ok: true, json: async () => fixture()})});
  assert.equal(ai.getSnapshot().generatedAt, GENERATED);
  for (const generatedAt of ['2026-07-02T09:00:00Z', '2027-07-02T10:00:00Z']) {
    const s = fixture(); s.generatedAt = s.lastSuccessfulAt = generatedAt;
    const result = await ai.load({now: NOW, fetch: async () => ({ok: true, json: async () => s})});
    assert.equal(ai.getSnapshot().generatedAt, GENERATED); assert.ok(result.transportError);
  }
  const result = await ai.load({now: '2026-07-05T12:00:00Z', fetch: async () => { throw new Error('offline'); }});
  assert.equal(result.score, null); assert.equal(result.generatedAt, GENERATED);
});
test('same-origin loader rejects external URL before calling fetch', async () => {
  let calls = 0;
  await assert.rejects(ai.requestSnapshot({url: 'https://external.example.org/a.json', fetch: async () => { calls++; }}), /同源/);
  await assert.rejects(ai.requestSnapshot({url: ' https://external.example.org/a.json', fetch: async () => { calls++; }}), /同源/);
  assert.equal(calls, 0);
});
test('12-second timeout also rejects a mock which ignores AbortSignal', async () => {
  const timers = [], context = vm.createContext({window: {}, URL, Date, AbortController, setTimeout(fn, ms) { timers.push({fn, ms}); return timers.length; }, clearTimeout() {}});
  vm.runInContext(readFileSync(new URL('../js/ai-realization.js', import.meta.url), 'utf8'), context);
  const pending = context.window.AiRealization.requestSnapshot({fetch: () => new Promise(() => {})});
  assert.equal(timers[0].ms, 12000); timers[0].fn(); await assert.rejects(pending, /12秒/);
});
test('buyer/supplier and independent same-quarter directions cannot disagree and still score', () => {
  const s = fixture(); s.evidence.filter(r => r.procurementSide === 'supplier').forEach(r => { r.value = 100; r.direction = 'stable'; });
  const result = insufficient(s); assert.match(result.groups[1].reason, /冲突/);
});
test('renaming companies as well as chains cannot reuse a single sourced event', () => {
  const s = fixture(); s.evidence = s.evidence.filter(r => r.chainId === 'a');
  s.evidence.push(...clone(s.evidence).map((r, i) => ({...r, id: 'copied-' + i, chainId: 'b', companyId: r.companyId === 'MSFT' ? 'GOOG' : 'AMD'})));
  insufficient(s);
});
test('malformed optional disclosure records and empty snapshots render safely', () => {
  for (const input of [null, {}, {schemaVersion: 1, companies: [null], evidence: [null]}, companyFixture()]) {
    if (input?.companies?.[0]) input.companies[0].disclosures = [null, false, {}, {title: '<script>throw 1</script>'}];
    assert.doesNotThrow(() => ai.renderHTML(state(input)));
    assert.doesNotMatch(ai.renderHTML(state(input)), /<script>/);
  }
});
test('noncanonical UTC generatedAt and future company quarters are not fresh', () => {
  for (const generatedAt of ['2026-07-01T24:00:00Z', '2026-02-30T10:00:00Z', '2026-07-02T12:60:00Z']) {
    const s = fixture(); s.generatedAt = generatedAt; insufficient(s);
  }
  const s = companyFixture(); s.companies[0].quarters = [{...s.companies[0].quarters.at(-1), start: '2026-07-01', end: '2026-09-30'}];
  assert.equal(state(s).companies[0].fresh, false);
});
test('company YoY requires a genuine year baseline plus three consecutive current quarters', () => {
  const s = companyFixture(), c = s.companies[0];
  const base = clone(c.quarters.at(-1)); base.start = '2025-04-01'; base.end = '2025-06-30'; base.metrics.revenue.value = 5e8;
  c.quarters.unshift(base); assert.equal(state(s).companies[0].trend.revenueYoY, 100);
  c.quarters = [base, ...c.quarters.slice(-2)]; assert.equal(state(s).companies[0].trend.revenueYoY, null);
});
test('price metadata property order does not change same-SKU series matching', () => {
  const s = fixture(); s.evidence.filter(r => r.group === 'profit').forEach(r => {
    r.metric = 'sameSkuPrice'; r.unit = 'USD'; r.value = 80; r.baseline = 100;
    r.comparableTerms = r.periodEnd === '2026-03-31' ? {sku: 'X', currency: 'USD', configuration: '80GB', deliveryTerms: 'fixed'} : {deliveryTerms: 'fixed', configuration: '80GB', currency: 'USD', sku: 'X'};
  });
  assert.equal(state(s).score, 85);
});
test('freshness is evaluated from real period end and does not accept a bare annual filing', () => {
  const s = companyFixture(), end = Date.parse('2026-06-30T00:00:00Z');
  for (const offset of [-1, 0, 1]) {
    const now = new Date(end + 200 * 86400000 + offset).toISOString();
    s.generatedAt = s.lastSuccessfulAt = now; s.companies[0].fetchedAt = now;
    assert.equal(ai.compute(s, {now}).companies[0].fresh, offset <= 0);
  }
});
test('derived company gross margin needs correct same-currency revenue/cost inputs and remains proxy', () => {
  const s = companyFixture(), q = s.companies[0].quarters.at(-1), m = q.metrics.grossMargin;
  for (const id of ['revenue', 'costOfRevenue', 'grossMargin']) Object.assign(q.metrics[id], {
    period: {start: q.start, end: q.end}, filed: q.filed, accession: '0001045810-26-000001', fiscalYear: 2026,
  });
  m.kind = 'derived'; m.tag = 'derived:(revenue-costOfRevenue)/revenue'; m.value = 60;
  m.inputs = [clone(q.metrics.revenue), clone(q.metrics.costOfRevenue)];
  assert.equal(state(s).companies[0].latest.metrics.grossMargin.usable, true); insufficient(s);
  m.value = 54; assert.equal(state(s).companies[0].latest.metrics.grossMargin.usable, false);
});
test('exact 10-percent changes qualify, while 3pp margins are not relative percentages', () => {
  const s = fixture(); s.evidence.forEach(r => { r.value = r.group === 'profit' ? 57 : 90; }); assert.equal(state(s).score, 85);
  s.evidence.filter(r => r.group === 'profit').forEach(r => { r.value = 58.2; }); insufficient(s);
});
test('order cancellation increases are adverse and reductions are improving counterevidence', () => {
  const s = fixture(); s.evidence.filter(r => r.group === 'orders').forEach(r => { r.metric = 'orderCancellations'; r.value = 120; });
  assert.equal(state(s).score, 85);
  s.evidence.filter(r => r.group === 'orders').forEach(r => { r.value = 80; r.direction = 'improving'; });
  assert.equal(state(s).score, 65);
});
test('explicit errored/stale reviewed records are still excluded, unrelated partial-run errors do not invent pressure', () => {
  for (const patch of [{status: 'error'}, {status: 'stale'}, {error: 'failed verification'}]) {
    const s = fixture(); s.evidence.forEach(r => Object.assign(r, patch)); insufficient(s);
  }
  const s = fixture([]); s.runStatus = 'partial'; s.errors = ['Unrelated company feed unavailable']; assert.equal(state(s).score, 0);
});

// SEC-shaped facts are synthetic and in memory; exercise the actual parser,
// including NVIDIA's noncalendar FY, rather than depending on live daily JSON.
const BRIDGE_AT = '2026-02-10T10:00:00.000Z';
const NVDA = COMPANIES.find(c => c.id === 'NVDA');
const fiscalQuarters = [
  ['2025-01-27', '2025-04-27', '2025-05-05'], ['2025-04-28', '2025-07-27', '2025-08-05'],
  ['2025-07-28', '2025-10-26', '2025-11-05'], ['2025-10-27', '2026-01-25', '2026-02-05'],
];
const bridgeState = s => ai.compute(s, {now: BRIDGE_AT});
function collectorBridge(ytdIncome = false) {
  const facts = {}, revenues = [44, 46, 52, 60], costs = [12, 15, 20, 26];
  for (const [n, [tag, values]] of Object.entries({
    Revenues: revenues, CostOfRevenue: costs, GrossProfit: revenues.map((v, i) => v - costs[i]),
    InventoryNet: [8, 12, 18, 26], PaymentsToAcquirePropertyPlantAndEquipment: [2, 3, 4, 5],
    NetCashProvidedByUsedInOperatingActivities: [20, 18, 16, -2],
  }).entries()) {
    const cumulative = ['PaymentsToAcquirePropertyPlantAndEquipment', 'NetCashProvidedByUsedInOperatingActivities'].includes(tag)
      || ytdIncome && ['Revenues', 'CostOfRevenue', 'GrossProfit'].includes(tag);
    facts[tag] = {units: {USD: fiscalQuarters.map(([start, end, filed], i) => ({
      ...(tag === 'InventoryNet' ? {} : {start: cumulative ? fiscalQuarters[0][0] : start}), end,
      val: (cumulative ? values.slice(0, i + 1).reduce((sum, v) => sum + v, 0) : values[i]) * 1e9,
      fy: 2026, fp: i === 3 ? 'FY' : 'Q' + (i + 1), form: i === 3 ? '10-K' : '10-Q',
      filed: new Date(Date.parse(filed) + (+n % 3) * 86400000).toISOString().slice(0, 10),
      accn: `0001045810-26-${String(+n * 10 + i + 1).padStart(6, '0')}`,
    }))}};
  }
  const company = parseCompanyFacts({cik: NVDA.cik, facts: {'us-gaap': facts}}, NVDA, new Date(BRIDGE_AT));
  // Match the collector JSON -> frontend boundary: no shared source references.
  return JSON.parse(JSON.stringify({schemaVersion: 1, generatedAt: BRIDGE_AT, lastSuccessfulAt: BRIDGE_AT, runStatus: 'partial', companies: [company], evidence: [], errors: []}));
}
const latestMetrics = s => s.companies[0].quarters.at(-1).metrics;

test('real collector bridge accepts NVIDIA three-input gross margin and traceable CFO/capex YTD quarters', () => {
  const s = collectorBridge(), before = clone(s), result = bridgeState(s), c = result.companies[0];
  const metrics = latestMetrics(s);
  assert.equal(metrics.grossMargin.inputs.length, 3);
  assert.notEqual(metrics.grossMargin.inputs[0].accession, metrics.grossMargin.inputs[1].accession);
  assert.deepEqual(c.latest && [c.latest.start, c.latest.end], fiscalQuarters[3].slice(0, 2));
  for (const id of ['revenue', 'costOfRevenue', 'grossMargin', 'inventory', 'capex', 'operatingCashFlow']) assert.equal(c.latest.metrics[id].usable, true, id);
  assert.equal(c.latest.metrics.grossMargin.value, 34 / 60 * 100);
  assert.equal(c.latest.metrics.inventory.value, 26e9);
  assert.equal(c.latest.metrics.operatingCashFlow.value, -2e9);
  assert.equal(c.latest.metrics.capex.value, 5e9);
  for (const [n, q] of c.quarters.slice(1).entries()) {
    assert.equal(s.companies[0].quarters[n + 1].metrics.operatingCashFlow.inputs.length, n + 2);
    assert.equal(q.metrics.operatingCashFlow.usable, true);
    assert.equal(q.metrics.operatingCashFlow.kind, 'derived');
  }
  assert.equal(result.score, null); assert.equal(result.coverage, 0); assert.equal(c.crossCheck.status, 'unavailable');
  assert.deepEqual(s, before);
});

test('gross margin validates legally derived revenue/cost and GrossProfit contracts before use', () => {
  const s = collectorBridge(true), c = bridgeState(s).companies[0];
  for (const id of ['revenue', 'costOfRevenue', 'grossMargin']) assert.equal(c.latest.metrics[id].usable, true, id);
  assert.equal(latestMetrics(s).grossMargin.inputs[2].kind, 'derived');
  assert.equal(c.latest.metrics.revenue.kind, 'derived');
  assert.equal(c.latest.metrics.costOfRevenue.kind, 'derived');
  assert.equal(bridgeState(s).score, null);
  latestMetrics(s).revenue.inputs[1].fiscalYear = 2025;
  assert.equal(bridgeState(s).companies[0].latest.metrics.grossMargin.usable, false);
});

test('collector two-input margin and default-observed raw GrossProfit are both valid', () => {
  const s = collectorBridge(), m = latestMetrics(s).grossMargin;
  delete m.inputs[2].kind;
  assert.equal(bridgeState(s).companies[0].latest.metrics.grossMargin.usable, true);
  m.inputs.pop();
  const latest = m.inputs.reduce((a, b) => a.filed >= b.filed ? a : b);
  Object.assign(m, {filed: latest.filed, accession: latest.accession, source: clone(latest.source)});
  assert.equal(bridgeState(s).companies[0].latest.metrics.grossMargin.usable, true);
});

for (const [name, mutate] of [
  ['third GrossProfit value', m => { m.inputs[2].value += 1; }],
  ['third GrossProfit currency', m => { m.inputs[2].currency = 'TWD'; }],
  ['third GrossProfit fiscal year', m => { m.inputs[2].fiscalYear = 2025; }],
  ['third GrossProfit tag', m => { m.inputs[2].tag = 'us-gaap:InventoryNet'; }],
  ['third GrossProfit start', m => { m.inputs[2].start = '2025-10-28'; }],
  ['third GrossProfit end', m => { m.inputs[2].end = '2026-01-24'; }],
  ['third GrossProfit filing before end', m => { m.inputs[2].filed = '2026-01-24'; }],
  ['third GrossProfit future filing', m => { m.inputs[2].filed = '2026-02-11'; }],
  ['third GrossProfit different issuer', m => { m.inputs[2].source.url = filingURL(2488, m.inputs[2].accession); }],
  ['third GrossProfit foreign publisher', m => { m.inputs[2].source.url = 'https://research.example.org/filing'; }],
  ['unapproved SEC subdomain', m => { m.inputs[2].source.url = m.inputs[2].source.url.replace('www.sec.gov', 'fake.sec.gov'); }],
  ['SEC accession/source mismatch', m => { m.inputs[2].accession = '0001045810-26-999999'; }],
  ['arbitrary fourth input', m => { m.inputs.push(clone(m.inputs[2])); }],
  ['revenue source name mismatch', m => { m.inputs[0].source.name = 'Different source'; }],
  ['cost different valid same-CIK filing', m => { m.inputs[1].accession = '0001045810-26-999999'; m.inputs[1].source.url = filingURL(NVDA.cik, m.inputs[1].accession); }],
  ['revenue different filing date', m => { m.inputs[0].filed = '2026-02-04'; }],
  ['revenue currency/unit mismatch', m => { m.inputs[0].unit = 'TWD'; }],
  ['gross margin fiscal year', m => { m.fiscalYear = 2025; }],
  ['gross margin period', m => { m.period.start = '2025-10-28'; }],
  ['gross margin source not actual input', m => { m.source.name = 'Different source'; }],
  ['gross margin predates validation input', m => { m.filed = m.inputs[0].filed; }],
]) test(`collector bridge rejects ${name} without dropping GrossProfit or promoting evidence`, () => {
  const s = collectorBridge(); mutate(latestMetrics(s).grossMargin);
  const result = bridgeState(s), m = result.companies[0].latest.metrics.grossMargin;
  assert.equal(m.usable, false); assert.equal(m.value, null); assert.ok(m.reason);
  assert.equal(result.score, null); assert.equal(result.companies[0].crossCheck.status, 'unavailable');
});

for (const [name, mutate] of [
  ['wrong fiscal-year start', m => { m.inputs[1].start = '2025-01-28'; }],
  ['wrong fiscal year', m => { m.inputs[1].fiscalYear = 2025; }],
  ['wrong currency', m => { m.inputs[1].currency = 'KRW'; }],
  ['wrong tag', m => { m.inputs[1].tag = 'us-gaap:Revenues'; }],
  ['wrong prior quarter end', m => { m.inputs[1].end = '2025-10-25'; }],
  ['missing Q1 chain', m => { m.inputs.pop(); }],
  ['missing 6m chain', m => { m.inputs.splice(2, 1); }],
  ['duplicate chain input', m => { m.inputs.push(clone(m.inputs.at(-1))); }],
  ['chain not descending', m => { [m.inputs[1], m.inputs[2]] = [m.inputs[2], m.inputs[1]]; }],
  ['prior filing later than current', m => { m.inputs[1].filed = '2026-02-08'; }],
  ['future raw filing', m => { m.inputs[0].filed = '2026-02-11'; }],
  ['filed before period end', m => { m.inputs[0].filed = '2026-01-24'; }],
  ['future raw end', m => { m.inputs[0].end = '2026-04-25'; }],
  ['wrong quarter start', m => { m.period.start = '2025-10-28'; }],
  ['wrong quarter end', m => { m.period.end = '2026-01-24'; }],
  ['wrong difference', m => { m.value += 10; }],
  ['annual without 10-K', m => { m.inputs[0].form = '10-Q'; }],
  ['raw input marked derived without contract', m => { m.inputs[1].kind = 'derived'; }],
  ['raw input belonging to AMD', m => { m.inputs[1].source.url = filingURL(2488, m.inputs[1].accession); }],
  ['raw input from foreign publisher', m => { m.inputs[1].source.url = 'https://amd.example.org/filing'; }],
  ['raw source/accession mismatch', m => { m.inputs[1].accession = '0001045810-26-999999'; }],
  ['metric source different from current', m => { m.source.name = 'Different source'; }],
]) test(`collector bridge rejects CFO YTD ${name}`, () => {
  const s = collectorBridge(); mutate(latestMetrics(s).operatingCashFlow);
  const result = bridgeState(s), m = result.companies[0].latest.metrics.operatingCashFlow;
  assert.equal(m.usable, false); assert.equal(m.value, null); assert.equal(result.score, null);
});

test('single-source official trends render under the company row but never become verified/watch/direct risk', () => {
  const s = collectorBridge(), result = bridgeState(s), c = result.companies[0];
  const margins = s.companies[0].quarters.slice(-3).map(q => q.metrics.grossMargin.value);
  assert.equal(c.trend.marginPP, margins[2] - margins[0]); assert.ok(c.trend.marginPP < -3);
  assert.equal(c.trend.inventoryRevenueChange, 26 / 60 - 12 / 46);
  assert.equal(c.trend.watch, false); assert.equal(c.trend.crossCheck, '单源观察/未独立交验');
  assert.equal(c.crossCheck.status, 'unavailable'); assert.equal(result.score, null); assert.equal(result.level, 'insufficient'); assert.equal(result.coverage, 0);
  const html = ai.renderHTML(result);
  assert.match(html, /<tr><td colspan="5"><small>NVDA[^<]*单源观察\/未独立交验[^<]*三季毛利变化 -10\.72pp；库存\/营收比变化 0\.17/);
  assert.match(html, /SEC API与SEC filing属于同一来源/); assert.match(html, /非AI订单，不计分/); assert.match(html, /AI orders 缺失/);
  assert.doesNotMatch(html, /NaN|Infinity/);
});

test('normal company comparisons render without a watch warning, and no genuine YoY baseline stays null', () => {
  const s = companyFixture();
  for (const q of s.companies[0].quarters) { q.metrics.grossMargin.value = 60; q.metrics.inventory.value = 2e8; }
  const result = insufficient(s); assert.equal(result.companies[0].trend.watch, false);
  assert.match(ai.renderHTML(result), /三季毛利变化 0pp；库存\/营收比变化 0；营收同比 N\/A%/);
});

test('single-source YoY uses a genuine year baseline without promoting crosscheck', () => {
  const s = companyFixture(), c = s.companies[0], base = clone(c.quarters.at(-1));
  base.start = '2025-04-01'; base.end = '2025-06-30'; base.metrics.revenue.value = 5e8;
  c.quarters.unshift(base); c.crossCheck.status = 'unverified';
  const result = insufficient(s); assert.equal(result.companies[0].trend.revenueYoY, 100); assert.equal(result.companies[0].trend.watch, false);
});

test('YTD differences preserve economic sign rules and monetary tolerance in normalized currency units', () => {
  const s = collectorBridge(true), metrics = latestMetrics(s);
  for (const id of ['revenue', 'costOfRevenue', 'capex']) {
    const changed = clone(s), m = latestMetrics(changed)[id];
    m.inputs[0].value = m.inputs[1].value - 1e9; m.value = -1e9;
    assert.equal(bridgeState(changed).companies[0].latest.metrics[id].usable, false, id);
  }
  const cfo = metrics.operatingCashFlow;
  cfo.value += 0.001; assert.equal(bridgeState(s).companies[0].latest.metrics.operatingCashFlow.usable, true);
  cfo.value += 1; assert.equal(bridgeState(s).companies[0].latest.metrics.operatingCashFlow.usable, false);
  cfo.value = -2000; cfo.unit = 'USD millions';
  assert.equal(bridgeState(s).companies[0].latest.metrics.operatingCashFlow.value, -2e9);
  cfo.unit = 'TWD millions'; assert.equal(bridgeState(s).companies[0].latest.metrics.operatingCashFlow.usable, false);
});

test('collector metadata aligns observed periods too, with inventory as the sole instant exception', () => {
  for (const id of ['revenue', 'costOfRevenue', 'inventory']) {
    const s = collectorBridge(), m = latestMetrics(s)[id]; m.period.end = '2026-01-24';
    assert.equal(bridgeState(s).companies[0].latest.metrics[id].usable, false, id);
  }
  const s = collectorBridge(); latestMetrics(s).revenue.period.start = '2026-01-25';
  assert.equal(bridgeState(s).companies[0].latest.metrics.revenue.usable, false);
  latestMetrics(s).inventory.period.start = '2025-12-01';
  assert.equal(bridgeState(s).companies[0].latest.metrics.inventory.usable, false);
});

test('even matched raw and metric SEC URLs cannot borrow another company CIK', () => {
  const s = collectorBridge(true), metrics = latestMetrics(s);
  const foreign = f => {
    if (f.source) f.source.url = filingURL(2488, f.accession);
    if (f.inputs) f.inputs.forEach(foreign);
  };
  foreign(metrics.revenue); foreign(metrics.grossMargin.inputs[0]);
  const result = bridgeState(s);
  assert.equal(result.companies[0].latest.metrics.revenue.usable, false);
  assert.equal(result.companies[0].latest.metrics.grossMargin.usable, false);
  assert.equal(result.score, null);
});

test('P1-4: SEC hostname normalization — data.sec.gov and sec.gov are the same publisher', () => {
  const s = fixture(['application']);
  // Make both sources point to SEC subdomains — they should NOT pass independence.
  for (const record of s.evidence) {
    record.sources = [
      {name: 'SEC data feed', url: 'https://data.sec.gov/api/xbrl/companyfacts/CIK0000789019.json', publisher: 'SEC', type: 'official'},
      {name: 'SEC filing', url: 'https://www.sec.gov/Archives/edgar/data/789019/filing.htm', publisher: 'SEC Archives', type: 'independent'},
    ];
  }
  // Both URLs resolve to sec.gov after normalization — same hostname, rejected.
  const result = state(s);
  assert.equal(result.score, null, 'Two SEC subdomain URLs must not pass hostname independence');
  // Now verify that genuinely different hostnames still pass.
  for (const record of s.evidence) {
    record.sources = [
      {name: 'Official', url: `https://${record.companyId.toLowerCase()}.example.org/report`, publisher: record.companyId, type: 'official'},
      {name: 'Independent', url: 'https://research.example.net/analysis', publisher: 'Research firm', type: 'independent'},
    ];
  }
  const result2 = state(s);
  assert.notEqual(result2.score, null, 'Different hostnames should pass independence check');
});

test('P1-5: URL fragments and tracking params stripped before event dedup', () => {
  const s = fixture(['application', 'orders', 'profit']);
  const original = structuredClone(s);
  // Add duplicate records with different URL fragments/tracking params.
  const extra = structuredClone(s.evidence[0]);
  extra.id = 'dup-fragment';
  extra.sources = extra.sources.map(src => ({...src, url: src.url + '#section-2'}));
  s.evidence.push(extra);
  const extra2 = structuredClone(s.evidence[1]);
  extra2.id = 'dup-tracking';
  extra2.sources = extra2.sources.map(src => ({...src, url: src.url + '?utm_source=twitter&utm_medium=social'}));
  s.evidence.push(extra2);
  const result = state(s);
  const clean = state(original);
  // Duplicates should be detected: same score, same group chain counts.
  assert.equal(result.score, clean.score, 'Fragment/tracking-param duplicates must not inflate the score');
  const appGroup = result.groups.find(g => g.id === 'application');
  const cleanApp = clean.groups.find(g => g.id === 'application');
  assert.equal(appGroup.chainCount, cleanApp.chainCount, 'Duplicate chains must not increase chain count');
});
