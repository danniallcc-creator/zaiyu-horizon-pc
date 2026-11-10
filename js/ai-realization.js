/* AI realization: company proxies are observations, never direct AI evidence. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AiRealization = api;
})(typeof window !== 'undefined' ? window : null, function (root) {
  'use strict';
  const DAY = 86400000, FRESH_DAYS = 200;
  const TRACKED = Object.freeze({NVDA: 'designer', AMD: 'designer', TSM: 'foundry', SAMSUNG: 'memory', SKHYNIX: 'memory', MU: 'memory', MSFT: 'buyer', AMZN: 'buyer', GOOG: 'buyer', META: 'buyer'});
  const GROUPS = Object.freeze({application: {name: '应用兑现', weight: .40, metrics: ['aiRevenue', 'aiContributionProfit', 'renewalRate', 'verifiedCostSavings']}, orders: {name: '采购订单', weight: .35, metrics: ['newOrders', 'orderCancellations', 'procurementBudget']}, profit: {name: '正常化盈利', weight: .25, metrics: ['normalizedGrossMargin', 'sameSkuPrice']}});
  const finite = n => typeof n === 'number' && Number.isFinite(n);
  const text = v => typeof v === 'string' && !!v.trim();
  const escapeHTML = v => String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  function httpsURL(v) {
    if (typeof v !== 'string' || /[\u0000-\u0020\u007f]/.test(v)) return null;
    try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password ? u.href : null; } catch (_) { return null; }
  }
  // Strip fragments and known tracking params so that the same article with
  // different utm/ref parameters is not counted as an independent event.
  const TRACKING_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'ref', 'fbclid', 'gclid'];
  function eventURL(v) {
    const href = httpsURL(v);
    if (!href) return null;
    try { const u = new URL(href); u.hash = ''; for (const p of TRACKING_PARAMS) u.searchParams.delete(p); return u.href; } catch (_) { return href; }
  }
  function date(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return NaN;
    const t = Date.parse(v + 'T00:00:00Z');
    return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v ? t : NaN;
  }
  function utc(v) {
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(v)) return NaN;
    const t = Date.parse(v);
    return Number.isFinite(t) && Number.isFinite(date(v.slice(0, 10))) && new Date(t).toISOString().slice(0, 10) === v.slice(0, 10)
      && +v.slice(11, 13) < 24 && +v.slice(14, 16) < 60 && +v.slice(17, 19) < 60 ? t : NaN;
  }
  const stamp = v => typeof v === 'string' && v.length === 10 ? date(v) : utc(v);
  const sourceOK = s => s && text(s.name) && httpsURL(s.url) && (s.status === undefined || s.status === 'ok');
  function quarter(start, end) {
    const a = date(start), b = date(end), days = (b + DAY - a) / DAY;
    if (!Number.isFinite(a) || !Number.isFinite(b) || days < 75 || days > 105) return false;
    const d = new Date(a), canonical = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3, d.getUTCDate()) - DAY;
    return Math.abs(b - canonical) <= 15 * DAY;
  }
  function consecutive(a, b) {
    return quarter(a.periodStart || a.start, a.periodEnd || a.end) && quarter(b.periodStart || b.start, b.periodEnd || b.end)
      && Math.abs(date(b.periodStart || b.start) - date(a.periodEnd || a.end) - DAY) <= 15 * DAY
      && Math.abs(date(b.periodEnd || b.end) - date(a.periodEnd || a.end) - 90 * DAY) <= 15 * DAY;
  }
  function snapshotReason(s, now) {
    if (!Number.isFinite(now)) return '评估时间无效';
    if (!s || s.schemaVersion !== 1 || !Array.isArray(s.companies) || !Array.isArray(s.evidence)) return 'AI快照缺失或契约无效';
    const generated = utc(s.generatedAt);
    if (!Number.isFinite(generated) || generated > now) return 'AI快照生成时间无效或在未来';
    if (!['ok', 'partial', 'failed'].includes(s.runStatus)) return 'AI采集状态无效';
    if (s.lastSuccessfulAt != null && (!Number.isFinite(utc(s.lastSuccessfulAt)) || utc(s.lastSuccessfulAt) > generated)) return 'AI最近成功日期无效';
    if (s.runStatus === 'failed') return 'AI本次采集失败，专项证据暂停入分';
    if (now - generated > 2 * DAY) return 'AI每日快照超过48小时；保留原始日期，暂停入分';
    return null;
  }
  function monetaryScale(unit) {
    if (!text(unit)) return null;
    const u = unit.toLowerCase().trim();
    if (/^(usd|twd|krw|dollars|currency|units)$/.test(u)) return 1;
    if (/^(usd |twd |krw )?millions?( (usd|twd|krw))?$/.test(u)) return 1e6;
    if (/^(usd |twd |krw )?billions?( (usd|twd|krw))?$/.test(u)) return 1e9;
    return null;
  }
  const pctScale = unit => ['%', 'percent', 'percentage points', 'pp'].includes(unit) ? 1 : ['fraction', 'ratio'].includes(unit) ? 100 : null;
  const CIKS = Object.freeze({NVDA: 1045810, AMD: 2488, TSM: 1046179, MU: 723125, MSFT: 789019, AMZN: 1018724, GOOG: 1652044, META: 1326801});
  const YTD_TAGS = Object.freeze({revenue: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet'], costOfRevenue: ['CostOfRevenue', 'CostOfGoodsAndServicesSold'], capex: ['PaymentsToAcquirePropertyPlantAndEquipment'], operatingCashFlow: ['NetCashProvidedByUsedInOperatingActivities'], grossProfit: ['GrossProfit']});
  const accessionOK = a => typeof a === 'string' && /^\d{10}-\d{2}-\d{6}$/.test(a);
  const sameSource = (a, b) => sourceOK(a) && sourceOK(b) && a.name === b.name && a.url === b.url && (a.status || 'ok') === (b.status || 'ok');
  const closeMoney = (a, b) => finite(a) && finite(b) && Math.abs(a - b) <= Math.max(1e-6, Math.abs(a) * 1e-12, Math.abs(b) * 1e-12);
  const moneyUnitOK = (unit, currency) => monetaryScale(unit) !== null && (!/^(USD|TWD|KRW)$/i.test(unit.trim()) || unit.trim().toUpperCase() === currency)
    && !/(?:USD|TWD|KRW)/i.test(unit.replace(new RegExp(currency, 'ig'), ''));
  const amount = f => f?.value * (f?.unit === undefined ? 1 : monetaryScale(f.unit));
  function factPeriod(f) {
    if (!f) return {};
    if (f.period && ((f.start !== undefined && f.start !== f.period.start) || (f.end !== undefined && f.end !== f.period.end))) return {};
    return f.period || {start: f.start, end: f.end};
  }
  function issuerSource(source, c, accession) {
    if (!sourceOK(source) || !sourceOK(c.source)) return false;
    const u = new URL(source.url), cik = CIKS[c.id];
    if (u.hostname === 'sec.gov' || u.hostname.endsWith('.sec.gov')) {
      if (!cik || u.search || u.hash) return false;
      if (accession !== undefined) return accessionOK(accession) && source.url === `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replaceAll('-', '')}/${accession}-index.html`;
      return source.url === `https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, '0')}.json`;
    }
    // Preserve the existing HTTPS frontend source contract, but never borrow
    // another publisher's input. SEC facts above are bound to the tracked CIK.
    return u.origin === new URL(c.source.url).origin;
  }
  function factOK(f, id, c, generated, now) {
    const p = factPeriod(f), kind = f?.kind === undefined ? 'observed' : f.kind;
    if (!f || !finite(f.value) || !['USD', 'TWD', 'KRW'].includes(f.currency) || !text(f.tag) || !Number.isInteger(f.fiscalYear)
      || !accessionOK(f.accession) || !issuerSource(f.source, c, f.accession)
      || !(date(p.start) <= date(p.end) && date(p.end) <= stamp(f.filed) && stamp(f.filed) <= utc(c.fetchedAt) && utc(c.fetchedAt) <= generated && generated <= now)
      || (f.unit !== undefined && !moneyUnitOK(f.unit, f.currency)) || !finite(amount(f))
      || (f.status !== undefined && f.status !== 'ok') || (f.scope !== undefined && f.scope !== 'company')
      || ((!f.period || f.form !== undefined) && !['10-Q', '10-Q/A', '10-K', '10-K/A'].includes(f.form))
      || (id !== 'operatingCashFlow' && id !== 'grossProfit' && f.value < 0)) return false;
    return kind === 'observed' ? f.inputs === undefined : kind === 'derived' && quarter(p.start, p.end) && ytdOK(f, id, c, generated, now);
  }
  function ytdOK(f, id, c, generated, now) {
    const inputs = f.inputs, p = factPeriod(f);
    if (!YTD_TAGS[id]?.some(tag => f.tag === 'us-gaap:' + tag) || !Array.isArray(inputs) || inputs.length < 2 || inputs.length > 4) return false;
    const current = inputs[0], prior = inputs[1], stage = inputs.length;
    for (let n = 0; n < stage; n++) {
      const input = inputs[n], ip = factPeriod(input);
      // Collector chains are raw YTD declarations, in reverse order down to Q1.
      if (!input || (input.kind !== undefined && input.kind !== 'observed') || !factOK(input, id, c, generated, now)
        || ip.start !== factPeriod(current).start || input.fiscalYear !== f.fiscalYear || input.tag !== f.tag || input.currency !== f.currency
        || stamp(input.filed) > stamp(f.filed)) return false;
      const days = (date(ip.end) - date(ip.start)) / DAY + 1, step = stage - n;
      if (step === 1 ? !quarter(ip.start, ip.end) : step === 2 ? days < 170 || days > 210 : step === 3 ? days < 250 || days > 305 : days < 350 || days > 380 || !['10-K', '10-K/A'].includes(input.form)) return false;
      if (n && (!quarter(new Date(date(ip.end) + DAY).toISOString().slice(0, 10), factPeriod(inputs[n - 1]).end)
        || stamp(input.filed) > stamp(inputs[n - 1].filed))) return false;
    }
    return p.end === factPeriod(current).end && date(p.start) === date(factPeriod(prior).end) + DAY
      && f.filed === current.filed && f.accession === current.accession && sameSource(f.source, current.source)
      && closeMoney(amount(f), amount(current) - amount(prior));
  }
  function sameFact(a, b) {
    const ap = factPeriod(a), bp = factPeriod(b);
    if (!a || !b || !closeMoney(amount(a), amount(b)) || ap.start !== bp.start || ap.end !== bp.end
      || !['currency', 'tag', 'filed', 'accession', 'fiscalYear'].every(key => a[key] === b[key])
      || (a.kind || 'observed') !== (b.kind || 'observed') || !sameSource(a.source, b.source)) return false;
    return a.inputs === undefined && b.inputs === undefined || Array.isArray(a.inputs) && Array.isArray(b.inputs)
      && a.inputs.length === b.inputs.length && a.inputs.every((input, n) => sameFact(input, b.inputs[n]));
  }
  function grossMarginOK(m, q, c, generated, now, value) {
    const inputs = m.inputs, revenue = q.metrics?.revenue, cost = q.metrics?.costOfRevenue;
    if (m.tag !== 'derived:(revenue-costOfRevenue)/revenue' || !Array.isArray(inputs) || ![2, 3].includes(inputs.length)
      || !companyMetric(revenue, 'revenue', q, c, generated, now).usable || !companyMetric(cost, 'costOfRevenue', q, c, generated, now).usable) return false;
    if (!inputs.every((input, n) => factOK(input, ['revenue', 'costOfRevenue', 'grossProfit'][n], c, generated, now)
      && factPeriod(input).start === q.start && factPeriod(input).end === q.end && input.currency === m.currency
      && input.fiscalYear === m.fiscalYear && stamp(input.filed) <= stamp(m.filed))
      || !sameFact(inputs[0], revenue) || !sameFact(inputs[1], cost) || amount(revenue) <= 0) return false;
    const profit = amount(revenue) - amount(cost), latestFiled = Math.max(...inputs.map(input => stamp(input.filed)));
    return (inputs.length === 2 || inputs[2].tag === 'us-gaap:GrossProfit' && closeMoney(amount(inputs[2]), profit))
      && inputs.some(input => stamp(input.filed) === latestFiled && m.filed === input.filed && m.accession === input.accession && sameSource(m.source, input.source))
      && Math.abs(value - profit / amount(revenue) * 100) <= 1e-6;
  }
  function companyMetric(m, id, q, c, generated, now) {
    let reason = null;
    if (!m || m.status !== 'ok' || !finite(m.value)) reason = '未披露或状态不可用';
    else if (m.scope !== 'company' || !['observed', 'derived'].includes(m.kind) || !issuerSource(m.source, c, m.accession) || !text(m.tag)) reason = '公司指标口径或来源无效';
    else if (!['USD', 'TWD', 'KRW'].includes(m.currency) || !text(m.unit)) reason = '单位或币种缺失';
    else if (!quarter(q.start, q.end) || !(date(q.end) + DAY <= stamp(q.filed) && stamp(q.filed) <= utc(c.fetchedAt) && utc(c.fetchedAt) <= generated && generated <= now)) reason = '季度/披露/抓取日期链无效';
    else if (!['ok', 'partial'].includes(c.status) || !issuerSource(c.source, c)) reason = '公司采集或来源不可用';
    // Legacy observed frontend records may omit per-metric metadata. When
    // supplied (always for collector/derived records), validate the entire chain.
    if (!reason && (m.kind === 'derived' || ['period', 'filed', 'accession', 'fiscalYear'].some(key => m[key] !== undefined))) {
      const p = factPeriod(m);
      if (p.end !== q.end || (p.start !== q.start && !(id === 'inventory' && p.start === q.end))
        || !(date(p.start) <= date(p.end) && date(p.end) <= stamp(m.filed) && stamp(m.filed) <= stamp(q.filed))
        || !accessionOK(m.accession) || !Number.isInteger(m.fiscalYear)
        || (id !== 'inventory' && q.metrics?.revenue?.fiscalYear !== undefined && m.fiscalYear !== q.metrics.revenue.fiscalYear)) reason = '指标季度/披露/财年元数据不符';
    }
    if (!reason && q.metrics?.revenue?.currency !== undefined && m.currency !== q.metrics.revenue.currency) reason = '指标与季度营收币种不符';
    const scale = id === 'grossMargin' ? pctScale(m?.unit) : monetaryScale(m?.unit);
    if (!reason && (scale === null || id !== 'grossMargin' && !moneyUnitOK(m.unit, m.currency))) reason = '单位不可规范化';
    const value = !reason ? m.value * scale : null;
    if (!reason && (!finite(value) || (id === 'grossMargin' ? value < -100 || value > 100 : id !== 'operatingCashFlow' && value < 0))) reason = '数值范围不合理';
    if (!reason && m.kind === 'derived' && !(id === 'grossMargin' ? grossMarginOK(m, q, c, generated, now, value) : ytdOK(m, id, c, generated, now))) reason = '推导输入季度/财年/币种/来源或公式不符';
    if (!reason && m.kind === 'observed' && m.inputs !== undefined) reason = '观察指标不能隐藏推导输入';
    return {value: reason ? null : value, currency: m?.currency || null, unit: id === 'grossMargin' ? '%' : 'currency', usable: !reason, reason, source: m?.source || null, kind: m?.kind || null};
  }
  function companies(s, now, generated) {
    const list = Array.isArray(s?.companies) ? s.companies : [];
    return Object.entries(TRACKED).map(([id, role]) => {
      const matches = list.filter(c => c && c.id === id), c = matches.length === 1 ? matches[0] : {};
      const quarters = (Array.isArray(c.quarters) ? c.quarters : []).filter(q => q && quarter(q.start, q.end)).map(q => ({
        start: q.start, end: q.end, filed: q.filed, accession: q.accession || null,
        metrics: Object.fromEntries(['revenue', 'costOfRevenue', 'grossMargin', 'inventory', 'capex', 'operatingCashFlow'].map(key => [key, companyMetric(q.metrics?.[key], key, q, c, generated, now)]))
      })).sort((a, b) => date(a.end) - date(b.end));
      const unique = quarters.filter(q => quarters.filter(other => other.end === q.end).length === 1);
      const latest = unique.at(-1) || null;
      const fresh = !!latest && date(latest.end) + DAY <= now && now - date(latest.end) <= FRESH_DAYS * DAY && c.role === role;
      const verified = c.crossCheck?.status === 'verified';
      const trend = {label: '观察（公司财报代理）', crossCheck: verified ? '来源交验（非AI专项）' : '单源观察/未独立交验', marginPP: null, inventoryRevenueChange: null, revenueYoY: null, watch: false};
      const last3 = unique.slice(-3);
      const continuous = last3.length === 3 && consecutive(last3[0], last3[1]) && consecutive(last3[1], last3[2]);
      if (fresh && continuous) {
        const margins = last3.map(q => q.metrics.grossMargin.value);
        if (margins.every(finite) && new Set(last3.map(q => q.metrics.grossMargin.currency)).size === 1) trend.marginPP = margins[2] - margins[0];
        const ratios = last3.map(q => q.metrics.inventory.usable && q.metrics.revenue.usable && q.metrics.inventory.currency === q.metrics.revenue.currency && q.metrics.revenue.value > 0 ? q.metrics.inventory.value / q.metrics.revenue.value : null);
        if (ratios.every(finite) && new Set(last3.map(q => q.metrics.revenue.currency)).size === 1) trend.inventoryRevenueChange = ratios[2] - ratios[0];
        trend.watch = verified && ((trend.marginPP !== null && trend.marginPP <= -3) || (trend.inventoryRevenueChange !== null && trend.inventoryRevenueChange > 0));
      }
      const baseline = latest && unique.find(q => Math.abs(date(latest.end) - date(q.end) - 365 * DAY) <= 7 * DAY && q.start.slice(5) === latest.start.slice(5));
      if (fresh && continuous && baseline && baseline.metrics.revenue.usable && latest.metrics.revenue.usable && baseline.metrics.revenue.currency === latest.metrics.revenue.currency && baseline.metrics.revenue.value > 0) {
        const yoy = (latest.metrics.revenue.value / baseline.metrics.revenue.value - 1) * 100;
        trend.revenueYoY = finite(yoy) ? yoy : null;
      }
      return {id, name: text(c.name) ? c.name : id, role, status: c.status || 'unavailable', fetchedAt: c.fetchedAt || null, source: c.source || null,
        crossCheck: c.crossCheck || {status: 'unavailable', reason: '官方来源未交验'}, reason: matches.length > 1 ? '重复公司记录' : c.reason || null,
        quarters: unique, latest, fresh, trend, disclosures: Array.isArray(c.disclosures) ? c.disclosures.filter(d => d && typeof d === 'object') : []};
    });
  }
  function validateEvidence(r, generated, now, topReason) {
    if (topReason) return topReason;
    if (!r || !text(r.id) || !text(r.chainId) || !Object.hasOwn(TRACKED, r.companyId) || !Object.hasOwn(GROUPS, r.group)) return '证据标识/公司/环节无效';
    if (r.kind !== 'direct' || r.scope !== 'AI' || r.reviewed !== true || (r.status !== undefined && r.status !== 'ok') || r.error) return '仅接纳人工核验原文且无错误的AI专项直接证据';
    if (!quarter(r.periodStart, r.periodEnd) || !(date(r.periodEnd) + DAY <= stamp(r.publishedAt) && stamp(r.publishedAt) <= stamp(r.reviewedAt) && stamp(r.reviewedAt) <= generated && generated <= now)) return '专项季度或发布/复核时间链无效';
    if (now - date(r.periodEnd) > FRESH_DAYS * DAY) return '专项证据期末超过200天';
    if (!Array.isArray(r.sources) || r.sources.length < 2 || r.sources.some(s => !sourceOK(s) || !text(s.publisher) || !['official', 'independent'].includes(s.type))
      || !r.sources.some(s => s.type === 'official') || !r.sources.some(s => s.type === 'independent')
      || new Set(r.sources.map(s => s.publisher.trim().toLowerCase())).size < 2
      || new Set(r.sources.map(s => { const h = new URL(s.url).hostname.toLowerCase().replace(/^www\./, ''); return h === 'data.sec.gov' ? 'sec.gov' : h; })).size < 2) return '需HTTPS官方与独立来源、不同publisher；这里只校验结构';
    if (!GROUPS[r.group].metrics.includes(r.metric) || !text(r.summary) || !finite(r.value) || !finite(r.baseline) || !['deteriorating', 'improving', 'stable'].includes(r.direction)) return '指标白名单/数值/方向无效';
    const percent = ['renewalRate', 'normalizedGrossMargin'].includes(r.metric);
    const money = ['aiRevenue', 'aiContributionProfit', 'verifiedCostSavings', 'procurementBudget', 'sameSkuPrice'].includes(r.metric);
    if (percent ? pctScale(r.unit) !== 1 || r.baseline <= 0 || r.baseline > 100 || r.value < 0 || r.value > 100
      : money ? monetaryScale(r.unit) === null || r.baseline <= 0 || r.value < 0
        : !['count', 'units', 'USD', 'TWD', 'KRW'].includes(r.unit) || r.baseline <= 0 || r.value < 0) return '指标单位或基准范围不合理';
    const change = percent ? r.value - r.baseline : (r.value / r.baseline - 1) * 100;
    if (!finite(change)) return '数值变化溢出';
    const adverse = (r.metric === 'orderCancellations' ? 1 : -1) * change;
    const threshold = percent ? 3 : 10;
    const measured = adverse + 1e-9 >= threshold ? 'deteriorating' : adverse - 1e-9 <= -threshold ? 'improving' : 'stable';
    if (r.direction !== measured) return '数字与声明方向或保守研究阈值不匹配';
    if (r.normalizationReviewed !== true || !Array.isArray(r.confounders) || r.confounders.some(c => !c || typeof c !== 'object' || c.cleared !== true || !text(c.name || c.reason))) return '正常化归因未复核或混淆因素未排除';
    if (r.group === 'application') {
      if (!Number.isInteger(r.evaluationWindowQuarters) || r.evaluationWindowQuarters < 2 || r.evaluationWindowQuarters > 8 || !Number.isFinite(date(r.deploymentDate))
        || date(r.periodEnd) - date(r.deploymentDate) < r.evaluationWindowQuarters * 90 * DAY) return '应用投产日期/事前成熟窗口缺失或尚未成熟（只允许2–8季度）';
    }
    if (r.group === 'orders' && (!['buyer', 'supplier'].includes(r.procurementSide) || (TRACKED[r.companyId] === 'buyer') !== (r.procurementSide === 'buyer'))) return '订单需匹配采购方或供应方身份';
    if (r.metric === 'sameSkuPrice') {
      const t = r.comparableTerms;
      if (!t || !text(t.sku) || !['USD', 'TWD', 'KRW'].includes(t.currency) || !text(t.configuration) || !text(t.deliveryTerms) || monetaryScale(r.unit) === null
        || (['USD', 'TWD', 'KRW'].includes(r.unit) && t.currency !== r.unit)) return '同SKU价格缺少配置/币种/交付条件，不能排除H20出口限制或Blackwell换代';
    }
    return null;
  }
  function compute(snapshot, options = {}) {
    const now = options.now == null ? Date.now() : +new Date(options.now), s = snapshot || {};
    const generated = utc(s.generatedAt), reason = snapshotReason(snapshot, now);
    const diagnostics = [], accepted = [], seen = new Set(), eventSeen = new Map(), ids = new Set();
    const records = Array.isArray(s.evidence) ? s.evidence : [];
    for (const r of records) {
      const invalid = validateEvidence(r, generated, now, reason);
      if (invalid) { diagnostics.push({id: r?.id || 'unknown', reason: invalid}); continue; }
      const key = JSON.stringify([r.chainId, r.companyId, r.periodStart, r.periodEnd, r.metric]);
      // Changing a chain label or record ID must not turn the same event into an independent chain.
      const event = JSON.stringify([r.group, r.periodStart, r.periodEnd, r.metric, r.sources.map(s => eventURL(s.url)).sort()]);
      const duplicate = seen.has(key) || (eventSeen.has(event) && eventSeen.get(event) !== r.chainId) || ids.has(r.id);
      // Keep conflicting versions for the conflict gate, but never count duplicate events twice.
      if (duplicate) {
        const previous = accepted.find(a => a.companyId === r.companyId && a.group === r.group && a.periodEnd === r.periodEnd && a.chainId === r.chainId);
        if (previous && previous.direction !== r.direction) previous.conflict = true;
        diagnostics.push({id: r.id, reason: '重复记录或重复同一事件，不增加独立链覆盖'}); continue;
      }
      seen.add(key); eventSeen.set(event, r.chainId); ids.add(r.id); accepted.push({...r});
    }
    const groups = Object.entries(GROUPS).map(([id, config]) => {
      const items = accepted.filter(r => r.group === id), seriesMap = new Map();
      const latestEnd = items.length ? Math.max(...items.map(r => date(r.periodEnd))) : null;
      const active = items.filter(r => latestEnd - date(r.periodEnd) <= 105 * DAY);
      const conflicts = active.some(a => a.conflict || active.some(b => a !== b && a.periodEnd === b.periodEnd && a.direction !== b.direction));
      for (const r of items) {
        const terms = r.comparableTerms;
        const key = JSON.stringify([r.companyId, r.chainId, r.metric, r.procurementSide || '', r.metric === 'sameSkuPrice' ? [terms.sku, terms.currency, terms.configuration, terms.deliveryTerms] : '', r.group === 'application' ? [r.deploymentDate, r.evaluationWindowQuarters] : '']);
        if (!seriesMap.has(key)) seriesMap.set(key, []);
        seriesMap.get(key).push(r);
      }
      let series = [...seriesMap.values()].map(rows => rows.sort((a, b) => date(a.periodEnd) - date(b.periodEnd)).slice(-2))
        .filter(rows => rows.length === 2 && consecutive(rows[0], rows[1]) && rows[0].unit === rows[1].unit);
      series = series.filter(rows => latestEnd - date(rows[1].periodEnd) <= 45 * DAY);
      let chainCount = new Set(series.map(rows => rows[1].chainId)).size;
      if (id === 'orders') {
        const matched = new Set(series.map(rows => rows[1].chainId).filter(chain => {
          const entries = series.filter(rows => rows[1].chainId === chain);
          return entries.some(a => a[1].procurementSide === 'buyer' && entries.some(b => b[1].procurementSide === 'supplier'
            && a[0].periodStart === b[0].periodStart && a[0].periodEnd === b[0].periodEnd && a[1].periodStart === b[1].periodStart && a[1].periodEnd === b[1].periodEnd));
        }));
        series = series.filter(rows => matched.has(rows[1].chainId)); chainCount = matched.size;
      }
      const sufficient = !conflicts && chainCount >= 2 && new Set(series.map(rows => rows[1].companyId)).size >= 2;
      const deteriorating = sufficient && series.every(rows => rows.every(r => r.direction === 'deteriorating'))
        && items.filter(r => latestEnd - date(r.periodEnd) <= 45 * DAY).every(r => r.direction === 'deteriorating');
      return {id, name: config.name, weight: config.weight, sufficient, deteriorating, chainCount, seriesCount: series.length, latestEnd: latestEnd === null ? null : new Date(latestEnd).toISOString().slice(0, 10),
        reason: conflicts ? '同期专项方向冲突，暂停该环节入分' : sufficient ? '两季度＋至少两公司/独立链确认' : id === 'application' ? '应用收入/贡献利润与事前成熟窗口尚待核验' : id === 'orders' ? '真实AI订单未公开或缺少同链采购方＋供应方两季交验（不是无订单）' : '正常化盈利/同SKU同条件价格归因缺口',
        records: items};
    });
    const ends = groups.map(g => date(g.latestEnd));
    const aligned = ends.every(Number.isFinite) && Math.max(...ends) - Math.min(...ends) <= 45 * DAY;
    const complete = !reason && groups.every(g => g.sufficient) && aligned;
    const count = groups.filter(g => g.deteriorating).length, score = complete ? [0, 35, 65, 85][count] : null;
    const level = score === null ? 'insufficient' : score >= 85 ? 'high' : score >= 65 ? 'elevated' : score >= 35 ? 'watch' : 'low';
    return {schemaVersion: 1, generatedAt: s.generatedAt || null, lastSuccessfulAt: s.lastSuccessfulAt || null, evaluatedAt: Number.isFinite(now) ? new Date(now).toISOString() : null,
      runStatus: s.runStatus || 'unavailable', snapshotReason: reason, score, level, coverage: complete ? 1 : 0, evidenceCoverage: groups.reduce((sum, g) => sum + (g.sufficient ? g.weight : 0), 0),
      groups, aligned, companies: companies(s, now, generated), diagnostics,
      errors: Array.isArray(s.errors) ? s.errors.map(e => typeof e === 'string' ? e : JSON.stringify(e)) : [],
      summary: complete ? ['专项证据稳定/改善，当前连续压力未确认', '一环节连续恶化', '两环节连续恶化', '三环节连续恶化，AI投入兑现压力高'][count]
        : groups.filter(g => g.deteriorating).length === 2 ? '两环节共振确认，应用兑现尚待核验；三段未齐仍不计分' : '专项直接证据不足，不推断低风险或高压', transportError: options.transportError || null};
  }
  const fmt = n => finite(n) ? n.toLocaleString('en-US', {maximumFractionDigits: 2}) : 'N/A';
  function link(s) { const u = httpsURL(s?.url); return u ? `<a href="${escapeHTML(u)}" target="_blank" rel="noopener noreferrer">${escapeHTML(s.name || '来源')}</a>` : escapeHTML(s?.name || '无有效HTTPS来源'); }
  function money(m) { return m?.usable ? `${fmt(m.value / 1e8)} 亿 ${escapeHTML(m.currency)}` : 'N/A（未披露/不可用）'; }
  function renderHTML(state) {
    const s = state || compute(getSnapshot());
    const chain = s.groups.map(g => `<article class="ar-card"><b>${escapeHTML(g.name)} · ${fmt(g.weight * 100)}%证据权重</b><p>${g.sufficient ? g.deteriorating ? '连续恶化确认' : '稳定/改善反证；未确认连续恶化' : '直接证据缺口'}</p><small>${escapeHTML(g.reason)} · ${g.chainCount}条独立链 · 最新期末 ${escapeHTML(g.latestEnd || 'N/A')}</small></article>`).join('');
    const matrix = Object.entries({designer: '设计商', foundry: '代工', memory: '存储', buyer: '采购/应用方'}).map(([role, title]) => `<h4>${title}</h4><div class="ar-table" tabindex="0" aria-label="${title}公司季度矩阵"><table><thead><tr><th>公司（文本标识）</th><th>真实季度 / 披露</th><th>公司营收</th><th>公司毛利率</th><th>官方来源交验 / AI订单</th></tr></thead><tbody>${s.companies.filter(c => c.role === role).map(c => {
      const q = c.latest;
      const comparison = q ? `<tr><td colspan="5"><small>${escapeHTML(c.id)} · ${escapeHTML(c.trend.label)} · ${escapeHTML(c.trend.crossCheck)}：三季毛利变化 ${fmt(c.trend.marginPP)}pp；库存/营收比变化 ${fmt(c.trend.inventoryRevenueChange)}；营收同比 ${fmt(c.trend.revenueYoY)}%<br>${escapeHTML(c.crossCheck.reason || '官方来源未交验')}；非AI订单，不计分。</small></td></tr>` : '';
      return `<tr><td><b>${escapeHTML(c.id)}</b><br>${escapeHTML(c.name)}<br><small>${escapeHTML(c.status)} · ${c.fresh ? '季度期末≤200天' : 'N/A / 过期或无季度'}</small></td><td>${q ? escapeHTML(q.start) + ' – ' + escapeHTML(q.end) + '<br>披露 ' + escapeHTML(q.filed) : 'N/A（无季度）'}</td><td>${c.fresh ? money(q.metrics.revenue) : 'N/A'}</td><td>${c.fresh && q.metrics.grossMargin.usable ? fmt(q.metrics.grossMargin.value) + '%' : 'N/A'}</td><td>${escapeHTML(c.crossCheck.status === 'verified' ? '来源交验 verified（非AI专项）' : '官方来源未交验 · ' + c.crossCheck.status)}<br>${s.groups[1].records.some(r => r.companyId === c.id) ? 'AI订单专项记录见诊断（仍需全链门槛）' : 'AI orders 缺失 / 未公开（不是无订单）'}<br>${link(c.source)}</td></tr>${comparison}`;
    }).join('')}</tbody></table></div>`).join('');
    const trends = s.companies.filter(c => c.trend.watch).map(c => `<p>${escapeHTML(c.id)} · 观察（公司财报代理）：三连续季毛利变化 ${fmt(c.trend.marginPP)}pp，库存/营收比变化 ${fmt(c.trend.inventoryRevenueChange)}；不加分。</p>`).join('');
    const diagnostics = s.diagnostics.map(d => `<li>${escapeHTML(d.id)}：${escapeHTML(d.reason)}</li>`).join('');
    const rawSources = s.companies.map(c => `<details><summary>${escapeHTML(c.id)} 原始季度/指标来源与诊断</summary><p>抓取 ${escapeHTML(c.fetchedAt || 'N/A')} · ${link(c.source)} / 副源 ${link(c.crossCheck.source)} · ${escapeHTML(c.crossCheck.reason || '')} · ${escapeHTML(c.reason || '')}</p>${c.quarters.map(q => `<p>${escapeHTML(q.start)} – ${escapeHTML(q.end)} · 披露 ${escapeHTML(q.filed)} · accession ${escapeHTML(q.accession || 'N/A')}</p>${Object.entries(q.metrics).map(([id, m]) => `<small>${escapeHTML(id)}: ${id === 'grossMargin' ? fmt(m.value) + '%' : money(m)} · ${escapeHTML(m.reason || m.kind)} · ${link(m.source)}</small>`).join('')}`).join('')}${c.disclosures.map(d => `<p>${escapeHTML(d.publishedAt)} · ${escapeHTML(d.title)} · ${link(d.source)}</p>`).join('')}</details>`).join('');
    const evidence = s.groups.flatMap(g => g.records).map(r => `<li>${escapeHTML(r.companyId)} / ${escapeHTML(r.chainId)} / ${escapeHTML(r.metric)} · ${escapeHTML(r.periodStart)} – ${escapeHTML(r.periodEnd)} · ${fmt(r.value)} vs ${fmt(r.baseline)} ${escapeHTML(r.unit)} · ${escapeHTML(r.summary)} · 人工复核 ${escapeHTML(r.reviewedAt)}<br>${r.sources.map(link).join(' / ')}</li>`).join('');
    return `<section class="ai-realization" aria-label="AI投入兑现压力" data-ai-level="${escapeHTML(s.level)}">
      <style>.ai-realization{color:var(--text-1,#eae6df);line-height:1.7;font-size:13px;min-width:0}.ai-realization h3,.ai-realization h4{color:var(--gold-bright,#f5d574)}.ai-realization h3{margin:26px 0 12px;font-size:17px}.ai-realization .ar-card{background:var(--panel,#16171e);border:1px solid var(--line,#26262f);border-top:2px solid var(--gold,#d4af37);border-radius:12px;padding:16px;min-width:0}.ai-realization .ar-score{font-size:30px;color:var(--gold,#d4af37);display:block;font-family:monospace}.ai-realization .ar-chain{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin:14px 0}.ai-realization small{display:block;color:var(--text-2,#b9b4ab);font-size:11px;overflow-wrap:anywhere}.ai-realization .ar-table{max-width:100%;overflow-x:auto;overscroll-behavior-x:contain}.ai-realization table{border-collapse:collapse;width:100%;min-width:680px}.ai-realization th,.ai-realization td{text-align:left;padding:10px;border-bottom:1px solid var(--line,#26262f);overflow-wrap:anywhere}.ai-realization a{color:var(--gold,#d4af37)}.ai-realization a:focus-visible,.ai-realization summary:focus-visible,.ai-realization .ar-table:focus-visible{outline:2px solid var(--gold-bright,#f5d574);outline-offset:3px}.ai-realization details{margin:10px 0;overflow-wrap:anywhere}.ai-realization summary{cursor:pointer}.ai-realization p{margin:8px 0}@media(max-width:600px){.ai-realization .ar-chain{grid-template-columns:1fr}.ai-realization .ar-card{padding:14px}.ai-realization .ar-score{font-size:28px}}</style>
      <h3>企业侧 · AI投入兑现压力</h3><div class="ar-card"><strong class="ar-score" data-ai-score="realization">${s.score === null ? 'N/A · 专项证据不足' : fmt(s.score) + ' / 100'}</strong><b>${escapeHTML(s.summary)}</b><small>快照 ${escapeHTML(s.generatedAt || 'N/A')} · 最近成功 ${escapeHTML(s.lastSuccessfulAt || 'N/A')} · 时效核验 ${escapeHTML(s.evaluatedAt)} · ${escapeHTML(s.snapshotReason || s.runStatus)}<br>capex可计分覆盖 ${fmt(s.coverage * 100)}% · 专项证据覆盖 ${fmt(s.evidenceCoverage * 100)}%${!s.aligned ? ' · 跨组三段最新期末未对齐（≤45天）' : ''}${s.transportError ? '<br>AI读取失败: ' + escapeHTML(s.transportError) + '；保留原快照日期并重新核验。' : ''}</small><p>已投产容量在事前成熟评估窗口后：应用收入/贡献利润低兑现 → 采购取消或延期 → 正常化盈利承压。不是“2027一定建完/必跌”。</p></div>
      <div class="ar-chain">${chain}</div><small>40% / 35% / 25%仅为证据覆盖记账；三组全部确认才使用原capex权重20%、影响95%。缺口不占权重、不稀释旧评分；估值侧引用同一状态，不重复计分。各组至少两公司、两独立链、两连续季度，订单须同链采购方与供应方交验；跨组最新期末≤45天。</small>
      ${matrix}<div class="ar-card"><b>公司财报仅作观察 proxy</b><p>总营收、GAAP毛利率、库存、PPE、资本开支与现金流不能冒充AI-specific实证。未披露=N/A，不是0；币种分别显示亿 USD / TWD / KRW，绝不跨币种汇总。</p>${trends || '<p>没有满足三连续季度与交验要求的代理预警；不代表AI订单健康。</p>'}<small>默认可校准研究阈值：专项金额/数量变化≥10%，比例变化≥3个百分点；公司代理三季毛利下降≥3pp、库存/营收比上升仅观察。同比营收必须有一年真实基期。专项得分：全稳定/改善0，一/二/三组连续恶化35/65/85；改善反证可自动降级。阈值/等级未历史校准，不是发生率，不保证出清。来源仅验证结构；“人工核验原文的专项证据”不表示前端自动验证语义。盈利必须正常化归因；同SKU价格必须同配置/币种/交付条件，排除H20出口限制、Blackwell换代等混淆。</small></div>
      <details><summary>原始来源、专项证据与诊断（折叠）</summary>${s.errors.length ? '<p>AI采集错误: ' + s.errors.map(escapeHTML).join('<br>') + '</p>' : ''}<ul>${diagnostics}${evidence}</ul>${rawSources}</details>
    </section>`;
  }
  async function requestSnapshot(options = {}) {
    const url = options.url || 'data/ai-company-daily.json';
    const base = root?.location?.href;
    if (typeof url !== 'string' || /[\u0000-\u0020\\]/.test(url) || (base ? new URL(url, base).origin !== new URL(base).origin : /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(url))) throw new Error('只允许同源JSON路径');
    const fetcher = options.fetch || ((...args) => globalThis.fetch(...args));
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => { if (controller) controller.abort(); reject(new Error('读取超时（12秒）')); }, 12000); });
    try {
      return await Promise.race([(async () => {
        const response = await fetcher(url, {cache: 'no-store', ...(controller ? {signal: controller.signal} : {})});
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return await response.json();
      })(), timeout]);
    } finally { clearTimeout(timer); }
  }
  let acceptedSnapshot = null, transportError = null, loading = null;
  function getSnapshot() { return acceptedSnapshot; }
  async function load(options = {}) {
    if (loading) return loading;
    loading = (async () => {
      try {
        const next = await requestSnapshot(options), now = options.now == null ? Date.now() : +new Date(options.now);
        const reason = snapshotReason(next, now);
        if (reason && !['AI本次采集失败，专项证据暂停入分', 'AI每日快照超过48小时；保留原始日期，暂停入分'].includes(reason)) throw new Error(reason);
        if (acceptedSnapshot && utc(next.generatedAt) < utc(acceptedSnapshot.generatedAt)) throw new Error('AI快照生成时间倒退，拒绝覆盖');
        acceptedSnapshot = next; transportError = null;
      } catch (e) { transportError = String(e.message || e); }
      return compute(acceptedSnapshot, {...options, transportError});
    })();
    try { return await loading; } finally { loading = null; }
  }
  return {TRACKED, GROUPS, FRESH_DAYS, compute, renderHTML, load, getSnapshot, requestSnapshot, snapshotReason, utc, httpsURL, escapeHTML};
});
