
const { execSync } = require('child_process');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const cron = require('node-cron');
const axios = require('axios');
const yf = require('yahoo-finance2').default;
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

const pool = new Pool({ user: 'gonggu_user', password: 'gonggu123', host: 'localhost', database: 'gonggu', port: 5432 });
const WORKER_URL = 'https://hkstockdata.garysze77.workers.dev/?url=';
const EJFQ_HEADERS = { 'authority': 'www.ejfq.com', 'accept': '*/*', 'accept-language': 'zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7', 'content-type': 'text/plain', 'referer': 'https://www.ejfq.com/home/tc/screener360.htm', 'user-agent': 'Mozilla/5.0', 'x-requested-with': 'XMLHttpRequest' };
const STOCKS = { '700': '騰訊', '3690': '美團', '9988': '阿里巴巴', '09988': '阿里-SW', '9618': '京東', '1024': '快手', '9999': '網易', '939': '建設銀行', '3988': '中國銀行', '0005': 'HSBC', '2388': '港交所', '1113': '長實', '0001': '長江', '0012': '恒地', '0016': '恒大', '0011': '恆生銀行', '1109': '置地', '6830': '華潤置地', '6690': '海爾智家', '6060': '眾安', '1858': '青島啤酒', '0762': '中移動', '6822': '香港電訊', '0883': '中海油', '0857': '中石油', '291': '華潤啤酒', '2319': '蒙牛乳業', '0019': '太古', '1177': '中生製藥', '2269': '藥明生物', '0669': '創科', '0836': '華潤置地', '1108': '熊貓', '2800': '盈富基金', '2828': '恒生ETF', '3032': '南方A50', 'HSI': '恆生指數', 'HSCEI': '國企指數', '2618': 'TCL電子', '0688': '中國海外', '0728': '中國電信', '0175': '吉利汽車', '1211': '比亞迪股份', '0027': '銀河娛樂', '0188': '中外運', '0269': '中遠海運', '0195': '新奧能源', '1171': '兗州煤業', '0116': 'Volvo', '0233': '創科實業', '0696': '首程控股', '0386': '中石化', '0330': '思愛普' };

function calculateRSI(prices, period) {
  period = period || 14;
  if (!prices || prices.length < period + 1) return null;
  let gains = [], losses = [];
  for (let i = 1; i < prices.length; i++) { const change = prices[i] - prices[i-1]; gains.push(change > 0 ? change : 0); losses.push(change < 0 ? Math.abs(change) : 0); }
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b, 0) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const rsiValues = [];
  for (let i = period; i < gains.length; i++) { avgGain = (avgGain * (period - 1) + gains[i]) / period; avgLoss = (avgLoss * (period - 1) + losses[i]) / period; if (avgLoss === 0) { rsiValues.push(100); } else { const rs = avgGain / avgLoss; rsiValues.push(100 - (100 / (1 + rs))); } }
  return rsiValues;
}

function calculateEMA(prices, period) {
  if (!prices || prices.length < period) return null;
  const multiplier = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const emaValues = [];
  for (let i = period; i < prices.length; i++) { ema = (prices[i] - ema) * multiplier + ema; if (!isNaN(ema) && isFinite(ema)) emaValues.push(ema); }
  return emaValues.length > 0 ? emaValues : null;
}

function calculateMACD(prices) {
  const ema12 = calculateEMA(prices, 12); const ema26 = calculateEMA(prices, 26);
  if (!ema12 || !ema26 || ema12.length < 9) return null;
  const macdLine = ema12.map((v, i) => v - ema26[ema26.length - ema12.length + i]);
  const signalLine = calculateEMA(macdLine, 9);
  if (!signalLine || signalLine.length === 0) return null;
  return { macd: macdLine[macdLine.length - 1], signal: signalLine[signalLine.length - 1], histogram: macdLine[macdLine.length - 1] - signalLine[signalLine.length - 1] };
}

function calculateMA(prices, period) {
  if (!prices || prices.length < period) return null;
  const maValues = [];
  for (let i = period - 1; i < prices.length; i++) { maValues.push(prices.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period); }
  return maValues;
}

function calculateBollingerBands(prices, period) {
  period = period || 20; const ma = calculateMA(prices, period);
  if (!ma) return null; const upper = [], lower = [];
  for (let i = 0; i < ma.length; i++) { const slice = prices.slice(i, i + period); const mean = ma[i]; const variance = slice.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / period; const std = Math.sqrt(variance); upper.push(mean + 2 * std); lower.push(mean - 2 * std); }
  return { upper: upper[upper.length - 1], middle: ma[ma.length - 1], lower: lower[lower.length - 1] };
}

function safeNum(val) { if (val === null || val === undefined || isNaN(val) || !isFinite(val)) return null; return parseFloat(val); }
function safeFixed(val, decimals) { const n = safeNum(val); return n !== null ? n.toFixed(decimals) : null; }

async function fetchStockData(symbol) {
  try {
    const targetUrl = encodeURIComponent('https://www.ejfq.com/home/tc/tradingview3_360/php/chartfeed.php?symbol=' + symbol + '&resolution=D&method=history');
    const url = WORKER_URL + targetUrl;
    const response = await axios.get(url, { headers: EJFQ_HEADERS });
    return response.data;
  } catch (error) { console.error('Error fetching ' + symbol + ':', error.message); return null; }
}

async function getFundamentals(symbol) {
  try {
    const quote = await yf.quote(symbol + '.HK');
    if (!quote) return null;
    return { marketCap: quote.marketCap || null, peRatio: quote.trailingPE || null, dividendYield: quote.dividendYield ? quote.dividendYield * 100 : null, eps: quote.epsTrailingTwelveMonths || null, volume: quote.regularMarketVolume || null, avgVolume: quote.averageVolume || null };
  } catch (error) { return null; }
}

async function analyzeStock(symbol) {
  const data = await fetchStockData(symbol);
  if (!data || data.s !== 'ok') return null;
  const closes = data.c; const timestamps = data.t; const volumes = data.v;
  const result = { symbol: symbol, name: STOCKS[symbol] || symbol, close: closes[closes.length - 1], date: new Date(timestamps[timestamps.length - 1] * 1000).toISOString().split('T')[0] };
  const rsi14 = calculateRSI(closes, 14); result.rsi14 = safeFixed(rsi14 ? rsi14[rsi14.length - 1] : null, 2);
  const macd = calculateMACD(closes);
  if (macd) { result.macd = safeFixed(macd.macd, 4); result.macdSignal = safeFixed(macd.signal, 4); result.macdHistogram = safeFixed(macd.histogram, 4); }
  const ma5 = calculateMA(closes, 5), ma10 = calculateMA(closes, 10), ma20 = calculateMA(closes, 20), ma50 = calculateMA(closes, 50);
  result.ma5 = safeFixed(ma5 ? ma5[ma5.length - 1] : null, 2); result.ma10 = safeFixed(ma10 ? ma10[ma10.length - 1] : null, 2); result.ma20 = safeFixed(ma20 ? ma20[ma20.length - 1] : null, 2); result.ma50 = safeFixed(ma50 ? ma50[ma50.length - 1] : null, 2);
  const bb = calculateBollingerBands(closes);
  if (bb) { result.bbUpper = safeFixed(bb.upper, 2); result.bbMiddle = safeFixed(bb.middle, 2); result.bbLower = safeFixed(bb.lower, 2); }
  const volMA = volumes ? calculateMA(volumes, 20) : null; const currentVol = volumes ? volumes[volumes.length - 1] : 0;
  result.volume = currentVol; result.volumeSMA = safeFixed(volMA ? volMA[volMA.length - 1] : null, 0); result.volumeRatio = safeFixed((volMA && currentVol) ? currentVol / volMA[volMA.length - 1] : null, 2);
  if (closes.length >= 2) result.change = safeFixed(((closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2] * 100), 2);
  const days252 = Math.min(closes.length, 252); const closes252 = closes.slice(-days252);
  result.high52wk = Math.max.apply(null, closes252).toFixed(2); result.low52wk = Math.min.apply(null, closes252).toFixed(2);
  let buyScore = 0, sellScore = 0;
  if (result.rsi14 && result.rsi14 < 30) buyScore += 3; if (result.rsi14 && result.rsi14 > 70) sellScore += 3;
  if (result.rsi14 && result.rsi14 < 40) buyScore += 1; if (result.rsi14 && result.rsi14 > 60) sellScore += 1;
  if (result.macdHistogram && result.macdHistogram > 0) buyScore += 2; if (result.macdHistogram && result.macdHistogram < 0) sellScore += 2;
  if (result.ma5 && result.ma20 && result.ma5 > result.ma20) buyScore += 2; if (result.ma5 && result.ma20 && result.ma5 < result.ma20) sellScore += 2;
  if (result.volumeRatio && result.volumeRatio > 1.5) buyScore += 1;
  if (buyScore > sellScore + 2) result.signal = 'BUY'; else if (sellScore > buyScore + 2) result.signal = 'SELL'; else if (buyScore > sellScore) result.signal = 'BUY'; else if (sellScore > buyScore) result.signal = 'SELL'; else result.signal = 'HOLD';
  result.buyScore = buyScore;
  const fundamentals = await getFundamentals(symbol);
  if (fundamentals) { result.marketCap = fundamentals.marketCap ? (fundamentals.marketCap > 1e9 ? (fundamentals.marketCap/1e9).toFixed(2) + 'B' : (fundamentals.marketCap/1e6).toFixed(2) + 'M') : null; result.peRatio = safeFixed(fundamentals.peRatio, 2); result.dividendYield = safeFixed(fundamentals.dividendYield, 2); result.eps = safeFixed(fundamentals.eps, 2); }
  result.sellScore = sellScore;
  return result;
}


app.get('/api/health', (req, res) => { res.json({ status: 'ok', timestamp: new Date() }); });

app.get('/api/stocks', async (req, res) => {
  try {
    const results = [];
    for (const symbol of Object.keys(STOCKS)) { const analysis = await analyzeStock(symbol); if (analysis) results.push(analysis); }
    const buyStocks = results.filter(s => s.signal === 'BUY'); const sellStocks = results.filter(s => s.signal === 'SELL');
    const today = new Date().toISOString().split('T')[0];
    const checkResult = await pool.query('SELECT date FROM daily_signals WHERE date = $1', [today]);
    if (checkResult.rows.length === 0) { await pool.query('INSERT INTO daily_signals (date, buy_count, sell_count, signals) VALUES ($1, $2, $3, $4)', [today, buyStocks.length, sellStocks.length, JSON.stringify(results)]); }
    else { await pool.query('UPDATE daily_signals SET buy_count = $1, sell_count = $2, signals = $3 WHERE date = $4', [buyStocks.length, sellStocks.length, JSON.stringify(results), today]); }
    res.json({ generated_at: new Date().toISOString(), total_stocks: results.length, buy_signals: buyStocks, sell_signals: sellStocks, all_stocks: results });
  } catch (error) { console.error('Error:', error); res.status(500).json({ error: error.message }); }
});

app.get('/api/signals', async (req, res) => { try { const result = await pool.query('SELECT * FROM daily_signals ORDER BY date DESC LIMIT 1'); if (result.rows.length > 0) res.json(result.rows[0]); else res.json({ message: 'No data yet' }); } catch (error) { res.status(500).json({ error: error.message }); } });
app.get('/api/stock/:symbol', async (req, res) => { try { const { symbol } = req.params; const analysis = await analyzeStock(symbol); if (analysis) res.json(analysis); else res.status(404).json({ error: 'Stock not found' }); } catch (error) { res.status(500).json({ error: error.message }); } });

cron.schedule('30 1 * * *', async () => { console.log('Running daily scan...'); const results = []; for (const symbol of Object.keys(STOCKS)) { const analysis = await analyzeStock(symbol); if (analysis) results.push(analysis); } console.log('Daily scan complete:', results.filter(r => r.signal === 'BUY').length, 'BUY signals'); });

async function initDB() { await pool.query('CREATE TABLE IF NOT EXISTS daily_signals (date DATE PRIMARY KEY, buy_count INTEGER, sell_count INTEGER, signals JSONB, created_at TIMESTAMP DEFAULT NOW())'); console.log('Database initialized'); }
initDB().then(() => { app.listen(PORT, () => { console.log('GongGu API running on port ' + PORT); }); });

app.get('/api/kline/:symbol', async (req, res) => {
  try {
    const { symbol } = req.params; const data = await fetchStockData(symbol);
    if (!data || data.s !== 'ok') { return res.status(404).json({ error: 'Stock not found' }); }
    const kline = []; for (let i = 0; i < data.t.length; i++) { kline.push({ time: data.t[i], open: data.o[i], high: data.h[i], low: data.l[i], close: data.c[i], volume: data.v[i] }); }
    res.json({ symbol: symbol, name: STOCKS[symbol] || symbol, kline: kline });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/api/info/:symbol', async (req, res) => {
  const { symbol } = req.params;
  if (!symbol) return res.json({ error: 'Missing symbol' });
  try {
    const ticker = symbol + '.HK';
    const yahooUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/' + ticker + '?interval=1d&range=1y';
    const response = await axios.get(yahooUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    const data = response.data;
    if (data.chart && data.chart.result && data.chart.result[0]) {
      const result = data.chart.result[0]; const meta = result.meta; const indicators = result.indicators;
      const closes = indicators.quote[0].close.filter(c => c !== null);
      const high52wk = Math.max.apply(null, closes); const low52wk = Math.min.apply(null, closes);
      res.json({ symbol: symbol, name: meta.shortName || meta.symbol || symbol, price: meta.regularMarketPrice, previousClose: meta.previousClose, change: meta.regularMarketPrice - meta.previousClose, changePercent: ((meta.regularMarketPrice - meta.previousClose) / meta.previousClose) * 100, volume: meta.regularMarketVolume, avgVolume: meta.averageVolume, marketCap: meta.marketCap, peRatio: meta.trailingPE, dividendYield: meta.dividendYield ? meta.dividendYield * 100 : null, fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh || high52wk, fiftyTwoWeekLow: meta.fiftyTwoWeekLow || low52wk, currency: meta.currency });
    } else { res.json({ error: 'Stock not found' }); }
  } catch (error) { res.json({ error: error.message }); }
});

app.get('/api/chart', (req, res) => {
  const symbol = req.query.symbol; const resolution = req.query.resolution || '5';
  if (!symbol) return res.json({ error: 'Missing symbol' });
  try {
    const ejfqUrl = 'https://www.ejfq.com/home/tc/tradingview3_360/php/chartfeed.php?symbol=' + symbol + '&method=intraday&resolution=' + resolution;
    const curlCmd = `curl -s --compressed -L 'https://hkstockdata.garysze77.workers.dev/?url=${encodeURIComponent(ejfqUrl)}'`;
    const output = execSync(curlCmd, { encoding: 'utf8', timeout: 30000 }); const data = JSON.parse(output);
    if (data.s === 'ok') {
      const closes = data.c.map(c => parseFloat(c)); const bb = calculateBBArray(closes, 20);
      const ma5 = calculateMAArray(closes, 5); const ma10 = calculateMAArray(closes, 10); const ma20 = calculateMAArray(closes, 20); const ma50 = calculateMAArray(closes, 50);
      const chartData = data.t.map((timestamp, i) => ({ time: timestamp, open: data.o[i], high: data.h[i], low: data.l[i], close: data.c[i], volume: data.v ? data.v[i] : 0, ma5: ma5 ? parseFloat((ma5[i] || 0).toFixed(2)) : null, ma10: ma10 ? parseFloat((ma10[i] || 0).toFixed(2)) : null, ma20: ma20 ? parseFloat((ma20[i] || 0).toFixed(2)) : null, ma50: ma50 ? parseFloat((ma50[i] || 0).toFixed(2)) : null, bbUpper: bb && bb.upper[i] ? parseFloat(bb.upper[i].toFixed(2)) : null, bbMiddle: bb && bb.middle[i] ? parseFloat(bb.middle[i].toFixed(2)) : null, bbLower: bb && bb.lower[i] ? parseFloat(bb.lower[i].toFixed(2)) : null }));
      res.json({ symbol: symbol, resolution: resolution, data: chartData });
    } else { res.json({ error: 'Failed to fetch data from EJFQ', detail: data.s }); }
  } catch (error) { res.json({ error: error.message }); }
});

app.get('/api/price-prediction/:symbol', async (req, res) => {
  const { symbol } = req.params; if (!symbol) return res.json({ error: 'Missing symbol' });
  try {
    const from = Math.floor(Date.now() / 1000) - 86400 * 3; const to = Math.floor(Date.now() / 1000);
    const ejfqUrl = 'https://www.ejfq.com/home/tc/tradingview3_360/php/chartfeed.php?symbol=' + symbol + '&resolution=1&from=' + from + '&to=' + to + '&method=intraday';
    const curlCmd = `curl -s --compressed -L 'https://hkstockdata.garysze77.workers.dev/?url=${encodeURIComponent(ejfqUrl)}'`;
    const output = execSync(curlCmd, { encoding: 'utf8', timeout: 30000 }); const chartData = JSON.parse(output);
    if (chartData.s !== 'ok' || !chartData.c || chartData.c.length === 0) { return res.json({ error: 'Failed to fetch chart data' }); }
    const currentPrice = chartData.c[chartData.c.length - 1];
    const predictCmd = 'cd ~/gonggu-backend && python3 price_model.py predict ' + symbol + ' ' + currentPrice;
    const predictOutput = execSync(predictCmd, { encoding: 'utf8', timeout: 60000 }); const prediction = JSON.parse(predictOutput);
    res.json({ symbol: symbol, current_price: currentPrice, buy_target: prediction.buy_target, sell_target: prediction.sell_target, buy_target_pct: prediction.buy_target_pct, sell_target_pct: prediction.sell_target_pct, timestamp: new Date().toISOString() });
  } catch (error) { res.json({ error: error.message }); }
});

function calculateMAArray(prices, period) {
  if (!prices || prices.length < period) return null;
  var result = []; for (var i = 0; i < prices.length; i++) { if (i < period - 1) { result.push(null); } else { var slice = prices.slice(i - period + 1, i + 1); result.push(slice.reduce(function(a, b) { return a + b; }, 0) / period); } }
  return result;
}

function calculateBBArray(prices, period) {
  period = period || 20; if (!prices || prices.length < period) return null;
  var ma = calculateMAArray(prices, period); if (!ma) return null; var upper = [], lower = [];
  for (var i = 0; i < prices.length; i++) {
    if (i < period - 1) { upper.push(null); lower.push(null); }
    else { var slice = prices.slice(i - period + 1, i + 1); var m = ma[i]; var std = Math.sqrt(slice.reduce(function(acc, val) { return acc + Math.pow(val - m, 2); }, 0) / period); upper.push(m + 2 * std); lower.push(m - 2 * std); }
  }
  return { upper: upper, middle: ma, lower: lower };
}

// ==================== Stock Screener (Stock360) ====================
var industryCache = { data: null, timestamp: 0 };
var INDUSTRY_CACHE_TTL = 60 * 60 * 1000;
var MIN_MCAP_BILLION = 10;
var MAX_MCAP_BILLION = 50;

function parseMarketCapBillion(str) {
  if (!str || typeof str !== 'string') return null;
  var cleaned = str.replace(/,/g, '').replace(/[億亿]/g, '').trim();
  var num = parseFloat(cleaned);
  if (isNaN(num)) return null;
  return num;
}

async function scrapeIndustries() {
  var url = 'https://stock360.hkej.com/marketWatch/Industry';
  var response = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8' }, timeout: 15000 });
  var $ = cheerio.load(response.data);
  var industries = [];
  $('a[href*="sectorDetails?sc="]').each(function(i, el) {
    var href = $(el).attr('href');
    var match = href.match(/sc=([^&]+)/);
    if (match) {
      var code = match[1];
      var name = $(el).text().trim();
      var row = $(el).closest('tr');
      var cells = row.find('td');
      var changeRate = null, riseCount = null, totalCount = null, turnover = null, marketShare = null;
      cells.each(function(ci, cell) {
        var text = $(cell).text().trim();
        if (ci === 1) changeRate = text;
        if (ci === 2) riseCount = text;
        if (ci === 3) totalCount = text;
        if (ci === 5) turnover = text;
        if (ci === 6) marketShare = text;
      });
      if (name && code) { industries.push({ code: code, name: name, changeRate: changeRate, riseCount: riseCount, totalCount: totalCount, turnover: turnover, marketShare: marketShare }); }
    }
  });
  return industries;
}

async function scrapeSectorStocks(code) {
  var url = 'https://stock360.hkej.com/marketWatch/Industry/sectorDetails?sc=' + code;
  var response = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8' }, timeout: 15000 });
  var $ = cheerio.load(response.data);
  var stocks = [];
  $('table').find('tr').each(function(i, row) {
    var cells = $(row).find('td');
    if (cells.length < 7) return;
    var cellTexts = [];
    cells.each(function(ci, cell) { cellTexts.push($(cell).text().trim()); });
    var firstCell = $(cells[0]);
    var link = firstCell.find('a').attr('href') || '';
    var codeMatch = link.match(/\/quotePlus\/(\d+)/);
    var stockCode = codeMatch ? codeMatch[1] : cellTexts[0].replace(/\D/g, '');
    var name = cellTexts[1] || '';
    var price = cellTexts[2] || '';
    var change = cellTexts[3] || '';
    var changeRateStr = cellTexts[4] || '';
    var peRatio = cellTexts[5] || '';
    var turnover = cellTexts[6] || '';
    var marketCapStr = cellTexts[7] || '';
    var changeRate = parseFloat(changeRateStr.replace(/[+%]/g, ''));
    var marketCapYi = parseMarketCapBillion(marketCapStr);
    if (stockCode && name) {
      stocks.push({ code: stockCode, name: name, price: price, change: change, changeRate: isNaN(changeRate) ? null : changeRate, peRatio: peRatio, turnover: turnover, marketCap: marketCapStr, marketCapBillion: marketCapYi });
    }
  });
  return stocks;
}

app.get('/api/industries', async (req, res) => {
  try {
    var now = Date.now();
    if (industryCache.data && (now - industryCache.timestamp) < INDUSTRY_CACHE_TTL) {
      return res.json({ source: 'cache', cached_at: new Date(industryCache.timestamp).toISOString(), industries: industryCache.data });
    }
    var industries = await scrapeIndustries();
    industryCache = { data: industries, timestamp: now };
    res.set('Cache-Control', 'public, max-age=3600');
    res.json({ source: 'live', scraped_at: new Date().toISOString(), industries: industries });
  } catch (error) {
    console.error('Error scraping industries:', error.message);
    if (industryCache.data) {
      return res.json({ source: 'stale_cache', cached_at: new Date(industryCache.timestamp).toISOString(), warning: 'Using stale cache due to scrape error: ' + error.message, industries: industryCache.data });
    }
    res.status(500).json({ error: 'Failed to fetch industries', detail: error.message });
  }
});

app.get('/api/industry/:code/stocks', async (req, res) => {
  try {
    var code = req.params.code;
    var stocks = await scrapeSectorStocks(code);
    var filtered = stocks.filter(function(s) {
      if (s.marketCapBillion === null) return false;
      return s.marketCapBillion >= MIN_MCAP_BILLION && s.marketCapBillion <= MAX_MCAP_BILLION;
    });
    filtered.sort(function(a, b) { return (b.changeRate || 0) - (a.changeRate || 0); });
    var top5 = filtered.slice(0, 5);
    res.set('Cache-Control', 'private, max-age=300');
    res.json({ industry_code: code, filter: { market_cap_min: MIN_MCAP_BILLION + 'B', market_cap_max: MAX_MCAP_BILLION + 'B', sort_by: 'rise_rate_desc', limit: 5 }, total_matched: filtered.length, stocks: top5 });
  } catch (error) {
    console.error('Error scraping sector stocks:', error.message);
    res.status(500).json({ error: 'Failed to fetch sector stocks', detail: error.message });
  }
});
