import WebSocket from 'ws';
import axios from 'axios';
import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';

dotenv.config();

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const CONFIG = {
  TELEGRAM_BOT_TOKEN:     process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID:       process.env.TELEGRAM_CHAT_ID,

  SPREAD_ENTRY_THRESHOLD: parseFloat(process.env.SPREAD_ENTRY_THRESHOLD || '0.7'),
  // EXIT трохи нижче ENTRY, але не занадто низько — lastPrice/indexPrice
  // мають постійний "шум" ~0.1-0.2% навіть при рівновазі
  SPREAD_EXIT_THRESHOLD:  parseFloat(process.env.SPREAD_EXIT_THRESHOLD  || '0.5'),

  // Мінімальна пауза між двома Entry-сповіщеннями для одного символу (мс)
  SIGNAL_COOLDOWN_MS: parseInt(process.env.SIGNAL_COOLDOWN_MS || '60000'),

  MAX_WS_CONNECTIONS: parseInt(process.env.MAX_WS_CONNECTIONS || '5'),
  BATCH_SIZE:         parseInt(process.env.BATCH_SIZE         || '10'),
  BATCH_DELAY_MS:     parseInt(process.env.BATCH_DELAY_MS     || '200'),

  BYBIT_WS_URL:  'wss://stream.bybit.com/v5/public/linear',
  BYBIT_API_URL: 'https://api.bybit.com/v5/market/instruments-info',

  RECONNECT_DELAY_MS: 5_000,
};

if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
  console.error('[ERROR] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env');
  process.exit(1);
}

// ─── STATE ─────────────────────────────────────────────────────────────────────
const tg = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN);

const state = {
  symbols:         [],
  activeSignals:   new Map(), // symbol → { direction, entryTime, entrySpread }
  lastSignalTime:  new Map(), // symbol → timestamp (для cooldown)
  lastIndexPrice:  new Map(), // symbol → indexPrice (кеш — Bybit іноді не шле у кожному тіку)
  wsConnections:   [],
  reconnectTimers: [],
};

// ─── TELEGRAM (non-blocking fire-and-forget) ───────────────────────────────────
// Головна оптимізація порівняно з оригіналом: прибрали await —
// Telegram більше не блокує обробку WebSocket-тіків
function sendTelegram(text) {
  tg.sendMessage(CONFIG.TELEGRAM_CHAT_ID, text, { parse_mode: 'HTML' })
    .catch(err => console.error('[TG] Send error:', err.message));
}

// ─── HELPERS ───────────────────────────────────────────────────────────────────
function calcSpread(lastPrice, indexPrice) {
  if (!lastPrice || !indexPrice || indexPrice === 0) return 0;
  return ((lastPrice - indexPrice) / indexPrice) * 100;
}

function formatEntry(symbol, direction, lastPrice, indexPrice, spread) {
  return (
    `📊 <b>SPREAD SIGNAL</b>\n` +
    `SYMBOL: <code>${symbol}</code>\n` +
    `DIRECTION: <b>${direction}</b>\n` +
    `LAST_PRICE: ${lastPrice}\n` +
    `INDEX_PRICE: ${indexPrice}\n` +
    `SPREAD: <b>${spread.toFixed(3)}%</b>\n` +
    `TIME: ${new Date().toISOString()}`
  );
}

function formatExit(symbol, direction, lastPrice, indexPrice, spread, entrySpread) {
  return (
    `✅ <b>SPREAD CLOSED</b>\n` +
    `SYMBOL: <code>${symbol}</code>\n` +
    `DIRECTION: ${direction}\n` +
    `LAST_PRICE: ${lastPrice}\n` +
    `INDEX_PRICE: ${indexPrice}\n` +
    `SPREAD: ${spread.toFixed(3)}%\n` +
    `ENTRY WAS: ${entrySpread.toFixed(3)}%\n` +
    `TIME: ${new Date().toISOString()}`
  );
}

// ─── CORE LOGIC ────────────────────────────────────────────────────────────────
function processTickerData(data) {
  const symbol    = data.symbol;
  const lastPrice = parseFloat(data.lastPrice);

  // indexPrice іноді відсутній у тіку Bybit → беремо з кешу
  let indexPrice = parseFloat(data.indexPrice);
  if (!isNaN(indexPrice) && indexPrice > 0) {
    state.lastIndexPrice.set(symbol, indexPrice);
  } else {
    indexPrice = state.lastIndexPrice.get(symbol) ?? NaN;
  }

  if (!symbol || isNaN(lastPrice) || isNaN(indexPrice)) return;

  const spread    = calcSpread(lastPrice, indexPrice);
  const absSpread = Math.abs(spread);
  const direction = lastPrice < indexPrice ? 'LONG' : 'SHORT';

  const hasSignal  = state.activeSignals.has(symbol);
  const lastSent   = state.lastSignalTime.get(symbol) || 0;
  const cooldownOk = (Date.now() - lastSent) >= CONFIG.SIGNAL_COOLDOWN_MS;

  // ── ENTRY ──────────────────────────────────────────────────────────────────
  if (!hasSignal && absSpread >= CONFIG.SPREAD_ENTRY_THRESHOLD && cooldownOk) {
    console.log(`[ENTRY] ${symbol} ${direction} spread=${spread.toFixed(3)}%`);

    state.activeSignals.set(symbol, { direction, entryTime: Date.now(), entrySpread: spread });
    state.lastSignalTime.set(symbol, Date.now());

    sendTelegram(formatEntry(symbol, direction, lastPrice, indexPrice, spread));
    return;
  }

  // ── EXIT ───────────────────────────────────────────────────────────────────
  if (hasSignal && absSpread <= CONFIG.SPREAD_EXIT_THRESHOLD) {
    const sig = state.activeSignals.get(symbol);
    console.log(`[EXIT]  ${symbol} ${sig.direction} spread=${spread.toFixed(3)}%`);

    state.activeSignals.delete(symbol);

    sendTelegram(formatExit(symbol, sig.direction, lastPrice, indexPrice, spread, sig.entrySpread));
  }
}

// ─── WEBSOCKET ─────────────────────────────────────────────────────────────────
function handleWebSocketMessage(message) {
  try {
    const data = JSON.parse(message);
    if (data.topic && data.topic.startsWith('tickers.') && data.data) {
      processTickerData(data.data);
    }
  } catch (err) {
    console.error('[WS] Parse error:', err.message);
  }
}

async function subscribeToSymbols(ws, symbols) {
  const batches = [];
  for (let i = 0; i < symbols.length; i += CONFIG.BATCH_SIZE) {
    batches.push(symbols.slice(i, i + CONFIG.BATCH_SIZE));
  }

  console.log(`[WS] Subscribing to ${symbols.length} symbols in ${batches.length} batches...`);

  for (let i = 0; i < batches.length; i++) {
    const topics = batches[i].map(s => `tickers.${s}`);
    ws.send(JSON.stringify({ op: 'subscribe', args: topics }));
    console.log(`[WS] Batch ${i + 1}/${batches.length}: ${batches[i].length} symbols`);
    if (i < batches.length - 1) {
      await new Promise(r => setTimeout(r, CONFIG.BATCH_DELAY_MS));
    }
  }
}

function createWebSocketConnection(symbols, connectionIndex) {
  return new Promise((resolve, reject) => {
    console.log(`[WS] Creating connection #${connectionIndex + 1}...`);

    const ws = new WebSocket(CONFIG.BYBIT_WS_URL);
    let isResolved = false;

    ws.on('open', async () => {
      console.log(`[WS] Connection #${connectionIndex + 1} opened`);
      try {
        await subscribeToSymbols(ws, symbols);
        if (!isResolved) { isResolved = true; resolve(ws); }
      } catch (err) {
        console.error(`[WS] Subscribe error on #${connectionIndex + 1}:`, err.message);
        if (!isResolved) { isResolved = true; reject(err); }
      }
    });

    ws.on('message', msg => handleWebSocketMessage(msg.toString()));
    ws.on('ping',    ()  => ws.pong());

    ws.on('error', err => {
      console.error(`[WS] Connection #${connectionIndex + 1} error:`, err.message);
    });

    ws.on('close', () => {
      console.log(`[WS] Connection #${connectionIndex + 1} closed. Reconnecting in ${CONFIG.RECONNECT_DELAY_MS}ms...`);
      const timer = setTimeout(async () => {
        try {
          const newWs = await createWebSocketConnection(symbols, connectionIndex);
          state.wsConnections[connectionIndex] = newWs;
        } catch (err) {
          console.error(`[RECONNECT] Failed #${connectionIndex + 1}:`, err.message);
        }
      }, CONFIG.RECONNECT_DELAY_MS);
      state.reconnectTimers.push(timer);
    });

    setTimeout(() => {
      if (!isResolved) { isResolved = true; reject(new Error('Connection timeout')); }
    }, 30_000);
  });
}

async function initializeWebSockets() {
  const symbols = state.symbols;
  const symbolsPerConnection = Math.ceil(symbols.length / CONFIG.MAX_WS_CONNECTIONS);
  const actualConnections = Math.min(
    CONFIG.MAX_WS_CONNECTIONS,
    Math.ceil(symbols.length / CONFIG.BATCH_SIZE)
  );

  console.log(`[WS] Creating ${actualConnections} connections (~${symbolsPerConnection} symbols each)...`);

  for (let i = 0; i < actualConnections; i++) {
    const start = i * symbolsPerConnection;
    const end   = Math.min((i + 1) * symbolsPerConnection, symbols.length);
    const ws    = await createWebSocketConnection(symbols.slice(start, end), i);
    state.wsConnections.push(ws);
    if (i < actualConnections - 1) await new Promise(r => setTimeout(r, 1_000));
  }

  console.log(`[WS] All ${actualConnections} connections established`);
}

// ─── SYMBOLS ───────────────────────────────────────────────────────────────────
async function fetchActiveSymbols() {
  console.log('[API] Fetching active symbols from Bybit...');
  const res = await axios.get(CONFIG.BYBIT_API_URL, {
    params: { category: 'linear', status: 'Trading' }
  });

  if (res.data.retCode !== 0) throw new Error(`API Error: ${res.data.retMsg}`);

  const symbols = res.data.result.list
    .filter(s => s.status === 'Trading' && s.quoteCoin === 'USDT')
    .map(s => s.symbol);

  console.log(`[API] Found ${symbols.length} active USDT perpetual symbols`);
  return symbols;
}

// ─── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('='.repeat(60));
  console.log('📊 BYBIT SPREAD MONITOR BOT');
  console.log('='.repeat(60));
  console.log(`[CONFIG] Entry Threshold : ${CONFIG.SPREAD_ENTRY_THRESHOLD}%`);
  console.log(`[CONFIG] Exit  Threshold : ${CONFIG.SPREAD_EXIT_THRESHOLD}%`);
  console.log(`[CONFIG] Signal Cooldown : ${CONFIG.SIGNAL_COOLDOWN_MS / 1000}s`);
  console.log(`[CONFIG] Max Connections : ${CONFIG.MAX_WS_CONNECTIONS}`);
  console.log(`[CONFIG] Batch Size      : ${CONFIG.BATCH_SIZE}`);
  console.log('='.repeat(60));

  state.symbols = await fetchActiveSymbols();
  await initializeWebSockets();

  console.log('[BOT] ✅ Bot started and monitoring spreads...');

  sendTelegram(
    `🤖 <b>BYBIT SPREAD MONITOR STARTED</b>\n\n` +
    `Monitoring: ${state.symbols.length} symbols\n` +
    `Entry Threshold: ${CONFIG.SPREAD_ENTRY_THRESHOLD}%\n` +
    `Exit Threshold:  ${CONFIG.SPREAD_EXIT_THRESHOLD}%\n` +
    `Signal Cooldown: ${CONFIG.SIGNAL_COOLDOWN_MS / 1000}s`
  );
}

// ─── GRACEFUL SHUTDOWN ─────────────────────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\n[SHUTDOWN] Shutting down gracefully...');

  state.wsConnections.forEach((ws, i) => {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.close();
      console.log(`[SHUTDOWN] Closed connection #${i + 1}`);
    }
  });
  state.reconnectTimers.forEach(t => clearTimeout(t));

  tg.sendMessage(CONFIG.TELEGRAM_CHAT_ID, '🛑 <b>BYBIT SPREAD MONITOR STOPPED</b>', { parse_mode: 'HTML' })
    .finally(() => process.exit(0));
});

process.on('SIGTERM', () => process.exit(0));

main().catch(err => {
  console.error('[FATAL]', err.message);
  process.exit(1);
});
