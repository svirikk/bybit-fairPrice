import WebSocket from 'ws';
import axios from 'axios';
import dotenv from 'dotenv';
import TelegramBot from 'node-telegram-bot-api';

dotenv.config();

// Конфігурація
const CONFIG = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  SPREAD_ENTRY_THRESHOLD: parseFloat(process.env.SPREAD_ENTRY_THRESHOLD || '0.7'),
  SPREAD_EXIT_THRESHOLD: parseFloat(process.env.SPREAD_EXIT_THRESHOLD || '0.5'),
  MAX_WS_CONNECTIONS: parseInt(process.env.MAX_WS_CONNECTIONS || '5'),
  BATCH_SIZE: parseInt(process.env.BATCH_SIZE || '10'),
  BATCH_DELAY_MS: parseInt(process.env.BATCH_DELAY_MS || '200'),
  BYBIT_WS_URL: 'wss://stream.bybit.com/v5/public/linear',
  BYBIT_API_URL: 'https://api.bybit.com/v5/market/instruments-info'
};

// Валідація обов'язкових змінних
if (!CONFIG.TELEGRAM_BOT_TOKEN || !CONFIG.TELEGRAM_CHAT_ID) {
  console.error('[ERROR] Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID in .env');
  process.exit(1);
}

// Ініціалізація Telegram бота
const telegramBot = new TelegramBot(CONFIG.TELEGRAM_BOT_TOKEN);

// Глобальний стан
const state = {
  symbols: [],
  activeSignals: new Map(), // symbol -> { direction, entryTime, lastPrice, indexPrice }
  prices: new Map(), // symbol -> { lastPrice, indexPrice }
  wsConnections: [],
  reconnectTimers: []
};

/**
 * Відправляє повідомлення в Telegram
 */
async function sendTelegramMessage(message) {
  try {
    await telegramBot.sendMessage(CONFIG.TELEGRAM_CHAT_ID, message);
    console.log('[TELEGRAM] Message sent successfully');
  } catch (error) {
    console.error('[TELEGRAM] Error sending message:', error.message);
  }
}

/**
 * Отримує список активних USDT perpetual символів
 */
async function fetchActiveSymbols() {
  try {
    console.log('[SPREAD] Fetching active symbols from Bybit...');
    
    const response = await axios.get(CONFIG.BYBIT_API_URL, {
      params: {
        category: 'linear',
        status: 'Trading'
      }
    });

    if (response.data.retCode !== 0) {
      throw new Error(`API Error: ${response.data.retMsg}`);
    }

    const symbols = response.data.result.list
      .filter(instrument => 
        instrument.status === 'Trading' && 
        instrument.quoteCoin === 'USDT'
      )
      .map(instrument => instrument.symbol);

    console.log(`[SPREAD] Found ${symbols.length} active USDT perpetual symbols`);
    return symbols;
  } catch (error) {
    console.error('[SPREAD] Error fetching symbols:', error.message);
    throw error;
  }
}

/**
 * Розраховує спред між lastPrice та indexPrice
 */
function calculateSpread(lastPrice, indexPrice) {
  if (!lastPrice || !indexPrice || indexPrice === 0) return 0;
  return ((lastPrice - indexPrice) / indexPrice) * 100;
}

/**
 * Визначає напрямок на основі спреду
 */
function getDirection(lastPrice, indexPrice) {
  return lastPrice < indexPrice ? 'LONG' : 'SHORT';
}

/**
 * Форматує ENTRY повідомлення
 */
function formatEntryMessage(symbol, direction, lastPrice, indexPrice, spread) {
  return `📊 SPREAD SIGNAL
SYMBOL: ${symbol}
DIRECTION: ${direction}
LAST_PRICE: ${lastPrice.toFixed(2)}
INDEX_PRICE: ${indexPrice.toFixed(2)}
SPREAD: ${spread.toFixed(2)}%
TIME: ${new Date().toISOString()}`;
}

/**
 * Форматує EXIT повідомлення
 */
function formatExitMessage(symbol, direction, lastPrice, indexPrice, spread) {
  return `✅ SPREAD CLOSED
SYMBOL: ${symbol}
DIRECTION: ${direction}
LAST_PRICE: ${lastPrice.toFixed(2)}
INDEX_PRICE: ${indexPrice.toFixed(2)}
SPREAD: ${spread.toFixed(2)}%
TIME: ${new Date().toISOString()}`;
}

/**
 * Обробляє тікер-дані з WebSocket
 */
async function processTickerData(data) {
  try {
    const symbol = data.symbol;
    const lastPrice = parseFloat(data.lastPrice);
    const indexPrice = parseFloat(data.indexPrice);

    if (!lastPrice || !indexPrice) return;

    // Оновлюємо кеш цін
    state.prices.set(symbol, { lastPrice, indexPrice });

    // Розраховуємо спред
    const spread = calculateSpread(lastPrice, indexPrice);
    const absSpread = Math.abs(spread);
    const direction = getDirection(lastPrice, indexPrice);

    const hasActiveSignal = state.activeSignals.has(symbol);

    // Логіка ENTRY сигналу
    if (!hasActiveSignal && absSpread >= CONFIG.SPREAD_ENTRY_THRESHOLD) {
      console.log(`[SPREAD] ENTRY signal for ${symbol}: ${direction}, spread: ${spread.toFixed(2)}%`);
      
      // Зберігаємо активний сигнал
      state.activeSignals.set(symbol, {
        direction,
        entryTime: new Date().toISOString(),
        lastPrice,
        indexPrice,
        spread
      });

      // Відправляємо ENTRY повідомлення
      const message = formatEntryMessage(symbol, direction, lastPrice, indexPrice, spread);
      await sendTelegramMessage(message);
    }
    // Логіка EXIT сигналу
    else if (hasActiveSignal && absSpread <= CONFIG.SPREAD_EXIT_THRESHOLD) {
      const activeSignal = state.activeSignals.get(symbol);
      console.log(`[SPREAD] EXIT signal for ${symbol}: ${direction}, spread: ${spread.toFixed(2)}%`);
      
      // Видаляємо активний сигнал
      state.activeSignals.delete(symbol);

      // Відправляємо EXIT повідомлення
      const message = formatExitMessage(symbol, activeSignal.direction, lastPrice, indexPrice, spread);
      await sendTelegramMessage(message);
    }
  } catch (error) {
    console.error('[SPREAD] Error processing ticker data:', error.message);
  }
}

/**
 * Обробляє повідомлення з WebSocket
 */
function handleWebSocketMessage(message) {
  try {
    const data = JSON.parse(message);
    
    // Обробляємо тільки ticker updates
    if (data.topic && data.topic.startsWith('tickers.') && data.data) {
      processTickerData(data.data);
    }
  } catch (error) {
    console.error('[WS] Error parsing message:', error.message);
  }
}

/**
 * Підписується на символи батчами
 */
async function subscribeToSymbols(ws, symbols) {
  const batches = [];
  for (let i = 0; i < symbols.length; i += CONFIG.BATCH_SIZE) {
    batches.push(symbols.slice(i, i + CONFIG.BATCH_SIZE));
  }

  console.log(`[WS] Subscribing to ${symbols.length} symbols in ${batches.length} batches...`);

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const topics = batch.map(symbol => `tickers.${symbol}`);
    
    const subscribeMessage = {
      op: 'subscribe',
      args: topics
    };

    ws.send(JSON.stringify(subscribeMessage));
    console.log(`[WS] Batch ${i + 1}/${batches.length}: Subscribed to ${batch.length} symbols`);

    // Затримка між батчами
    if (i < batches.length - 1) {
      await new Promise(resolve => setTimeout(resolve, CONFIG.BATCH_DELAY_MS));
    }
  }
}

/**
 * Створює WebSocket з'єднання
 */
function createWebSocketConnection(symbols, connectionIndex) {
  return new Promise((resolve, reject) => {
    console.log(`[WS] Creating connection #${connectionIndex + 1}...`);
    
    const ws = new WebSocket(CONFIG.BYBIT_WS_URL);
    let isResolved = false;

    ws.on('open', async () => {
      console.log(`[WS] Connection #${connectionIndex + 1} opened`);
      
      try {
        await subscribeToSymbols(ws, symbols);
        if (!isResolved) {
          isResolved = true;
          resolve(ws);
        }
      } catch (error) {
        console.error(`[WS] Error subscribing on connection #${connectionIndex + 1}:`, error.message);
        if (!isResolved) {
          isResolved = true;
          reject(error);
        }
      }
    });

    ws.on('message', (message) => {
      handleWebSocketMessage(message.toString());
    });

    ws.on('error', (error) => {
      console.error(`[WS] Connection #${connectionIndex + 1} error:`, error.message);
    });

    ws.on('close', () => {
      console.log(`[WS] Connection #${connectionIndex + 1} closed`);
      
      // Автоматичний reconnect
      const reconnectDelay = 5000; // 5 секунд
      console.log(`[RECONNECT] Reconnecting connection #${connectionIndex + 1} in ${reconnectDelay}ms...`);
      
      const timer = setTimeout(async () => {
        try {
          const newWs = await createWebSocketConnection(symbols, connectionIndex);
          state.wsConnections[connectionIndex] = newWs;
        } catch (error) {
          console.error(`[RECONNECT] Failed to reconnect connection #${connectionIndex + 1}:`, error.message);
        }
      }, reconnectDelay);
      
      state.reconnectTimers.push(timer);
    });

    ws.on('ping', () => {
      ws.pong();
    });

    // Timeout для з'єднання
    setTimeout(() => {
      if (!isResolved) {
        isResolved = true;
        reject(new Error('Connection timeout'));
      }
    }, 30000); // 30 секунд
  });
}

/**
 * Ініціалізує WebSocket з'єднання
 */
async function initializeWebSockets() {
  try {
    const symbols = state.symbols;
    const symbolsPerConnection = Math.ceil(symbols.length / CONFIG.MAX_WS_CONNECTIONS);
    const actualConnections = Math.min(
      CONFIG.MAX_WS_CONNECTIONS,
      Math.ceil(symbols.length / CONFIG.BATCH_SIZE)
    );

    console.log(`[WS] Creating ${actualConnections} WebSocket connections...`);
    console.log(`[WS] Symbols per connection: ~${symbolsPerConnection}`);

    for (let i = 0; i < actualConnections; i++) {
      const start = i * symbolsPerConnection;
      const end = Math.min((i + 1) * symbolsPerConnection, symbols.length);
      const connectionSymbols = symbols.slice(start, end);

      const ws = await createWebSocketConnection(connectionSymbols, i);
      state.wsConnections.push(ws);

      // Невелика затримка між створенням з'єднань
      if (i < actualConnections - 1) {
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }

    console.log(`[WS] All ${actualConnections} WebSocket connections established`);
  } catch (error) {
    console.error('[WS] Error initializing WebSocket connections:', error.message);
    throw error;
  }
}

/**
 * Головна функція
 */
async function main() {
  try {
    console.log('='.repeat(60));
    console.log('📊 BYBIT SPREAD MONITOR BOT');
    console.log('='.repeat(60));
    console.log(`[CONFIG] Entry Threshold: ${CONFIG.SPREAD_ENTRY_THRESHOLD}%`);
    console.log(`[CONFIG] Exit Threshold: ${CONFIG.SPREAD_EXIT_THRESHOLD}%`);
    console.log(`[CONFIG] Max Connections: ${CONFIG.MAX_WS_CONNECTIONS}`);
    console.log(`[CONFIG] Batch Size: ${CONFIG.BATCH_SIZE}`);
    console.log('='.repeat(60));

    // Отримуємо список символів
    state.symbols = await fetchActiveSymbols();

    // Ініціалізуємо WebSocket з'єднання
    await initializeWebSockets();

    console.log('[SPREAD] ✅ Bot started and monitoring spreads...');
    
    // Відправляємо повідомлення про запуск
    await sendTelegramMessage(
      `🤖 SPREAD MONITOR BOT STARTED\n\n` +
      `Monitoring: ${state.symbols.length} symbols\n` +
      `Entry Threshold: ${CONFIG.SPREAD_ENTRY_THRESHOLD}%\n` +
      `Exit Threshold: ${CONFIG.SPREAD_EXIT_THRESHOLD}%`
    );

  } catch (error) {
    console.error('[ERROR] Fatal error:', error.message);
    process.exit(1);
  }
}

// Обробка завершення
process.on('SIGINT', async () => {
  console.log('\n[SHUTDOWN] Shutting down gracefully...');
  
  // Закриваємо всі WebSocket з'єднання
  state.wsConnections.forEach((ws, index) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
      console.log(`[SHUTDOWN] Closed connection #${index + 1}`);
    }
  });

  // Очищаємо таймери reconnect
  state.reconnectTimers.forEach(timer => clearTimeout(timer));

  await sendTelegramMessage('🛑 SPREAD MONITOR BOT STOPPED');
  
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n[SHUTDOWN] Received SIGTERM');
  process.exit(0);
});

// Запуск
main().catch(error => {
  console.error('[FATAL] Failed to start bot:', error.message);
  process.exit(1);
});
