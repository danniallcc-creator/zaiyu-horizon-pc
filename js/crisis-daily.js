/* Shared daily assessment. Browser quotes are deliberately not scoring inputs. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.CrisisDaily = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';
  const DAY = 86400000;
  const VERSION = 'daily-1.0';
  const AGE_LIMITS = Object.freeze({daily: 7, monthly: 75, quarterly: 160});
  const SNAPSHOT_MAX_AGE = 2 * DAY;
  const MIN_COVERAGE = 0.60;
  const METRIC_IDS = Object.freeze([
    'SP500', 'NASDAQ', 'SP500_YOY', 'NASDAQ_YOY', 'DXY', 'DXY_YOY',
    'GOLD', 'GOLD_YOY', 'WTI', 'WTI_YOY', 'BTC', 'BTC_YOY',
    'DGS2', 'DGS5', 'DGS10', 'DGS30', 'T10Y2Y', 'VIXCLS', 'UNRATE',
    'UMCSENT', 'DCCLACBS', 'CSUSHPINSA_YOY', 'BAMLH0A0HYM2', 'CPI_YOY',
    'PCE_CORE_YOY', 'DFEDTARL', 'DFEDTARU', 'CAPE', 'PE_TTM',
    'CORP_PROFIT_YOY', 'CORP_DEBT_GDP', 'CONCENTRATION', 'EPS_TTM'
  ]);
  // Fixed ID contracts mirror the collector; snapshot metadata cannot enlarge grace periods.
  const METRIC_RULES = Object.freeze(Object.fromEntries(METRIC_IDS.map(id => {
    const frequency = ['DCCLACBS', 'CORP_PROFIT_YOY', 'CORP_DEBT_GDP', 'EPS_TTM'].includes(id) ? 'quarterly'
      : ['UNRATE', 'UMCSENT', 'CSUSHPINSA_YOY', 'CPI_YOY', 'PCE_CORE_YOY', 'CONCENTRATION'].includes(id) ? 'monthly' : 'daily';
    return [id, Object.freeze({frequency, maxAgeDays: id === 'CSUSHPINSA_YOY' ? 120 : id === 'CORP_DEBT_GDP' ? 180 : AGE_LIMITS[frequency]})];
  })));
  const LABELS = Object.freeze({
    SP500: '标普500', NASDAQ: '纳斯达克', SP500_YOY: '标普500同比', NASDAQ_YOY: '纳指同比',
    DXY: '美元指数', DXY_YOY: '美元指数同比', GOLD: '黄金', GOLD_YOY: '黄金同比',
    WTI: 'WTI原油', WTI_YOY: 'WTI同比', BTC: '比特币', BTC_YOY: 'BTC同比',
    DGS2: '2Y国债', DGS5: '5Y国债', DGS10: '10Y国债', DGS30: '30Y国债',
    T10Y2Y: '10Y-2Y利差', VIXCLS: 'VIX', UNRATE: '失业率', UMCSENT: '消费者信心',
    DCCLACBS: '信用卡拖欠率', CSUSHPINSA_YOY: 'Case-Shiller房价同比',
    BAMLH0A0HYM2: '高收益债OAS', CPI_YOY: 'CPI同比', PCE_CORE_YOY: '核心PCE同比',
    DFEDTARL: 'Fed目标下限', DFEDTARU: 'Fed目标上限', CAPE: 'CAPE', PE_TTM: 'TTM PE',
    CORP_PROFIT_YOY: 'BEA全美企业利润同比（非Mag7）', CORP_DEBT_GDP: '企业债务/GDP',
    CONCENTRATION: '市场集中度（口径见来源）', EPS_TTM: '标普500 真实通胀调整12月EPS（非名义/营运/共识）'
  });
  // Original nine dimension weights and four historical anchors. These are model parameters, not quotes.
  const DIMENSIONS = Object.freeze([
    {id: 'equity', name: '美股走势', weight: .15, parts: [['SP500_YOY', .5, 20], ['NASDAQ_YOY', .5, 20]], context: ['SP500', 'NASDAQ']},
    {id: 'earn', name: '盈利与估值', weight: .20, parts: [['CAPE', .4, 17], ['PE_TTM', .3, 15], ['CONCENTRATION', .3, 20]], context: ['EPS_TTM']},
    {id: 'rates', name: '利率环境', weight: .15, parts: [['DGS30', .5, 1], ['DGS10', .3, 1], ['DGS5', .2, 1]], context: ['DGS2', 'T10Y2Y', 'DFEDTARL', 'DFEDTARU']},
    {id: 'dxy', name: '美元走势', weight: .08, parts: [['DXY_YOY', 1, 50]], context: ['DXY']},
    {id: 'gold', name: '黄金走势', weight: .10, parts: [['GOLD_YOY', 1, 100]], context: ['GOLD']},
    {id: 'btc', name: 'BTC走势', weight: .05, parts: [['BTC_YOY', 1, 100]], context: ['BTC']},
    {id: 'oil', name: '石油价格', weight: .08, parts: [['WTI_YOY', 1, 200]], context: ['WTI']},
    {id: 'infl', name: 'PCE / CPI', weight: .08, parts: [['CPI_YOY', .5, 2], ['PCE_CORE_YOY', .5, 2]], context: []},
    {id: 'corp', name: '企业健康度', weight: .11, parts: [['CORP_PROFIT_YOY', .6, 10], ['CONCENTRATION', .4, 20]], context: ['CORP_DEBT_GDP']}
  ]);
  const BENCHMARKS = Object.freeze([
    {id: '2000', label: '2000 互联网泡沫', weight: .8, values: {SP500_YOY: 19.3, NASDAQ_YOY: 85.6, CAPE: 44.19, PE_TTM: 32, CONCENTRATION: 27, DGS30: 6, DGS10: 6.3, DGS5: 5.9, DXY_YOY: 25, GOLD_YOY: -4.9, BTC_YOY: null, WTI_YOY: 192, CPI_YOY: 3.4, PCE_CORE_YOY: 2, CORP_PROFIT_YOY: 3.8}},
    {id: '2008', label: '2008 金融危机', weight: .0667, values: {SP500_YOY: -18, NASDAQ_YOY: -22, CAPE: 27.5, PE_TTM: 22, CONCENTRATION: 20, DGS30: 5.1, DGS10: 5, DGS5: 5.2, DXY_YOY: 10, GOLD_YOY: 28, BTC_YOY: null, WTI_YOY: -56, CPI_YOY: 3.8, PCE_CORE_YOY: 2.3, CORP_PROFIT_YOY: -22}},
    {id: '2020', label: '2020 疫情冲击', weight: .0667, values: {SP500_YOY: 5.7, NASDAQ_YOY: 18, CAPE: 31.8, PE_TTM: 22, CONCENTRATION: 27, DGS30: 2, DGS10: 1.7, DGS5: 1.4, DXY_YOY: 1.5, GOLD_YOY: 15, BTC_YOY: -30, WTI_YOY: -40, CPI_YOY: 2.3, PCE_CORE_YOY: 1.8, CORP_PROFIT_YOY: -24}},
    {id: '2022', label: '2022 加息冲击', weight: .0666, values: {SP500_YOY: -18.1, NASDAQ_YOY: -29, CAPE: 28.8, PE_TTM: 20, CONCENTRATION: 28, DGS30: 4.2, DGS10: 3.9, DGS5: 4.1, DXY_YOY: 10, GOLD_YOY: -1, BTC_YOY: -63, WTI_YOY: 10, CPI_YOY: 6.5, PCE_CORE_YOY: 5, CORP_PROFIT_YOY: 5}}
  ]);
  const SYSTEM_INDICATORS = Object.freeze([
    {id: 'T10Y2Y', weight: .15, min: -1, max: 3, lower: true},
    {id: 'VIXCLS', weight: .12, min: 10, max: 80},
    {id: 'UNRATE', weight: .12, min: 3, max: 15},
    {id: 'UMCSENT', weight: .10, min: 40, max: 110, lower: true},
    {id: 'DCCLACBS', weight: .13, min: 1.5, max: 7},
    {id: 'CSUSHPINSA_YOY', weight: .10, min: -5, max: 20},
    {id: 'BAMLH0A0HYM2', weight: .15, min: 2, max: 12},
    {id: 'SP500_YOY', weight: .13, min: -40, max: 40, lower: true}
  ]);
  const TRIGGERS = Object.freeze([
    {id: 't10y5', label: '10Y接近5%阈值', weight: .18, impact: .95, inputs: ['DGS10'], note: '10Y单日接近程度，不代表已突破并维持', ranges: [[3, 5]]},
    {id: 'capex', label: 'AI资本开支回报', weight: .20, impact: .95, inputs: [], note: '无可验证资本开支/回报序列，待数据'},
    {id: 'ipo', label: '大型AI IPO表现', weight: .14, impact: .75, inputs: [], note: '无IPO表现序列，待数据'},
    {id: 'credit', label: '信用压力（HY代理）', weight: .14, impact: .95, inputs: ['BAMLH0A0HYM2'], note: '高收益债OAS代理，非数据中心或私募信贷违约监测', ranges: [[2, 8]]},
    {id: 'oil100', label: 'WTI接近100美元', weight: .08, impact: .55, inputs: ['WTI'], note: 'WTI现值接近阈值，不是Brent或地缘事件判断', ranges: [[60, 100]]},
    {id: 'fedhike', label: '通胀/政策压力（代理）', weight: .10, impact: .95, inputs: ['CPI_YOY', 'PCE_CORE_YOY', 'DFEDTARL', 'DFEDTARU'], note: 'CPI、核心PCE及目标利率压力等权代理，非政策预测', ranges: [[2, 6], [2, 5], [2, 6], [2, 6]]},
    {id: 'jobs', label: '就业压力（失业率）', weight: .08, impact: .55, inputs: ['UNRATE'], note: '失业率水平压力，不能据此断言就业突然恶化', ranges: [[3.5, 6.5]]},
    {id: 'reg', label: 'AI监管/安全事件', weight: .08, impact: .45, inputs: [], note: '无事件观测源，待数据'}
  ]);
  const SCENARIOS = Object.freeze({
    formulatedAt: '2026-07-01',
    windows: [{label: '2026 Q3', end: '2026-09-30'}, {label: '2026 Q4', end: '2026-12-31'}, {label: '2027 Q1–Q2', end: '2027-06-30'}],
    tiers: [{label: '伪AI / 二三线公司', drop: '40%–70%'}, {label: 'AI基建链', drop: '25%–45%'}, {label: '真正AI龙头', drop: '15%–30%'}]
  });
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const clamp = n => Math.max(0, Math.min(1, n));
  const escapeHTML = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  function httpsURL(value) {
    try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; }
    catch (_) { return null; }
  }
  function isoTime(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) return NaN;
    const time = Date.parse(value);
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value.slice(0, 10) ? time : NaN;
  }
  function observationTime(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}(?:-\d{2})?$/.test(value)) return NaN;
    const day = value.length === 7 ? value + '-01' : value;
    const time = Date.parse(day + 'T00:00:00Z');
    return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === day ? time : NaN;
  }
  function validSource(source) {
    return source && typeof source.name === 'string' && source.name.trim() && httpsURL(source.url)
      && (source.status === undefined || source.status === 'ok');
  }
  function reportingEnd(id, observed, frequency) {
    if (!Number.isFinite(observed)) return NaN;
    if (frequency === 'daily') return observed;
    const date = new Date(observed), month = date.getUTCMonth(), day = date.getUTCDate();
    const endMonth = frequency === 'quarterly' ? Math.floor(month / 3) * 3 + 3 : month + 1;
    const end = Date.UTC(date.getUTCFullYear(), endMonth, 0);
    // Only period starts are expanded. In particular, Multpl EPS is already quarter-end dated.
    if (observed === end) return end;
    if (id !== 'EPS_TTM' && day === 1 && (frequency === 'monthly' || month % 3 === 0)) return end;
    return NaN;
  }
  function validateInputs(id, m, now, snapshotTime, fetched) {
    if (m.kind === 'derived' && (!Array.isArray(m.inputs) || m.inputs.length < 2)) return '推导数据缺少inputs';
    if (m.inputs === undefined) return null;
    if (!Array.isArray(m.inputs)) return 'inputs格式无效';
    for (const input of m.inputs) {
      if (!input || !finite(input.value) || !validSource(input.source)) return 'inputs数值或来源无效';
      const observed = observationTime(input.observationDate), inputFetched = isoTime(input.fetchedAt);
      if (!Number.isFinite(observed) || !Number.isFinite(inputFetched)) return 'inputs日期或抓取时间无效';
      if (observed > inputFetched || inputFetched > now || inputFetched > snapshotTime || inputFetched > fetched) return 'inputs时间在未来或晚于抓取';
      if (input.status !== undefined && input.status !== 'ok') return 'inputs状态不可用';
    }
    if (m.kind !== 'derived') return null;
    const [latest, base] = m.inputs;
    let expected;
    if (id.endsWith('_YOY')) {
      const sourceURL = httpsURL(m.source.url);
      if (m.inputs.some(input => input.source.name !== m.source.name || httpsURL(input.source.url) !== sourceURL)) return 'inputs同比来源与指标不一致';
      if (latest.observationDate !== m.observationDate) return 'inputs最新观测日期与指标不一致';
      // Collector order is [latest, base]; Feb 29 anniversaries clamp to Feb 28.
      const date = new Date(observationTime(m.observationDate)), year = date.getUTCFullYear() - 1, month = date.getUTCMonth();
      const target = Date.UTC(year, month, Math.min(date.getUTCDate(), new Date(Date.UTC(year, month + 1, 0)).getUTCDate()));
      const lag = (target - observationTime(base.observationDate)) / DAY;
      if (lag < 0 || lag > (METRIC_RULES[id].frequency === 'daily' ? 7 : 0)) return 'inputs同比基期不是上一年同日或合法前一交易日';
      if (base.value <= 0) return 'inputs同比基期必须为正';
      expected = (latest.value / base.value - 1) * 100;
    } else if (id === 'CORP_DEBT_GDP') {
      // This contract deliberately combines two sources: debt in millions, GDP in billions (SAAR).
      const fredSeries = (source, series) => {
        const url = new URL(httpsURL(source.url));
        return url.origin === 'https://fred.stlouisfed.org' && url.pathname === '/graph/fredgraph.csv'
          && url.searchParams.getAll('id').length === 1 && url.searchParams.get('id') === series;
      };
      if (m.inputs.length !== 2 || !fredSeries(m.source, 'BCNSDODNS,GDP')
        || latest.source.name !== 'FRED BCNSDODNS' || !fredSeries(latest.source, 'BCNSDODNS')
        || base.source.name !== 'FRED GDP' || !fredSeries(base.source, 'GDP')) return 'inputs债务/GDP来源或series ID与合同不符';
      if (m.inputs.some(input => input.observationDate !== m.observationDate)) return 'inputs债务/GDP观测季度与指标不一致';
      if (latest.value < 0 || base.value <= 0) return 'inputs债务/GDP分子或分母无效';
      expected = latest.value / 1000 / base.value * 100;
    } else return 'inputs推导指标合同未定义';
    return !finite(expected) || Math.abs(m.value - expected) > 1e-6 ? 'inputs与推导公式数值不符' : null;
  }
  function validateMetric(id, metric, now, snapshotTime, snapshotReason) {
    const m = metric && typeof metric === 'object' ? metric : {};
    const observed = observationTime(m.observationDate), fetched = isoTime(m.fetchedAt);
    const rule = METRIC_RULES[id];
    const expectedEnd = reportingEnd(id, observed, rule.frequency);
    const explicitEnd = m.periodEnd !== undefined;
    const end = explicitEnd && typeof m.periodEnd === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(m.periodEnd)
      ? observationTime(m.periodEnd) : explicitEnd ? NaN : expectedEnd;
    const ageDays = Number.isFinite(end) ? (now - end) / DAY : null;
    let reason = snapshotReason;
    if (!reason && m.status !== 'ok') reason = '状态不可用: ' + (m.status || 'unavailable');
    if (!reason && !finite(m.value)) reason = '数值缺失或非有限数';
    if (!reason && !Number.isFinite(observed)) reason = '观测日期无效';
    if (!reason && (observed > now || observed > snapshotTime)) reason = '观测日期在未来';
    if (!reason && m.frequency !== rule.frequency) reason = '频率无效或与指标ID不符';
    if (!reason && (!Number.isFinite(fetched) || fetched > now || fetched > snapshotTime)) reason = '抓取时间无效或在未来';
    if (!reason && observed > fetched) reason = '观测日期晚于抓取时间';
    if (!reason && (!Number.isFinite(end) || end < observed || end !== expectedEnd)) reason = 'periodEnd无效或与观测期不符';
    if (!reason && (end > fetched || end > snapshotTime || end > now
      || (rule.frequency !== 'daily' && end + DAY > Math.min(fetched, snapshotTime, now)))) reason = '观测期尚未结束或期末在未来';
    if (!reason && ageDays > rule.maxAgeDays) reason = '观测数据过期';
    if (!reason && !['observed', 'derived', 'proxy', 'assumption'].includes(m.kind)) reason = '数据口径无效';
    if (!reason && m.kind === 'assumption') reason = '假设不能作为观测入分';
    if (!reason && !validSource(m.source)) reason = '来源缺失、状态不可用或不是HTTPS';
    if (!reason) reason = validateInputs(id, m, now, snapshotTime, fetched);
    return {...m, value: finite(m.value) ? m.value : null, periodEnd: Number.isFinite(end) ? new Date(end).toISOString().slice(0, 10) : null,
      maxAgeDays: rule.maxAgeDays, usable: !reason, reason: reason || null, ageDays};
  }
  function weighted(items, minimum = 0) {
    const total = items.reduce((sum, x) => sum + x.weight, 0);
    const available = items.filter(x => finite(x.score));
    const covered = available.reduce((sum, x) => sum + x.weight * (x.coverage == null ? 1 : x.coverage), 0);
    const coverage = total ? covered / total : 0;
    const mean = covered ? available.reduce((sum, x) => sum + x.score * x.weight * (x.coverage == null ? 1 : x.coverage), 0) / covered : null;
    return {score: mean !== null && coverage + 1e-12 >= minimum ? mean : null, coverage};
  }
  function proximity(value, reference, scale) {
    if (!finite(value) || !finite(reference)) return null;
    return 100 * clamp(1 - Math.abs(value - reference) / Math.max(Math.abs(reference), scale));
  }
  function iqrSensitivity(dimensions) {
    const items = dimensions.filter(d => finite(d.score));
    if (!items.length) return {score: null, removed: [], kept: 0, total: 0};
    const sorted = items.map(d => d.score).sort((a, b) => a - b);
    const q = p => { const i = (sorted.length - 1) * p, lo = Math.floor(i); return sorted[lo] + (sorted[Math.ceil(i)] - sorted[lo]) * (i - lo); };
    const q1 = q(.25), q3 = q(.75), iqr = q3 - q1;
    const kept = items.filter(d => d.score >= q1 - 1.5 * iqr && d.score <= q3 + 1.5 * iqr);
    return {score: weighted(kept).score, removed: items.filter(d => !kept.includes(d)).map(d => d.name), kept: kept.length, total: items.length};
  }
  function calculateBenchmark(metrics, benchmark) {
    const dimensions = DIMENSIONS.map(d => {
      const parts = d.parts.map(([id, weight, scale]) => {
        const reference = benchmark.values[id];
        const applicable = !(id === 'BTC_YOY' && ['2000', '2008'].includes(benchmark.id) && reference === null);
        return {id, weight, reference, applicable, score: applicable && metrics[id]?.usable ? proximity(metrics[id].value, reference, scale) : null};
      });
      const eligible = parts.filter(p => p.applicable);
      return {...d, ...weighted(eligible), applicable: eligible.length > 0, parts};
    });
    const summary = weighted(dimensions.filter(d => d.applicable), MIN_COVERAGE);
    return {...benchmark, ...summary, dimensions, sensitivity: iqrSensitivity(dimensions)};
  }
  function pressure(value, low, high) { return finite(value) ? 100 * clamp((value - low) / (high - low)) : null; }
  function assessment(score) {
    if (!finite(score)) return {label: '数据覆盖不足，暂停评估', color: '#b9b4ab', advice: '先补齐并核验数据，不从缺失数据推断低风险。'};
    if (score < 35) return {label: '模型压力较低', color: '#4caf72', advice: '维持分散与安全边际，不把低分当成无风险。'};
    if (score < 50) return {label: '结构性警惕', color: '#5b9bd5', advice: '复核高估值敞口与信用风险，保留流动性。'};
    if (score < 65) return {label: '模型压力偏高', color: '#e0a23c', advice: '降低集中度与杠杆，优先核验盈利和融资能力。'};
    return {label: '模型压力高', color: '#e05c5c', advice: '防御与流动性优先，审慎评估风险承受能力。'};
  }
  function compute(snapshot, options = {}) {
    const now = options.now == null ? Date.now() : +new Date(options.now);
    const s = snapshot && typeof snapshot === 'object' ? snapshot : {};
    const generated = isoTime(s.generatedAt);
    let reason = null;
    if (!Number.isFinite(now)) reason = '评估时间无效';
    else if (s.schemaVersion !== 1) reason = '快照缺失或版本不支持';
    else if (!['ok', 'partial', 'failed'].includes(s.runStatus)) reason = '快照运行状态无效';
    else if (!Number.isFinite(generated)) reason = '快照生成时间无效';
    else if (generated > now) reason = '快照生成时间在未来';
    else if (now - generated > SNAPSHOT_MAX_AGE) reason = '每日快照超过48小时未更新';
    else if (s.runStatus === 'failed') reason = '本次采集失败，暂停正式评估';
    const metrics = Object.fromEntries(METRIC_IDS.map(id => [id, validateMetric(id, s.metrics?.[id], now, generated, reason)]));
    const value = id => metrics[id].usable ? metrics[id].value : null;
    const benchmarks = BENCHMARKS.map(b => calculateBenchmark(metrics, b));
    const historicalCoverage = benchmarks.reduce((sum, b) => sum + b.coverage * b.weight, 0);
    const historicalScore = historicalCoverage + 1e-12 >= MIN_COVERAGE && benchmarks.every(b => finite(b.score))
      ? benchmarks.reduce((sum, b) => sum + b.score * b.weight, 0) : null;
    const systemItems = SYSTEM_INDICATORS.map(c => {
      const v = value(c.id), normalized = pressure(v, c.min, c.max);
      return {...c, value: v, score: normalized == null ? null : c.lower ? 100 - normalized : normalized};
    });
    const system = {...weighted(systemItems, MIN_COVERAGE), items: systemItems};
    const triggerItems = TRIGGERS.map(t => {
      const parts = t.inputs.map((id, i) => ({id, weight: 1 / t.inputs.length, score: pressure(value(id), ...t.ranges[i])}));
      return {...t, ...weighted(parts), parts};
    });
    const triggerPressure = weighted(triggerItems.map(t => ({...t, score: t.score == null ? null : t.score * t.impact})), .50);
    const compositeScore = finite(historicalScore) && finite(triggerPressure.score) ? .5 * historicalScore + .5 * triggerPressure.score : null;
    const verdict = assessment(compositeScore);
    const rule = (id, name, inputs, predicate, note) => {
      const vals = inputs.map(value);
      return {id, name, inputs, signal: vals.some(v => v === null) ? 'missing' : predicate(...vals) ? 'watch' : 'not-triggered', note};
    };
    const anomalies = [
      rule('duration', '长债与股票同向压力', ['DGS30', 'SP500_YOY'], (rate, ret) => rate > 4.5 && ret > 0, '长债高于模型阈值且股指同比为正；不等于股市创新高或必然下跌。'),
      rule('hedge', '黄金与股票同步上涨', ['GOLD_YOY', 'SP500_YOY'], (gold, sp) => gold > 20 && sp > 0, '价格共振提示需核验驱动因素，不能据此推断聪明钱或政治动机。'),
      rule('inflation', '通胀与政策目标压力', ['CPI_YOY', 'PCE_CORE_YOY', 'DFEDTARU'], (cpi, pce, rate) => cpi > 3 && pce > 2 && rate > 4, '水平阈值组合，非加息概率或政策转向判断。'),
      rule('concentration', '集中度', ['CONCENTRATION'], concentration => concentration > 30, '来源口径需一致；不能直接把前十集中度当成Mag7权重。'),
      rule('valuation', 'CAPE压力', ['CAPE'], cape => cape > 30, '估值模型阈值，不能用于精确择时。'),
      rule('energy', '能源与通胀压力', ['WTI', 'CPI_YOY'], (oil, cpi) => oil > 90 && cpi > 3, '价格水平组合，不断言战争或供给事件。'),
      rule('profit', '企业利润压力', ['CORP_PROFIT_YOY'], profit => profit < 0, 'BEA全美企业利润，不是Mag7净利润/现金流。'),
      rule('debt', '企业债务压力', ['CORP_DEBT_GDP'], debt => debt > 75, '企业债务/GDP口径和频率见来源。')
    ];
    const truth = [
      rule('bonds', '长债：融资成本而非繁荣证明', ['DGS30'], rate => rate > 4.5, '只有收益率水平证据，不能判断增长质量或中性利率。'),
      rule('equities', '股票：盈利与估值共同核验', ['SP500_YOY', 'CAPE', 'CORP_PROFIT_YOY'], (ret, cape, profit) => ret > 0 && (cape > 30 || profit <= 0), '上涨不等于真实繁荣；企业利润代理非指数成分盈利。'),
      rule('oil', '石油：价格不证明需求繁荣', ['WTI', 'WTI_YOY'], (price, ret) => price > 90 && ret > 0, '缺少供需证据，不能给价格上涨指定政治原因。'),
      rule('dollar', '美元/黄金：共振需核验', ['DXY_YOY', 'GOLD_YOY'], (dxy, gold) => dxy > 0 && gold > 0, '只比较同比方向，不据此断言去美元化。')
    ];
    const eps = value('EPS_TTM');
    const projections = finite(eps) ? [-.10, .04, .07].map(growth => ({growth, values: [1, 2].map(years => ({years, eps: eps * Math.pow(1 + growth, years)}))})) : [];
    const masters = [['德鲁肯米勒', '宏观趋势与风险纪律'], ['巴菲特', '能力圈与安全边际'], ['霍华德·马克思', '周期与第二层思维'], ['彼得·林奇', '理解企业与合理成长估值']]
      .map(([name, framework]) => ({name, framework, advice: verdict.advice}));
    return {version: VERSION, generatedAt: s.generatedAt || null, lastSuccessfulAt: s.lastSuccessfulAt || null,
      runStatus: s.runStatus || 'unavailable', evaluatedAt: Number.isFinite(now) ? new Date(now).toISOString() : null,
      snapshotReason: reason, metrics, benchmarks, dimensions: benchmarks[0].dimensions,
      historical: {score: historicalScore, coverage: historicalCoverage}, system,
      triggers: {items: triggerItems, ...triggerPressure}, composite: {score: compositeScore, coverage: Math.min(historicalCoverage, triggerPressure.coverage), verdict},
      anomalies, truth, earnings: {base: eps, observationDate: metrics.EPS_TTM.observationDate, projections}, masters,
      scenarios: {...SCENARIOS, windows: SCENARIOS.windows.map(w => ({...w, expired: Number.isFinite(now) && now >= Date.parse(w.end + 'T00:00:00Z') + DAY}))},
      errors: Array.isArray(s.errors) ? s.errors : []};
  }
  const fmt = (n, digits = 1) => finite(n) ? n.toLocaleString('en-US', {maximumFractionDigits: digits, minimumFractionDigits: digits}) : '—';
  const coverageText = n => fmt(n * 100) + '%';
  const scoreText = n => finite(n) ? fmt(n) + ' / 100' : '暂无数据';
  function metricHTML(state, id) {
    const m = state.metrics[id], source = m.source || {}, url = httpsURL(source.url);
    const link = url ? `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer">${escapeHTML(source.name)}</a>` : escapeHTML(source.name || '无可靠来源');
    return `<div class="cd-metric" data-metric="${escapeHTML(id)}"><b>${escapeHTML(LABELS[id] || id)}: <span data-value="${escapeHTML(id)}">${fmt(m.value, 2)}</span> ${escapeHTML(m.unit)}${id === 'EPS_TTM' ? ' · 实际购买力（按来源最新CPI重定价）' : ''}</b><small>观测 ${escapeHTML(m.observationDate || '缺失')} · 期末 ${escapeHTML(m.periodEnd || '缺失')} · 期末后容忍 ${escapeHTML(m.maxAgeDays)} 天 · ${escapeHTML(m.frequency || '缺失')} · ${escapeHTML(m.kind || '缺失')} · ${m.usable ? '有效' : '不入分: ' + escapeHTML(m.reason)}<br>抓取 ${escapeHTML(m.fetchedAt || '缺失')} · ${link}${m.error ? '<br>错误: ' + escapeHTML(m.error) : ''}</small></div>`;
  }
  function barHTML(score) {
    return finite(score) ? `<div class="cd-bar"><i style="width:${clamp(score / 100) * 100}%"></i></div>` : '';
  }
  function renderHTML(state) {
    const s = state || getState();
    const card = body => `<div class="card gold-edge cd-card">${body}</div>`;
    const title = text => `<h3 class="cd-title">${escapeHTML(text)}</h3>`;
    const badge = (label, group, key) => card(`<div>${escapeHTML(label)}</div><strong class="cd-score" data-score="${key}">${scoreText(group.score)}</strong>${barHTML(group.score)}<small>加权覆盖率 ${coverageText(group.coverage)}${group.coverage < 1 ? ' · 部分覆盖/缺失' : ''}</small>`);
    const signalText = signal => ({missing: '待数据 / 不可判断', watch: '规则触发 · 需关注', 'not-triggered': '规则未触发（不等于安全）'}[signal]);
    const rules = items => items.map(r => card(`<b>${escapeHTML(r.name)}</b><p>${signalText(r.signal)}</p><small>${escapeHTML(r.note)}</small>${r.inputs.map(id => metricHTML(s, id)).join('')}`)).join('');
    const dims = s.dimensions.map(d => card(`<b>${escapeHTML(d.name)} · 权重 ${coverageText(d.weight)}</b><p data-dimension="${d.id}">${d.applicable ? '2000相似度 ' + scoreText(d.score) + ' · 覆盖 ' + coverageText(d.coverage) : 'N/A历史无资产 · 不计覆盖分母'}</p>${barHTML(d.score)}${d.parts.map(p => `<div class="cd-reference">历史框架 ${escapeHTML(LABELS[p.id])}: ${p.applicable ? finite(p.reference) ? fmt(p.reference, 2) : '历史参照缺失' : 'N/A历史无资产'} · 分项相似度 ${p.applicable ? scoreText(p.score) : 'N/A历史无资产'} · 子权重 ${coverageText(p.weight)}</div>${metricHTML(s, p.id)}`).join('')}${d.context.map(id => metricHTML(s, id)).join('')}`)).join('');
    const benchRows = s.benchmarks.map(b => `<tr><td>${escapeHTML(b.label)}</td><td>${coverageText(b.weight)}</td><td data-benchmark="${b.id}">${scoreText(b.score)}</td><td>${coverageText(b.coverage)}</td><td>${scoreText(b.sensitivity.score)}<br><small>仅敏感性排除: ${escapeHTML(b.sensitivity.removed.join('、') || '无')} · ${b.sensitivity.kept}/${b.sensitivity.total}</small></td></tr>`).join('');
    const triggers = s.triggers.items.map(t => card(`<b>${escapeHTML(t.label)}</b><p data-trigger="${t.id}">${t.score == null ? '待数据 / 不可估算' : '信号强度 ' + scoreText(t.score)}</p>${barHTML(t.score)}<small>观测覆盖 ${coverageText(t.coverage)} · 影响参数 ${coverageText(t.impact)} · 权重 ${coverageText(t.weight)}<br>${escapeHTML(t.note)}</small>${t.inputs.map(id => metricHTML(s, id)).join('')}`)).join('');
    const systemItems = s.system.items.map(c => card(`${metricHTML(s, c.id)}<p data-system="${c.id}">风险分项 ${scoreText(c.score)} · 权重 ${coverageText(c.weight)}</p>${barHTML(c.score)}`)).join('');
    const earnings = s.earnings.projections.length ? s.earnings.projections.map(p => card(`<b>实际购买力情景 · 增长假设 ${fmt(p.growth * 100)}%</b>${p.values.map(v => `<p>观测基点后 ${v.years} 年: 实际购买力情景EPS <span data-eps="${p.growth}-${v.years}">${fmt(v.eps, 2)}</span></p>`).join('')}`)).join('') : card('暂无有效EPS_TTM，暂停情景投影；不补造盈利共识。');
    const errors = s.errors.map(e => escapeHTML(typeof e === 'string' ? e : JSON.stringify(e))).join('<br>');
    return `<section class="crisis-daily" data-model="${VERSION}">
      <style>.crisis-daily{--cd-gold:var(--gold,#d4af37);color:var(--text,#ece9df);font-size:13px;line-height:1.7}.crisis-daily .cd-title{font-size:17px;color:var(--gold-bright,#e8d49b);margin:26px 0 12px}.crisis-daily .cd-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,280px),1fr));gap:14px}.crisis-daily .cd-card{padding:18px;border:1px solid var(--line,#26262f);border-top:2px solid var(--cd-gold);border-radius:var(--r,12px);background:var(--panel,var(--card,#101014));min-width:0}.crisis-daily small{display:block;color:var(--text-3,#9a948c);font-size:11px;overflow-wrap:anywhere}.crisis-daily p{margin:8px 0}.crisis-daily .cd-score{display:block;font-size:30px;color:var(--cd-gold);font-family:monospace;margin:8px 0}.crisis-daily .cd-metric{padding:8px 0;border-top:1px solid var(--line,#26262f);overflow-wrap:anywhere}.crisis-daily .cd-metric b{font-weight:500}.crisis-daily a{color:var(--cd-gold)}.crisis-daily .cd-bar{height:5px;background:#ffffff12;border-radius:3px;margin:8px 0;overflow:hidden}.crisis-daily .cd-bar i{height:100%;display:block;background:var(--cd-gold)}.crisis-daily .cd-reference{font-size:11px;color:var(--text-2,#b9b4ab);padding:6px 0}.crisis-daily .cd-table{overflow:auto}.crisis-daily table{border-collapse:collapse;width:100%;min-width:600px}.crisis-daily th,.crisis-daily td{text-align:left;padding:10px;border-bottom:1px solid var(--line,#26262f)}@media(max-width:600px){.crisis-daily .cd-card{padding:14px}.crisis-daily .cd-score{font-size:25px}}</style>
      ${title('危机预警 · 每日正式快照')}
      ${card(`<b>快照生成: ${escapeHTML(s.generatedAt || '暂无快照')}</b><small>最近有有效数据的采集: ${escapeHTML(s.lastSuccessfulAt || '暂无')} · 运行 ${escapeHTML(s.runStatus)} · 模型 ${VERSION}<br>前端时效核验: ${escapeHTML(s.evaluatedAt)}（不是数据更新日期）<br>${escapeHTML(s.snapshotReason || '按各指标真实观测时间评估；浏览器报价不覆盖正式快照。')}${transportError ? '<br>本次读取失败: ' + escapeHTML(transportError) + '；保留旧快照原始日期并重新核验时效。' : ''}</small>${errors ? '<small>采集错误: ' + errors + '</small>' : ''}`)}
      <div class="cd-grid">${badge('综合模型风险', s.composite, 'composite')}${badge('四基准历史相似度', s.historical, 'historical')}${badge('系统性风险（独立指标）', s.system, 'system')}${badge('触发器已覆盖压力', s.triggers, 'trigger-pressure')}</div>
      ${card(`<b style="color:${s.composite.verdict.color}">${escapeHTML(s.composite.verdict.label)}</b><p>${escapeHTML(s.composite.verdict.advice)}</p><small>综合 = 历史相似度 × 50% + 触发器压力 × 50%。历史/系统覆盖低于60%暂停；触发覆盖低于50%暂停。触发压力 = Σ(信号强度×影响参数×有效权重)/Σ有效权重，无平方根放大。所有强度均未校准，不是实际发生概率或损失估计。历史相似度不等于危机风险。</small>`)}
      ${title('四基准 · 主分保留全部有证据维度')}${card(`<div class="cd-table"><table><thead><tr><th>历史基准</th><th>组合权重</th><th>主相似度</th><th>覆盖率</th><th>IQR敏感性（非主分）</th></tr></thead><tbody>${benchRows}</tbody></table></div><small>相似度 = 100×max(0,1−|最新值−基准|/max(|基准|,尺度))；缺失子指标按可用权重归一化，覆盖率仍按适用原权重计；2000/2008的BTC为N/A历史无资产，仅从适用覆盖分母剔除，不改实际有效权重归一化。零/负收益使用绝对基准与尺度。分母尺度：股票同比20、CAPE17、PE15、集中度20、利率1、美元50、黄金/BTC100、原油200、通胀2、利润10。历史数值/口径是原框架锚点，不冒充同日观测或精确统计校准；不强制剔除最低项。</small>`)}
      ${title('九维对比 · 同一模型状态')}<div class="cd-grid">${dims}</div>
      ${title('系统性风险 · 8指标')}<div class="cd-grid">${systemItems}</div>${card('<small>沿用原框架线性区间：利差−1至3（反向）、VIX10至80、失业3至15、信心40至110（反向）、拖欠1.5至7、房价同比−5至20、HY 2至12、股票同比−40至40（反向）。信用/房价方向沿用原框架，存在经济解释争议；不是校准后的危机发生率。</small>')}
      ${title('8触发器 · 未校准信号强度')}<div class="cd-grid">${triggers}</div>${card('<small>压力阈值参数：10Y 3–5%，HY 2–8%，WTI 60–100美元，就业3.5–6.5%；政策代理等权使用CPI 2–6%、核心PCE 2–5%、Fed目标上下限各2–6%。无观测的capex/IPO/监管不入分；五项完全可用时覆盖58%，仍为部分覆盖。</small>')}
      ${title('异常与真假繁荣 · 模型规则，不指定政治因果')}<div class="cd-grid">${rules(s.anomalies)}</div>${title('真假繁荣 · 证据边界')}<div class="cd-grid">${rules(s.truth)}</div>
      ${title('统一EPS情景投影 · 非机构盈利预测')}${card(`${metricHTML(s, 'EPS_TTM')}<small>EPS(n) = 有效EPS_TTM × (1+假设增长率)^n。基点来自Multpl独立12月真实通胀调整盈利序列，并非SP500/PE倒算；单位按来源最新CPI重定价，基期随来源变化。n年值均为同基期实际购买力情景，不是名义EPS预测。−10%/4%/7%为模型情景参数，不是Goldman/FactSet共识；基点是观测日期而非今日。BEA全美企业利润不能替代Mag7盈利，暂无Mag7专属观测。</small>`)}<div class="cd-grid">${earnings}</div>
      ${title('大师框架启发 · 模型生成')}<div class="cd-grid">${s.masters.map(m => card(`<b>${escapeHTML(m.name)}</b><small>${escapeHTML(m.framework)}</small><p>${escapeHTML(m.advice)}</p><small>根据当前综合分切换的框架启发，不是真实言论/持仓，不承诺收益。</small>`)).join('')}</div>
      ${title('用户历史情景假设 · 非每日新闻')}${card(`<small>历史制定日期 ${SCENARIOS.formulatedAt}。以下固定时间窗与跌幅仅保留为用户情景假设，不计入每日分数，不估算事件发生率；窗口未过期也不证明情景正在发生。</small><p>${s.scenarios.windows.map(w => escapeHTML(w.label) + ' · ' + (w.expired ? '已过期' : '尚未过期，仅假设')).join('<br>')}</p>${s.scenarios.tiers.map(t => `<p>${escapeHTML(t.label)}: 假设跌幅 ${escapeHTML(t.drop)}</p>`).join('')}`)}
      ${title('历史框架复盘')}${card('<p>1999–2000：标普年涨19.3%、纳指85.6%；CAPE44.19、TTM PE32；30Y6.0%、10Y6.3%、5Y5.9%。BTC尚不存在。其他危机锚点见四基准模型参数。历史对比不是危机必然重演。</p>')}
      <details>${'<summary>全部快照指标与来源</summary>'}${METRIC_IDS.map(id => metricHTML(s, id)).join('')}</details>
      ${card('<small>风险提示：仅供模型研究，不构成投资建议。缺失、过期、错误、未来日期和假设数据均不默默入分；时效按已结束观测期末计：daily≤7天、monthly≤75天、quarterly≤160天，Case-Shiller房价同比≤120天、Financial Accounts企业债务/GDP≤180天；快照≤48小时。期末必须与原观测期一致且不晚于抓取/快照/当前时间；缺少periodEnd仅从月/季首推已结束期末，季度末EPS保留原日期。不可信maxAgeDays不能扩大固定ID容忍期，error/stale不自动转有效。</small>')}
    </section>`;
  }
  let snapshot = null;
  let currentState = compute(null);
  let transportError = null;
  let loading = null;
  function getState(options) { currentState = compute(snapshot, options); return currentState; }
  function setSnapshot(next, options) { snapshot = next; transportError = null; currentState = compute(next, options); return currentState; }
  async function load(options = {}) {
    if (loading) return loading;
    loading = (async () => {
      const fetcher = options.fetch || ((...args) => globalThis.fetch(...args));
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), 12000) : null;
      try {
        const response = await fetcher(options.url || 'data/crisis-daily.json', {cache: 'no-store', ...(controller ? {signal: controller.signal} : {})});
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const next = await response.json();
        const receivedAt = options.now == null ? Date.now() : +new Date(options.now);
        const generatedAt = isoTime(next?.generatedAt);
        if (next?.schemaVersion !== 1 || !next.metrics || !Number.isFinite(generatedAt) || !Number.isFinite(receivedAt)) throw new Error('无效每日快照');
        if (generatedAt > receivedAt) throw new Error('快照生成时间在未来，拒绝覆盖有效数据');
        // An older response must never overwrite an already accepted newer assessment.
        if (!snapshot || generatedAt >= isoTime(snapshot.generatedAt)) setSnapshot(next, options);
        transportError = null;
      } catch (error) { transportError = String(error.message || error); }
      finally { if (timer) clearTimeout(timer); }
      return getState(options);
    })();
    try { return await loading; } finally { loading = null; }
  }
  function render(target, state) {
    const el = typeof target === 'string' ? document.getElementById(target) : target;
    if (el) el.innerHTML = renderHTML(state || getState());
  }
  return {VERSION, AGE_LIMITS, METRIC_IDS, DIMENSIONS, BENCHMARKS, SYSTEM_INDICATORS, TRIGGERS,
    compute, calculateBenchmark, proximity, iqrSensitivity, escapeHTML, httpsURL, assessment,
    getState, setSnapshot, load, renderHTML, render};
});
