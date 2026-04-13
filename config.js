/**
 * Polymarket Arbitrage Bot - Configuration
 * 
 * All bot parameters are defined here for easy customization.
 * Modify values in this file to adjust bot behavior.
 */

export const config = {
  // ===== SERVER =====
  server: {
    port: process.env.PORT || 3000,
    environment: process.env.NODE_ENV || 'development',
  },

  // ===== BOT PARAMETERS =====
  bot: {
    // Starting capital in CAD
    startingBalance: parseFloat(process.env.STARTING_BALANCE) || 50,

    // How often to check for opportunities (milliseconds)
    checkIntervalMs: parseInt(process.env.CHECK_INTERVAL_MS) || 1000,

    // Position sizing
    maxPositionSizePercent: parseFloat(process.env.MAX_POSITION_SIZE_PERCENT) || 0.2, // 20%
    maxPositionSizeCAD: parseFloat(process.env.MAX_POSITION_SIZE_CAD) || 10, // $10 max

    // Risk management
    stopLossPercent: parseFloat(process.env.STOP_LOSS_PERCENT) || 20, // Auto-close at 20% loss

    // Opportunity detection
    minSpreadPercent: parseFloat(process.env.MIN_SPREAD_PERCENT) || 1.2, // 1.2% minimum spread
    minImbalanceRatio: 1.5, // Buy/sell pressure must be 1.5x different
  },

  // ===== POLYMARKET API =====
  polymarket: {
    // Public API endpoints (no auth required for read operations)
    clob: process.env.POLYMARKET_API_BASE || 'https://clob.polymarket.com',
    orderbook: process.env.POLYMARKET_ORDERBOOK_API || 'https://orderbook-api.polymarket.com',

    // API credentials (optional for demo, required for real trading)
    apiKey: process.env.POLYMARKET_API_KEY || '',
    apiSecret: process.env.POLYMARKET_API_SECRET || '',

    // Market selection
    maxMarketsToCheck: parseInt(process.env.MAX_MARKETS_TO_CHECK) || 50,
    topMarketsOnly: process.env.TOP_MARKETS_ONLY === 'true',

    // Request timeout
    requestTimeoutMs: 5000,
  },

  // ===== LOGGING =====
  logging: {
    level: process.env.LOG_LEVEL || 'info', // debug, info, warn, error
    logTrades: process.env.LOG_TRADES === 'true',
  },

  // ===== DASHBOARD =====
  dashboard: {
    updateIntervalMs: parseInt(process.env.DASHBOARD_UPDATE_INTERVAL) || 500,
    maxTradeHistory: parseInt(process.env.MAX_TRADE_HISTORY) || 100,
  },
};

/**
 * Helper function to get a config value safely
 * @param {string} path - Dot notation path (e.g., 'bot.startingBalance')
 * @param {*} defaultValue - Default if not found
 * @returns {*} Configuration value
 */
export function getConfig(path, defaultValue = undefined) {
  const keys = path.split('.');
  let value = config;

  for (const key of keys) {
    value = value?.[key];
    if (value === undefined) return defaultValue;
  }

  return value;
}

/**
 * Helper function to validate bot configuration
 * @returns {object} { valid: boolean, errors: string[] }
 */
export function validateConfig() {
  const errors = [];

  // Validate balance
  if (config.bot.startingBalance <= 0) {
    errors.push('Starting balance must be greater than 0');
  }

  // Validate position sizing
  if (config.bot.maxPositionSizePercent <= 0 || config.bot.maxPositionSizePercent > 1) {
    errors.push('Max position size percent must be between 0 and 1');
  }

  // Validate stop loss
  if (config.bot.stopLossPercent <= 0 || config.bot.stopLossPercent > 100) {
    errors.push('Stop loss percent must be between 0 and 100');
  }

  // Validate spread requirement
  if (config.bot.minSpreadPercent < 0) {
    errors.push('Min spread percent cannot be negative');
  }

  // Validate check interval
  if (config.bot.checkIntervalMs < 100) {
    errors.push('Check interval must be at least 100ms');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Get a human-readable configuration summary
 * @returns {string} Configuration summary
 */
export function getConfigSummary() {
  return `
╔════════════════════════════════════════════╗
║   Polymarket Arbitrage Bot Configuration   ║
╚════════════════════════════════════════════╝

📊 BOT PARAMETERS
  Starting Balance: $${config.bot.startingBalance} CAD
  Check Interval: ${config.bot.checkIntervalMs}ms
  Max Position: ${(config.bot.maxPositionSizePercent * 100).toFixed(0)}% ($${config.bot.maxPositionSizeCAD})
  Stop Loss: ${config.bot.stopLossPercent}%
  Min Spread: ${config.bot.minSpreadPercent}%

🌐 API ENDPOINTS
  CLOB: ${config.polymarket.clob}
  Orderbook: ${config.polymarket.orderbook}
  Markets to Monitor: ${config.polymarket.maxMarketsToCheck}

📈 DASHBOARD
  Update Interval: ${config.dashboard.updateIntervalMs}ms
  Trade History: ${config.dashboard.maxTradeHistory} trades

✅ Validation: ${validateConfig().valid ? 'PASSED' : 'FAILED'}
  `;
}

export default config;
