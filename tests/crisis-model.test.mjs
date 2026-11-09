import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const model = require('../js/crisis-daily.js');
const root = new URL('../', import.meta.url);
const sharedSource = readFileSync(new URL('js/crisis-daily.js', root), 'utf8');
const NOW = Date.parse('2026-07-02T12:00:00Z');
const VALUES_A = {
  SP500: 6100, NASDAQ: 19500, SP500_YOY: 8, NASDAQ_YOY: 15,
  DXY: 99, DXY_YOY: 2, GOLD: 2900, GOLD_YOY: 10, WTI: 70, WTI_YOY: 5,
  BTC: 80000, BTC_YOY: 20, DGS2: 2.5, DGS5: 2.5, DGS10: 2.7, DGS30: 3,
  T10Y2Y: .2, VIXCLS: 14, UNRATE: 3.8, UMCSENT: 85, DCCLACBS: 2.3,
  CSUSHPINSA_YOY: 2, BAMLH0A0HYM2: 2.8, CPI_YOY: 2.5, PCE_CORE_YOY: 2.1,
  DFEDTARL: 3.5, DFEDTARU: 3.75, CAPE: 29, PE_TTM: 21,
  CORP_PROFIT_YOY: 8, CORP_DEBT_GDP: 65, CONCENTRATION: 26, EPS_TTM: 250
};
const VALUES_B = {
  SP500: 5100, NASDAQ: 15300, SP500_YOY: -20, NASDAQ_YOY: -35,
  DXY: 112, DXY_YOY: 19, GOLD: 4500, GOLD_YOY: 55, WTI: 105, WTI_YOY: 50,
  BTC: 55000, BTC_YOY: -45, DGS2: 5.7, DGS5: 5.9, DGS10: 6.1, DGS30: 6,
  T10Y2Y: -1, VIXCLS: 60, UNRATE: 6.2, UMCSENT: 50, DCCLACBS: 5.9,
  CSUSHPINSA_YOY: 15, BAMLH0A0HYM2: 7.8, CPI_YOY: 5, PCE_CORE_YOY: 4,
  DFEDTARL: 5.5, DFEDTARU: 5.75, CAPE: 40, PE_TTM: 30,
  CORP_PROFIT_YOY: -18, CORP_DEBT_GDP: 85, CONCENTRATION: 38, EPS_TTM: 290
};
const QUARTERLY = new Set(['DCCLACBS', 'CORP_PROFIT_YOY', 'CORP_DEBT_GDP', 'EPS_TTM']);
const MONTHLY = new Set(['UNRATE', 'UMCSENT', 'CSUSHPINSA_YOY', 'CPI_YOY', 'PCE_CORE_YOY', 'CONCENTRATION']);
const REAL_EPS_UNIT = 'inflation-adjusted 12-month real EPS (source rebases to latest CPI; not nominal/operating EPS or consensus)';
export function fixture(values = VALUES_A, generatedAt = '2026-07-02T10:00:00Z') {
  return {schemaVersion: 1, generatedAt, lastSuccessfulAt: generatedAt, runStatus: 'ok', errors: [],
    metrics: Object.fromEntries(model.METRIC_IDS.map(id => [id, {
      value: values[id] ?? null,
      // Ended source periods, including macro publication lag; EPS is independently end-dated.
      observationDate: id === 'EPS_TTM' ? '2026-06-30' : QUARTERLY.has(id) ? '2026-01-01'
        : MONTHLY.has(id) ? ['UMCSENT', 'CONCENTRATION'].includes(id) ? '2026-06-01' : '2026-05-01' : '2026-07-01',
      fetchedAt: generatedAt, frequency: QUARTERLY.has(id) ? 'quarterly' : MONTHLY.has(id) ? 'monthly' : 'daily',
      unit: id === 'EPS_TTM' ? REAL_EPS_UNIT : 'fixture unit', status: values[id] == null ? 'unavailable' : 'ok',
      kind: 'observed',
      source: id === 'EPS_TTM' ? {name: 'Multpl / Shiller S&P 500 12-month real earnings', url: 'https://www.multpl.com/s-p-500-earnings/table/by-year'}
        : {name: 'Fixture source ' + id, url: 'https://example.org/' + id}
    }]))};
}
const state = snapshot => model.compute(snapshot, {now: NOW});
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
const scoreList = s => [s.historical.score, s.system.score, s.triggers.score, s.composite.score];
function assertFiniteTree(value) {
  if (typeof value === 'number') assert.ok(Number.isFinite(value), 'no NaN/Infinity anywhere in state');
  else if (value && typeof value === 'object') Object.values(value).forEach(assertFiniteTree);
}

test('A/B changes all evidenced dimension scores, four benchmarks, eight system parts, triggers and composite', () => {
  const a = state(fixture()), b = state(fixture(VALUES_B));
  close(model.DIMENSIONS.reduce((sum, d) => sum + d.weight, 0), 1);
  assert.deepEqual(model.BENCHMARKS.map(b => b.weight), [.8, .0667, .0667, .0666]);
  for (const ba of a.benchmarks) {
    const bb = b.benchmarks.find(x => x.id === ba.id);
    assert.notEqual(ba.score, bb.score, ba.id);
    for (const d of ba.dimensions) {
      const other = bb.dimensions.find(x => x.id === d.id);
      if (d.id === 'btc' && ['2000', '2008'].includes(ba.id)) {
        assert.equal(d.score, null); assert.equal(d.coverage, 0);
      } else assert.notEqual(d.score, other.score, ba.id + '/' + d.id);
      for (const p of d.parts) if (p.score !== null) assert.notEqual(p.score, other.parts.find(x => x.id === p.id).score, p.id);
    }
  }
  for (const item of a.system.items) assert.notEqual(item.score, b.system.items.find(x => x.id === item.id).score, item.id);
  for (const t of a.triggers.items) {
    if (['capex', 'ipo', 'reg'].includes(t.id)) { assert.equal(t.score, null); assert.equal(t.coverage, 0); }
    else assert.notEqual(t.score, b.triggers.items.find(x => x.id === t.id).score, t.id);
  }
  close(a.triggers.coverage, .58);
  for (let i = 0; i < 4; i++) assert.notEqual(scoreList(a)[i], scoreList(b)[i]);
  close(a.composite.score, (a.historical.score + a.triggers.score) / 2);
  close(a.historical.score, a.benchmarks.reduce((sum, b) => sum + b.score * b.weight, 0));
  assert.notDeepEqual(a.anomalies.map(x => x.signal), b.anomalies.map(x => x.signal));
  assert.notDeepEqual(a.truth.map(x => x.signal), b.truth.map(x => x.signal));
  assert.notDeepEqual(a.earnings, b.earnings);
  assert.notEqual(a.masters[0].advice, b.masters[0].advice);
});

test('all missing stays null, never defaults to 50 or zero risk', () => {
  for (const input of [null, fixture({}), {...fixture(), metrics: {}}]) {
    const s = state(input);
    assert.deepEqual(scoreList(s), [null, null, null, null]);
    assert.ok(s.dimensions.every(d => d.score === null));
    assert.ok(s.benchmarks.every(b => b.score === null && b.sensitivity.score === null));
    assert.equal(s.earnings.base, null);
    assert.deepEqual(s.earnings.projections, []);
    assert.match(model.renderHTML(s), /暂停|暂无数据/);
    assertFiniteTree(s);
  }
});

test('zero/negative returns and EPS remain finite valid observations, including zero reference denominator', () => {
  close(model.proximity(0, 0, 20), 100);
  close(model.proximity(-10, 0, 20), 50);
  assert.equal(model.proximity(null, 0, 20), null);
  for (const values of [Object.fromEntries(model.METRIC_IDS.map(id => [id, 0])), {...VALUES_B, SP500_YOY: -40, NASDAQ_YOY: -60, EPS_TTM: -12, CORP_PROFIT_YOY: 0}]) {
    const s = state(fixture(values));
    assertFiniteTree(s);
    assert.ok(scoreList(s).every(Number.isFinite));
    assert.equal(s.metrics.SP500_YOY.usable, true);
    assert.equal(s.earnings.base, values.EPS_TTM);
    assert.doesNotMatch(model.renderHTML(s), /NaN|Infinity/);
  }
});

function metricSnapshot(id, observationDate, generatedAt = '2026-11-09T10:00:00Z', patch = {}) {
  const snapshot = fixture({}, generatedAt);
  snapshot.metrics[id] = {...fixture().metrics[id], observationDate, fetchedAt: generatedAt, ...patch};
  return snapshot;
}
function inputMetadata(observationDate, fetchedAt, value = 100, source = {name: 'Input source', url: 'https://example.org/input'}) {
  return {value, observationDate, fetchedAt, source: {...source}};
}
function derivedYoYSnapshot(id = 'SP500_YOY') {
  const snapshot = fixture(), m = snapshot.metrics[id];
  const priorYear = m.observationDate.replace(/^\d{4}/, year => String(Number(year) - 1));
  m.kind = 'derived';
  m.inputs = [inputMetadata(m.observationDate, m.fetchedAt, 6100, m.source), inputMetadata(priorYear, m.fetchedAt, 5600, m.source)];
  m.value = (m.inputs[0].value / m.inputs[1].value - 1) * 100;
  return snapshot;
}
const productionSnapshot = () => JSON.parse(readFileSync(new URL('data/crisis-daily.json', root), 'utf8'));
const productionState = snapshot => model.compute(snapshot, {now: snapshot.generatedAt});

test('daily/monthly/quarterly grace boundaries are aged from real ended periods, not fetch dates', () => {
  for (const [id, observationDate, periodEnd, days] of [
    ['SP500_YOY', '2026-06-25', '2026-06-25', 7],
    ['UNRATE', '2026-05-01', '2026-05-31', 75],
    ['EPS_TTM', '2026-03-31', '2026-03-31', 160],
    ['CSUSHPINSA_YOY', '2026-05-01', '2026-05-31', 120]
  ]) {
    const boundary = Date.parse(periodEnd + 'T00:00:00Z') + days * 86400000;
    for (const offset of [-1, 0, 1]) {
      const at = new Date(boundary + offset).toISOString();
      const result = model.compute(metricSnapshot(id, observationDate, at), {now: at}).metrics[id];
      assert.equal(result.usable, offset <= 0, id + '/' + offset);
      assert.equal(result.periodEnd, periodEnd);
      close(result.ageDays, days + offset / 86400000);
      if (offset > 0) assert.match(result.reason, /过期/);
    }
  }
  const snapshot = fixture();
  snapshot.metrics.DCCLACBS.observationDate = '2026-04';
  assert.equal(state(snapshot).metrics.DCCLACBS.usable, true);
  assert.equal(state(snapshot).metrics.DCCLACBS.periodEnd, '2026-06-30');
  snapshot.metrics.UNRATE.observationDate = '2026-02-30';
  assert.match(state(snapshot).metrics.UNRATE.reason, /日期无效/);
});

test('April 1 Q2 remains valid on November 9 with explicit or fallback June 30 periodEnd', () => {
  for (const id of ['DCCLACBS', 'CORP_PROFIT_YOY', 'CORP_DEBT_GDP']) {
    for (const patch of [{}, {periodEnd: '2026-06-30', maxAgeDays: 160}]) {
      const result = model.compute(metricSnapshot(id, '2026-04-01', undefined, patch), {now: '2026-11-09T12:00:00Z'}).metrics[id];
      assert.equal(result.usable, true, id);
      assert.equal(result.observationDate, '2026-04-01');
      assert.equal(result.periodEnd, '2026-06-30');
      close(result.ageDays, 132.5);
      assert.equal(result.maxAgeDays, id === 'CORP_DEBT_GDP' ? 180 : 160);
    }
  }
});

test('next unfinished month/quarter is rejected, including during its final day', () => {
  for (const [id, start, end, at] of [
    ['DCCLACBS', '2026-10-01', '2026-12-31', '2026-11-09T12:00:00Z'],
    ['UNRATE', '2026-11-01', '2026-11-30', '2026-11-09T12:00:00Z'],
    ['DCCLACBS', '2026-04-01', '2026-06-30', '2026-06-30T23:59:59Z'],
    ['UNRATE', '2026-06-01', '2026-06-30', '2026-06-30T23:59:59Z'],
    ['EPS_TTM', '2026-06-30', '2026-06-30', '2026-06-30T23:59:59Z']
  ]) for (const patch of [{}, {periodEnd: end}]) {
    const result = model.compute(metricSnapshot(id, start, at, patch), {now: at}).metrics[id];
    assert.equal(result.usable, false, id);
    assert.match(result.reason, /尚未结束|未来/);
  }
  for (const id of ['DCCLACBS', 'UNRATE', 'EPS_TTM']) {
    const snapshot = metricSnapshot(id, id === 'EPS_TTM' ? '2026-06-30' : id === 'UNRATE' ? '2026-06-01' : '2026-04-01', '2026-07-01T00:00:00Z');
    assert.equal(model.compute(snapshot, {now: snapshot.generatedAt}).metrics[id].usable, true);
  }
});

test('periodEnd must be a legal canonical date, not an arbitrary extension, and cannot postdate fetch', () => {
  for (const periodEnd of [null, '2026-06', '2026-02-30', '2026-03-31', '2026-06-29', '2026-09-30', '2026-12-31']) {
    const result = model.compute(metricSnapshot('DCCLACBS', '2026-04-01', undefined, {periodEnd}), {now: '2026-11-09T12:00:00Z'}).metrics.DCCLACBS;
    assert.equal(result.usable, false, String(periodEnd));
    assert.match(result.reason, /periodEnd/);
  }
  const beforeEnd = metricSnapshot('DCCLACBS', '2026-04-01', '2026-07-02T10:00:00Z', {periodEnd: '2026-06-30', fetchedAt: '2026-06-29T10:00:00Z'});
  assert.match(state(beforeEnd).metrics.DCCLACBS.reason, /尚未结束|未来/);
  const daily = metricSnapshot('DGS10', '2026-11-06', undefined, {periodEnd: '2026-11-09'});
  assert.equal(model.compute(daily, {now: '2026-11-09T12:00:00Z'}).metrics.DGS10.usable, false);
});

test('Case-Shiller August 1 remains valid on November 9 with its fixed 120-day grace', () => {
  for (const patch of [{}, {periodEnd: '2026-08-31', maxAgeDays: 120}]) {
    const result = model.compute(metricSnapshot('CSUSHPINSA_YOY', '2026-08-01', undefined, patch), {now: '2026-11-09T12:00:00Z'}).metrics.CSUSHPINSA_YOY;
    assert.equal(result.usable, true);
    assert.equal(result.periodEnd, '2026-08-31');
    assert.equal(result.maxAgeDays, 120);
    close(result.ageDays, 70.5);
  }
});

test('independent quarter-end EPS keeps June 30 and real-CPI units, never price/PE derivation', () => {
  for (const patch of [{}, {periodEnd: '2026-06-30', maxAgeDays: 160}]) {
    const snapshot = metricSnapshot('EPS_TTM', '2026-06-30', undefined, patch);
    const result = model.compute(snapshot, {now: '2026-11-09T12:00:00Z'});
    assert.equal(result.metrics.EPS_TTM.usable, true);
    assert.equal(result.metrics.EPS_TTM.periodEnd, '2026-06-30');
    assert.equal(result.metrics.EPS_TTM.unit, REAL_EPS_UNIT);
    assert.equal(result.metrics.EPS_TTM.kind, 'observed');
    assert.equal(result.earnings.observationDate, '2026-06-30');
    assert.equal(result.earnings.base, VALUES_A.EPS_TTM);
    snapshot.metrics.SP500.value = 999999;
    snapshot.metrics.PE_TTM.value = .001;
    assert.deepEqual(model.compute(snapshot, {now: result.evaluatedAt}).earnings, result.earnings);
    const html = model.renderHTML(result);
    assert.match(html, /真实通胀调整12月EPS/);
    assert.match(html, /按来源最新CPI重定价/);
    assert.match(html, /实际购买力情景EPS/);
    assert.match(html, /inflation-adjusted 12-month real EPS/);
    assert.match(html, /最近有有效数据的采集/);
    assert.doesNotMatch(html, /可能推算|最近完整成功|月首保守/);
  }
  for (const date of ['2026-04-01', '2026-06-29']) assert.equal(state(metricSnapshot('EPS_TTM', date, '2026-07-02T10:00:00Z')).metrics.EPS_TTM.usable, false);
  assert.doesNotMatch(sharedSource, /298\.03/);
});

test('untrusted maxAgeDays and frequency cannot enlarge a metric ID grace period', () => {
  for (const [id, observationDate, limit] of [
    ['SP500_YOY', '2026-10-01', 7], ['UNRATE', '2026-06-01', 75],
    ['DCCLACBS', '2026-01-01', 160], ['CSUSHPINSA_YOY', '2026-06-01', 120]
  ]) for (const maxAgeDays of [10000, '10000', Infinity, null, -1, 160]) {
    const result = model.compute(metricSnapshot(id, observationDate, undefined, {maxAgeDays}), {now: '2026-11-09T12:00:00Z'}).metrics[id];
    assert.equal(result.usable, false, id + '/' + maxAgeDays);
    assert.equal(result.maxAgeDays, limit);
    assert.match(result.reason, /过期/);
  }
  const fresh = metricSnapshot('SP500', '2026-11-06', undefined, {maxAgeDays: 10000});
  const result = model.compute(fresh, {now: '2026-11-09T12:00:00Z'}).metrics.SP500;
  assert.equal(result.usable, true, 'ignore unsafe limit, do not invent missing data');
  assert.equal(result.maxAgeDays, 7);
  fresh.metrics.SP500.frequency = 'quarterly';
  assert.match(model.compute(fresh, {now: '2026-11-09T12:00:00Z'}).metrics.SP500.reason, /频率/);
});

test('future observations/fetchedAt and invalid/stale generatedAt halt or exclude assessment', () => {
  const s = fixture();
  s.metrics.DGS10.observationDate = '2026-07-03';
  s.metrics.CPI_YOY.fetchedAt = '2026-07-03T10:00:00Z';
  assert.equal(state(s).metrics.DGS10.usable, false);
  assert.equal(state(s).metrics.CPI_YOY.usable, false);
  for (const generatedAt of ['2026-07-03T10:00:00Z', '2026-06-29T10:00:00Z', '2026-02-30T10:00:00Z', 'not a date']) {
    const result = state({...fixture(), generatedAt});
    assert.deepEqual(scoreList(result), [null, null, null, null]);
    assert.ok(result.snapshotReason);
  }
  const predatesFetch = fixture();
  predatesFetch.metrics.DGS10.fetchedAt = '2026-06-30T10:00:00Z';
  assert.match(state(predatesFetch).metrics.DGS10.reason, /晚于抓取/);
});

test('stale/error/nonfinite/assumption/unsafe-source values never silently enter scoring', () => {
  for (const patch of [{status: 'stale'}, {status: 'error'}, {value: NaN}, {value: Infinity}, {value: '60'}, {kind: 'assumption'}, {frequency: 'yearly'}, {source: {name: 'bad', url: 'javascript:alert(1)'}}]) {
    const s = fixture(VALUES_B); Object.assign(s.metrics.VIXCLS, patch);
    const result = state(s);
    assert.equal(result.metrics.VIXCLS.usable, false);
    assert.equal(result.system.items.find(x => x.id === 'VIXCLS').score, null);
    assert.ok(result.system.score > 0);
  }
  assert.deepEqual(scoreList(state({...fixture(), runStatus: 'failed'})), [null, null, null, null]);
  assert.ok(state({...fixture(), runStatus: 'partial'}).historical.score !== null);
});

test('period-end grace never upgrades metric or source stale/error status', () => {
  for (const status of ['error', 'stale']) for (const location of ['metric', 'source']) {
    const snapshot = metricSnapshot('DCCLACBS', '2026-04-01', undefined, {periodEnd: '2026-06-30', maxAgeDays: 160});
    if (location === 'metric') snapshot.metrics.DCCLACBS.status = status;
    else snapshot.metrics.DCCLACBS.source = {...snapshot.metrics.DCCLACBS.source, status};
    const result = model.compute(snapshot, {now: '2026-11-09T12:00:00Z'}).metrics.DCCLACBS;
    assert.equal(result.usable, false, location + '/' + status);
    assert.match(result.reason, /状态不可用/);
  }
});

test('derived inputs require finite values, legal dates, safe sources and consistent nonfuture timestamps', () => {
  const valid = derivedYoYSnapshot;
  assert.equal(state(valid()).metrics.SP500_YOY.usable, true, 'prior-year input is not aged as a current daily observation');
  for (const inputs of [undefined, null, {}, [], [inputMetadata('2026-07-01', fixture().generatedAt)]]) {
    const snapshot = valid(); snapshot.metrics.SP500_YOY.inputs = inputs;
    assert.equal(state(snapshot).metrics.SP500_YOY.usable, false);
    assert.match(state(snapshot).metrics.SP500_YOY.reason, /inputs/);
  }
  for (const patch of [
    {value: null}, {value: NaN}, {value: Infinity}, {value: '6100'},
    {observationDate: '2026-02-30'}, {observationDate: '2026-07-03'},
    {fetchedAt: undefined}, {fetchedAt: 'not a date'}, {fetchedAt: '2026-07-03T00:00:00Z'},
    {fetchedAt: '2026-07-02T11:00:00Z'}, {fetchedAt: '2026-06-30T10:00:00Z'},
    {source: null}, {source: {name: '', url: 'https://example.org/'}},
    {source: {name: 'bad', url: 'javascript:alert(1)'}}, {source: {name: 'bad', url: 'http://example.org/'}},
    {source: {name: 'bad', url: 'https://user:pass@example.org/'}},
    {source: {name: 'bad', url: 'https://example.org/', status: 'error'}}, {status: 'stale'}
  ]) for (const kind of ['derived', 'observed']) {
    const snapshot = valid(); snapshot.metrics.SP500_YOY.kind = kind;
    Object.assign(snapshot.metrics.SP500_YOY.inputs[0], patch);
    const result = state(snapshot);
    assert.equal(result.metrics.SP500_YOY.usable, false, kind + '/' + JSON.stringify(patch));
    assert.match(result.metrics.SP500_YOY.reason, /inputs/);
    assert.equal(result.system.items.find(x => x.id === 'SP500_YOY').score, null);
    assert.equal(result.benchmarks[0].dimensions[0].parts[0].score, null);
  }
  const relativeFuture = valid();
  relativeFuture.metrics.SP500_YOY.fetchedAt = '2026-07-02T09:00:00Z';
  assert.match(state(relativeFuture).metrics.SP500_YOY.reason, /inputs时间/);
  const observationOnly = fixture();
  observationOnly.metrics.SP500_YOY.inputs = 'unsafe';
  assert.match(state(observationOnly).metrics.SP500_YOY.reason, /inputs/);
  assert.equal(state(fixture()).metrics.SP500_YOY.usable, true, 'legacy observed fixtures do not need derivation inputs');
});

test('derived SP500 YoY rejects different HTTPS input sources and reduces scoring coverage', () => {
  const full = state(derivedYoYSnapshot());
  for (const index of [0, 1]) for (const patch of [
    {name: 'Other HTTPS provider', url: 'https://other.example.org/SP500'},
    {name: 'Other series'}, {url: 'https://example.org/other-series'}
  ]) {
    const snapshot = derivedYoYSnapshot();
    Object.assign(snapshot.metrics.SP500_YOY.inputs[index].source, patch);
    const result = state(snapshot);
    assert.equal(result.metrics.SP500_YOY.usable, false);
    assert.match(result.metrics.SP500_YOY.reason, /inputs.*来源/);
    close(result.system.coverage, full.system.coverage - .13);
    assert.ok(result.historical.coverage < full.historical.coverage);
    assert.equal(result.system.items.find(x => x.id === 'SP500_YOY').score, null);
    assert.equal(result.benchmarks[0].dimensions[0].parts[0].score, null);
  }
  const extra = derivedYoYSnapshot();
  extra.metrics.SP500_YOY.inputs.push(inputMetadata('2025-07-01', extra.generatedAt));
  assert.match(state(extra).metrics.SP500_YOY.reason, /来源/);
});

test('YoY compares canonical HTTPS URLs without discarding FRED cosd or market fallback provenance', () => {
  for (const source of [
    {name: 'FRED SP500', url: 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=SP500&cosd=2023-01-01'},
    {name: 'Yahoo Finance ^GSPC', url: 'https://query2.finance.yahoo.com/v8/finance/chart/%5EGSPC?range=2y&interval=1d'},
    {name: 'Stooq ^spx', url: 'https://stooq.com/q/d/l/?s=%5Espx&i=d&d1=20240101&d2=20260702'}
  ]) {
    const snapshot = derivedYoYSnapshot(), m = snapshot.metrics.SP500_YOY;
    m.source = {...source};
    m.inputs.forEach(input => { input.source = {...source, url: source.url.replace(/^(https:\/\/[^/]+)/, '$1:443')}; });
    assert.equal(state(snapshot).metrics.SP500_YOY.usable, true, source.name);
    const changed = new URL(m.inputs[1].source.url);
    changed.searchParams.set('cosd', '2024-01-01');
    m.inputs[1].source.url = changed.href;
    assert.match(state(snapshot).metrics.SP500_YOY.reason, /来源/);
  }
});

test('same-source YoY rejects forged output or input values and enforces absolute 1e-6 tolerance', () => {
  for (const mutate of [m => { m.value += 1; }, m => { m.inputs[0].value += 1; }, m => { m.inputs[1].value += 1; }]) {
    const snapshot = derivedYoYSnapshot();
    mutate(snapshot.metrics.SP500_YOY);
    const result = state(snapshot).metrics.SP500_YOY;
    assert.equal(result.usable, false);
    assert.match(result.reason, /inputs.*公式/);
  }
  for (const delta of [-2e-6, -.5e-6, 0, .5e-6, 2e-6]) {
    const snapshot = derivedYoYSnapshot();
    snapshot.metrics.SP500_YOY.value += delta;
    assert.equal(state(snapshot).metrics.SP500_YOY.usable, Math.abs(delta) <= 1e-6, String(delta));
  }
  const overflow = derivedYoYSnapshot();
  overflow.metrics.SP500_YOY.inputs[0].value = Number.MAX_VALUE;
  overflow.metrics.SP500_YOY.inputs[1].value = Number.MIN_VALUE;
  assert.match(state(overflow).metrics.SP500_YOY.reason, /公式/);
});

test('YoY latest observation must match its metric and input order cannot be reversed', () => {
  const snapshot = derivedYoYSnapshot();
  snapshot.metrics.SP500_YOY.inputs[0].observationDate = '2026-06-30';
  assert.equal(state(snapshot).metrics.SP500_YOY.usable, false);
  assert.match(state(snapshot).metrics.SP500_YOY.reason, /最新观测日期/);
  const swapped = derivedYoYSnapshot();
  swapped.metrics.SP500_YOY.inputs.reverse();
  assert.match(state(swapped).metrics.SP500_YOY.reason, /最新观测日期/);
});

test('daily YoY baseline allows only the prior-year anniversary or up to seven preceding days', () => {
  for (const [date, usable] of [
    ['2025-07-01', true], ['2025-06-30', true], ['2025-06-24', true],
    ['2025-06-23', false], ['2025-07-02', false], ['2024-07-01', false]
  ]) {
    const snapshot = derivedYoYSnapshot();
    snapshot.metrics.SP500_YOY.inputs[1].observationDate = date;
    const result = state(snapshot).metrics.SP500_YOY;
    assert.equal(result.usable, usable, date);
    if (!usable) assert.match(result.reason, /同比基期/);
  }
});

test('daily YoY leap-day anniversary matches the collector February 28 clamp', () => {
  const at = '2024-03-01T10:00:00Z';
  for (const [date, usable] of [['2023-02-28', true], ['2023-02-21', true], ['2023-02-20', false], ['2023-03-01', false]]) {
    const snapshot = derivedYoYSnapshot(), m = snapshot.metrics.SP500_YOY;
    snapshot.generatedAt = at;
    m.observationDate = m.inputs[0].observationDate = '2024-02-29';
    m.fetchedAt = at;
    m.inputs.forEach(input => { input.fetchedAt = at; });
    m.inputs[1].observationDate = date;
    assert.equal(model.compute(snapshot, {now: at}).metrics.SP500_YOY.usable, usable, date);
  }
});

test('every derived YoY ID enforces its same-source formula and positive, exact macro baseline', () => {
  for (const id of model.METRIC_IDS.filter(id => id.endsWith('_YOY'))) {
    const snapshot = derivedYoYSnapshot(id), m = snapshot.metrics[id];
    assert.equal(state(snapshot).metrics[id].usable, true, id);
    for (const base of [0, -100]) {
      const invalid = derivedYoYSnapshot(id);
      invalid.metrics[id].inputs[1].value = base;
      assert.match(state(invalid).metrics[id].reason, /基期必须为正/, id);
    }
    const alien = derivedYoYSnapshot(id);
    alien.metrics[id].inputs[1].source.name = 'Other provider';
    assert.match(state(alien).metrics[id].reason, /来源/, id);
    const forged = derivedYoYSnapshot(id);
    forged.metrics[id].value += 1;
    assert.match(state(forged).metrics[id].reason, /公式/, id);
    if (m.frequency !== 'daily') {
      for (const offset of [-1, 1, -7]) {
        const invalid = derivedYoYSnapshot(id), input = invalid.metrics[id].inputs[1];
        input.observationDate = new Date(Date.parse(input.observationDate) + offset * 86400000).toISOString().slice(0, 10);
        assert.match(state(invalid).metrics[id].reason, /同比基期/, id + '/' + offset);
      }
    }
    for (const latest of [0, -100, 5600]) {
      m.inputs[0].value = latest;
      m.value = (latest / m.inputs[1].value - 1) * 100;
      assert.equal(state(snapshot).metrics[id].usable, true, id + '/' + latest);
    }
  }
});

test('real production snapshot retains all 28 usable metrics including 9 derived, but forged inputs fail', () => {
  const snapshot = productionSnapshot(), result = productionState(snapshot);
  const usable = model.METRIC_IDS.filter(id => result.metrics[id].usable);
  const derived = usable.filter(id => snapshot.metrics[id].kind === 'derived');
  assert.equal(usable.length, 28);
  assert.equal(derived.length, 9);
  assert.deepEqual(usable, model.METRIC_IDS.filter(id => snapshot.metrics[id].status === 'ok'));
  for (const id of derived) {
    const forged = productionSnapshot();
    forged.metrics[id].inputs[1].value += 1;
    assert.equal(productionState(forged).metrics[id].usable, false, id);
    assert.match(productionState(forged).metrics[id].reason, /公式/, id);
  }
});

test('debt/GDP accepts distinct FRED debt and GDP sources only for the metric quarter and converted formula', () => {
  const snapshot = productionSnapshot(), m = snapshot.metrics.CORP_DEBT_GDP;
  assert.notEqual(m.inputs[0].source.name, m.inputs[1].source.name);
  assert.notEqual(m.inputs[0].source.url, m.inputs[1].source.url);
  assert.equal(productionState(snapshot).metrics.CORP_DEBT_GDP.usable, true);
  close(m.value, m.inputs[0].value / 1000 / m.inputs[1].value * 100);
  for (const index of [0, 1]) {
    const wrongQuarter = productionSnapshot();
    wrongQuarter.metrics.CORP_DEBT_GDP.inputs[index].observationDate = '2026-01-01';
    assert.match(productionState(wrongQuarter).metrics.CORP_DEBT_GDP.reason, /观测季度/);
  }
  const bothWrong = productionSnapshot();
  bothWrong.metrics.CORP_DEBT_GDP.inputs.forEach(input => { input.observationDate = '2026-01-01'; });
  assert.match(productionState(bothWrong).metrics.CORP_DEBT_GDP.reason, /观测季度/);
  for (const mutate of [
    m => { m.value = m.inputs[0].value / m.inputs[1].value * 100; },
    m => { m.inputs[0].value += 1000; }, m => { m.inputs[1].value += 100; }
  ]) {
    const forged = productionSnapshot();
    mutate(forged.metrics.CORP_DEBT_GDP);
    assert.match(productionState(forged).metrics.CORP_DEBT_GDP.reason, /公式/);
  }
  for (const delta of [-2e-6, -.5e-6, .5e-6, 2e-6]) {
    const rounded = productionSnapshot();
    rounded.metrics.CORP_DEBT_GDP.value += delta;
    assert.equal(productionState(rounded).metrics.CORP_DEBT_GDP.usable, Math.abs(delta) <= 1e-6);
  }
});

test('debt/GDP rejects wrong series names, URL identities, reordered or extra inputs', () => {
  for (const [location, patch] of [
    [0, {name: 'FRED GDP'}], [1, {name: 'Other GDP provider'}],
    [0, {url: 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=GDP'}],
    [1, {url: 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=CP'}],
    [0, {url: 'https://other.example.org/graph/fredgraph.csv?id=BCNSDODNS'}],
    [1, {url: 'https://fred.stlouisfed.org/series/GDP?id=GDP'}],
    [1, {url: 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=GDP&id=CP'}],
    ['metric', {url: 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=BCNSDODNS,CP'}],
    ['metric', {url: 'https://other.example.org/graph/fredgraph.csv?id=BCNSDODNS,GDP'}]
  ]) {
    const snapshot = productionSnapshot(), m = snapshot.metrics.CORP_DEBT_GDP;
    Object.assign(location === 'metric' ? m.source : m.inputs[location].source, patch);
    assert.match(productionState(snapshot).metrics.CORP_DEBT_GDP.reason, /来源或series ID/);
  }
  for (const mutate of [m => { m.inputs.reverse(); }, m => { m.inputs.push({...m.inputs[1]}); }]) {
    const snapshot = productionSnapshot();
    mutate(snapshot.metrics.CORP_DEBT_GDP);
    assert.match(productionState(snapshot).metrics.CORP_DEBT_GDP.reason, /来源或series ID/);
  }
});

test('debt/GDP permits zero debt but requires a nonnegative numerator and positive denominator', () => {
  for (const [debt, gdp, usable] of [[0, 100, true], [-1, 100, false], [1000, 0, false], [1000, -100, false]]) {
    const snapshot = productionSnapshot(), m = snapshot.metrics.CORP_DEBT_GDP;
    m.inputs[0].value = debt; m.inputs[1].value = gdp;
    m.value = gdp > 0 ? debt / 1000 / gdp * 100 : 0;
    assert.equal(productionState(snapshot).metrics.CORP_DEBT_GDP.usable, usable);
    if (!usable) assert.match(productionState(snapshot).metrics.CORP_DEBT_GDP.reason, /分子或分母/);
  }
});

test('undefined derived contracts cannot claim metadata-only compliance', () => {
  const snapshot = fixture(), m = snapshot.metrics.SP500;
  m.kind = 'derived';
  m.inputs = [inputMetadata(m.observationDate, m.fetchedAt, m.value, m.source), inputMetadata('2025-07-01', m.fetchedAt, 5600, m.source)];
  assert.equal(state(snapshot).metrics.SP500.usable, false);
  assert.match(state(snapshot).metrics.SP500.reason, /合同未定义/);
});

test('BTC historical N/A uses eligible denominator, while true missing data still reduces coverage', () => {
  const full = state(fixture());
  for (const benchmark of full.benchmarks) close(benchmark.coverage, 1);
  close(full.historical.coverage, 1);
  for (const benchmark of full.benchmarks.slice(0, 2)) {
    const btc = benchmark.dimensions.find(d => d.id === 'btc');
    assert.equal(btc.applicable, false);
    assert.equal(btc.parts[0].applicable, false);
    assert.equal(btc.score, null);
    const effectiveWeight = benchmark.dimensions.reduce((sum, d) => sum + d.weight * d.coverage, 0);
    close(effectiveWeight, .95);
    close(benchmark.score, benchmark.dimensions.reduce((sum, d) => sum + (d.score ?? 0) * d.weight * d.coverage, 0) / effectiveWeight);
  }
  assert.match(model.renderHTML(full), /data-dimension="btc">N\/A历史无资产 · 不计覆盖分母/);
  const missingBTC = fixture(); missingBTC.metrics.BTC_YOY.value = null;
  const result = state(missingBTC);
  close(result.benchmarks[0].coverage, 1);
  close(result.benchmarks[1].coverage, 1);
  for (const b of result.benchmarks.slice(2)) {
    close(b.coverage, .95);
    assert.equal(b.dimensions.find(d => d.id === 'btc').applicable, true);
  }
  const missingGold = fixture(); missingGold.metrics.GOLD_YOY.value = null;
  close(state(missingGold).benchmarks[0].coverage, .85 / .95);
  const malformed = {...model.BENCHMARKS[0], values: {...model.BENCHMARKS[0].values}};
  delete malformed.values.BTC_YOY;
  const badReference = model.calculateBenchmark(full.metrics, malformed);
  close(badReference.coverage, .95);
  assert.equal(badReference.dimensions.find(d => d.id === 'btc').applicable, true, 'absent reference is not evidence the asset did not exist');
});

test('missing one observation reduces coverage without clearing risk; 60%/50% gates apply', () => {
  const full = state(fixture(VALUES_B));
  for (const id of ['UNRATE', 'VIXCLS', 'CPI_YOY', 'CAPE', 'WTI']) {
    const s = fixture(VALUES_B); s.metrics[id].value = null;
    const result = state(s);
    assert.ok(result.system.score > 0);
    assert.ok(result.historical.score > 0);
    assert.notEqual(result.composite.score, 0);
    assert.ok(result.system.coverage <= full.system.coverage);
  }
  const partial = fixture(VALUES_B);
  partial.metrics.UNRATE.value = null;
  close(state(partial).system.coverage, .88);
  close(state(partial).triggers.coverage, .50);
  assert.ok(state(partial).composite.score > 0);
  partial.metrics.WTI.value = null;
  assert.equal(state(partial).triggers.score, null);
  assert.equal(state(partial).composite.score, null);
  assert.ok(state(partial).system.score > 0);
  const sparse = fixture({SP500_YOY: -30, CPI_YOY: 5, UNRATE: 6});
  assert.ok(state(sparse).system.coverage < .6);
  assert.equal(state(sparse).system.score, null);
  assert.equal(state(sparse).historical.score, null);
});

test('main score retains all evidence and IQR never forcibly deletes the minimum', () => {
  const items = [45, 48, 50, 52, 55].map((score, i) => ({name: String(i), score, weight: .2, coverage: 1}));
  const result = model.iqrSensitivity(items);
  assert.deepEqual(result.removed, []);
  assert.equal(result.kept, 5);
  const s = state(fixture());
  for (const b of s.benchmarks) {
    const weight = b.dimensions.reduce((sum, d) => sum + d.weight * d.coverage, 0);
    close(b.score, b.dimensions.reduce((sum, d) => sum + (d.score ?? 0) * d.weight * d.coverage, 0) / weight);
  }
});

test('DOM output changes for actual metrics, dimension/benchmark/system/trigger/composite values and EPS', () => {
  const element = {innerHTML: ''};
  const a = state(fixture()), b = state(fixture(VALUES_B));
  model.render(element, a); const before = element.innerHTML;
  model.render(element, b); const after = element.innerHTML;
  for (const [attr, keys] of [
    ['data-value', ['SP500', 'NASDAQ', 'GOLD', 'WTI', 'BTC', 'DGS10', 'CPI_YOY', 'EPS_TTM']],
    ['data-score', ['historical', 'system', 'trigger-pressure', 'composite']],
    ['data-benchmark', ['2000', '2008', '2020', '2022']],
    ['data-dimension', ['equity', 'earn', 'rates', 'dxy', 'gold', 'oil', 'infl', 'corp']],
    ['data-system', model.SYSTEM_INDICATORS.map(x => x.id)],
    ['data-trigger', ['t10y5', 'oil100', 'credit', 'jobs', 'fedhike']]
  ]) for (const key of keys) {
    const re = new RegExp(`${attr}="${key}">([^<]*)<`);
    const av = before.match(re), bv = after.match(re);
    assert.ok(av && bv, attr + '/' + key);
    assert.notEqual(av[1], bv[1], attr + '/' + key);
  }
  assert.match(before, /未校准/);
  assert.match(before, /2026-07-02T10:00:00Z/);
  assert.doesNotMatch(before, /出清概率|期望损伤|共识\(GS\)|沃什|霍尔木兹/);
});

test('all dynamic strings are escaped and source URLs must be HTTPS', () => {
  const s = fixture();
  const payload = '<img src=x onerror="alert(1)">';
  s.metrics.CPI_YOY.unit = payload;
  s.metrics.CPI_YOY.source.name = payload;
  s.metrics.CPI_YOY.source.url = 'javascript:alert(1)';
  s.metrics.CPI_YOY.observationDate = payload;
  s.metrics.CPI_YOY.error = payload;
  s.errors = [payload, {error: payload}];
  s.lastSuccessfulAt = payload;
  const html = model.renderHTML(state(s));
  assert.doesNotMatch(html, /<img|href="javascript:/);
  assert.match(html, /&lt;img/);
  assert.equal(model.httpsURL('http://example.org'), null);
  assert.equal(model.httpsURL('https://user:pass@example.org'), null);
  assert.equal(model.httpsURL('https://example.org/a?q="<bad>'), 'https://example.org/a?q=%22%3Cbad%3E');
});

test('historic scenario windows are explicitly dated/expired and never alter daily scores', () => {
  const s = state(fixture());
  assert.equal(s.scenarios.formulatedAt, '2026-07-01');
  assert.equal(s.scenarios.windows[0].expired, false);
  const old = model.compute(fixture(), {now: '2028-01-01T00:00:00Z'});
  assert.ok(old.scenarios.windows.every(w => w.expired));
  assert.equal(old.composite.score, null);
  assert.match(model.renderHTML(old), /已过期/);
});

function browserModel() {
  class FrozenDate extends Date {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW; }
  }
  const nodes = new Map();
  const document = {getElementById(id) { if (!nodes.has(id)) nodes.set(id, {innerHTML: ''}); return nodes.get(id); }, querySelector() { return null; }};
  const context = vm.createContext({window: {}, Date: FrozenDate, document, console, URL, AbortController, setTimeout, clearTimeout});
  vm.runInContext(sharedSource, context);
  context.CrisisDaily = context.window.CrisisDaily;
  return {context, nodes};
}
const declaration = (html, name) => {
  const match = html.match(new RegExp(`(?:async )?function ${name}\\([^\\n]*\\)\\{[\\s\\S]*?\\n\\}`));
  assert.ok(match, name); return match[0];
};

test('PC/mobile scripts parse, module precedes app, paths resolve to same snapshot, and loadAll refreshes both DOM regions', async () => {
  for (const [file, mobile] of [['index.html', false], ['m/index.html', true]]) {
    const html = readFileSync(new URL(file, root), 'utf8');
    const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
    for (const [i, script] of scripts.entries()) new vm.Script(script[1], {filename: file + '/script-' + i});
    const modulePath = mobile ? '../js/crisis-daily.js' : 'js/crisis-daily.js';
    const dataPath = mobile ? '../data/crisis-daily.json' : 'data/crisis-daily.json';
    assert.equal(new URL(modulePath, new URL(file, root)).href, new URL('js/crisis-daily.js', root).href);
    assert.equal(new URL(dataPath, new URL(file, root)).href, new URL('data/crisis-daily.json', root).href);
    assert.ok(html.indexOf(`src="${modulePath}"`) < html.indexOf('/* ==================== CONFIG'));
    const {context, nodes} = browserModel();
    const section = html.match(/const BUBBLE_2000=[\s\S]*?let CW_SCORE=cwCalcScore\(\);/);
    assert.ok(section, 'historical anchors and shared score initialization exist');
    vm.runInContext(section[0], context);
    assert.equal(vm.runInContext('CW_SCORE', context), null);
    vm.runInContext(declaration(html, 'renderCrisis'), context);
    vm.runInContext(declaration(html, 'renderCrisisWarning'), context);
    vm.runInContext(declaration(html, 'loadAll'), context);
    vm.runInContext(`let refreshing=false; let _loadRetryCount=0;
      const CURATED={}; const ${mobile ? 'viewRendered' : 'rendered'}={dashboard:true,dash:true,crisis:true,cycle:true};
      function setStatus(){} function renderDashboard(){} function renderDash(){}
      function fetchFX(){return Promise.resolve({})}
      function fetchMarket(){return Promise.resolve({sp500:999999,sp500YoY:9999,t10y:0})}
      function fetchMacro(){return Promise.resolve({cpi:99,vixIndex:0})}
      ${mobile ? 'let cache=null;' : ''}`, context);
    const urls = [];
    let supplied = fixture();
    context.fetch = async (url, options) => { urls.push({url, options}); return {ok: true, json: async () => supplied}; };
    // globalThis.fetch is used by the shared browser module.
    const crisisId = mobile ? 'v-crisis' : 'crisisContent';
    context.document.getElementById('cycleCrisisDaily').innerHTML = 'old';
    const cycle = context.document.getElementById('cycleCrisisDaily');
    const consumerStates = [];
    const originalRender = context.CrisisDaily.render;
    context.CrisisDaily.render = (target, suppliedState) => {
      consumerStates.push(suppliedState);
      return originalRender(target, suppliedState);
    };
    await context.loadAll();
    assert.equal(consumerStates.length, 2);
    assert.equal(consumerStates[0], consumerStates[1], 'crisis and cycle consume the identical computed state');
    const before = nodes.get(crisisId).innerHTML;
    const previousScore = vm.runInContext('CW_SCORE', context);
    assert.equal(urls[0].url, dataPath);
    assert.equal(urls[0].options.cache, 'no-store');
    assert.match(before, /6,100\.00/);
    assert.doesNotMatch(before, /999,999|9,999/);
    assert.equal(cycle.innerHTML, before);
    const oldElement = cycle;
    supplied = fixture(VALUES_B, '2026-07-02T11:00:00Z');
    await context.loadAll();
    assert.notEqual(vm.runInContext('CW_SCORE', context), previousScore);
    assert.notEqual(nodes.get(crisisId).innerHTML, before);
    assert.equal(cycle, oldElement, 'cycle wrapper is updated without replacing charts');
    assert.equal(cycle.innerHTML, nodes.get(crisisId).innerHTML);
    assert.match(html, /id="cycleCrisisDaily"/);
    context.CrisisDaily.setSnapshot(fixture({}));
    assert.equal(context.cwCalcScore(), null);
    context.renderCrisis();
    assert.match(nodes.get(crisisId).innerHTML, /暂无数据/);
  }
});

test('loader failure retains original date, rejects older responses, and rechecks freshness rather than relabeling today', async () => {
  const {context} = browserModel(), api = context.CrisisDaily;
  const newer = fixture(VALUES_B, '2026-07-02T11:00:00Z');
  api.setSnapshot(newer);
  await api.load({fetch: async () => ({ok: true, json: async () => fixture()})});
  assert.equal(api.getState().generatedAt, newer.generatedAt);
  await api.load({fetch: async () => { throw new Error('<b>offline</b>'); }});
  assert.equal(api.getState().generatedAt, newer.generatedAt);
  assert.match(api.renderHTML(), /本次读取失败/);
  assert.doesNotMatch(api.renderHTML(), /<b>offline<\/b>/);
  await api.load({now: NOW + 4 * 86400000, fetch: async () => ({ok: false, status: 503})});
  assert.equal(api.getState({now: NOW + 4 * 86400000}).composite.score, null);
  await api.load({fetch: async () => ({ok: true, json: async () => ({schemaVersion: 99})})});
  assert.equal(api.getState().generatedAt, newer.generatedAt);
});

test('future response never poisons the baseline and a corrected response can recover', async () => {
  const {context} = browserModel(), api = context.CrisisDaily;
  const previous = fixture(VALUES_A, '2026-07-02T10:00:00Z');
  api.setSnapshot(previous);
  const future = fixture(VALUES_B, '2027-07-02T10:00:00Z');
  await api.load({fetch: async () => ({ok: true, json: async () => future})});
  assert.equal(api.getState().generatedAt, previous.generatedAt);
  assert.match(api.renderHTML(), /快照生成时间在未来/);
  const corrected = fixture(VALUES_B, '2026-07-02T11:30:00Z');
  await api.load({fetch: async () => ({ok: true, json: async () => corrected})});
  assert.equal(api.getState().generatedAt, corrected.generatedAt);
  assert.ok(api.getState().composite.score !== null);
  assert.doesNotMatch(api.renderHTML(), /本次读取失败/);
});

test('Financial Accounts Q2 remains valid before its longer December publication lag', () => {
  const date = '2026-12-09T12:00:00Z';
  const s = fixture(VALUES_A, date);
  Object.assign(s.metrics.CORP_DEBT_GDP, {observationDate: '2026-04-01', periodEnd: '2026-06-30', frequency: 'quarterly', maxAgeDays: 180});
  const result = model.compute(s, {now: date});
  assert.equal(result.metrics.CORP_DEBT_GDP.usable, true);
  assert.equal(result.metrics.CORP_DEBT_GDP.maxAgeDays, 180);
  assert.ok(result.metrics.CORP_DEBT_GDP.ageDays > 160);
});
