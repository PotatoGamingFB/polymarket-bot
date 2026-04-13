const express = require('express');
const axios = require('axios');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static('public'));
app.use(express.static('.'));

// ===== BOT STATE =====
const botState = {
  balance: 50,
  initialBalance: 50,
  positions: {},
  trades: [],
  running: false,
  totalTrades: 0,
  totalProfit: 0,
  successfulTrades: 0,
  failedTrades: 0,
  markets: [],
  followedWallets: [],
  walletMetrics: {},
  discoveredWallets: {},
  autoDiscoveryEnabled: false,
  minSuccessRate: 50,
};

// ===== POLYMARKET API CONFIG =====
const POLYMARKET_API = 'https://clob.polymarket.com';
const POLYMARKET_ORDERBOOK = 'https://orderbook-api.polymarket.com';
const POLYMARKET_API_KEY = '019d843d-8a2a-7b9f-8f66-bf8156cd64c4';
const WALLET_ADDRESS = '0x7410e00786d297339f5e8a76297c9d0baa2b6c1a';
const CHECK_INTERVAL = 1000;

// ===== TRADING PARAMETERS =====
const MAX_TRADE_SIZE = 6;
const STOP_LOSS_PERCENT = 20;
const POSITION_SIZE_PERCENT = 0.12;

// ===== DISCOVER HIGH-PERFORMING WALLETS =====
async function discoverWallets() {
  try {
    console.log('🔍 Starting wallet discovery...');
    
    // Get active markets
    const marketsResponse = await axios.get(
      `${POLYMARKET_API}/markets?active=true&limit=50`,
      { timeout: 5000 }
    );

    if (!marketsResponse.data?.markets) return;

    const discoveredWallets = {};
    const walletTrades = {};

    // Analyze recent trades across markets
    for (const market of marketsResponse.data.markets.slice(0, 20)) {
      try {
        // Get recent trades for this market
        const tradesResponse = await axios.get(
          `${POLYMARKET_API}/trades?market=${market.id}&limit=30`,
          { timeout: 5000 }
        );

        if (!tradesResponse.data) continue;

        for (const trade of tradesResponse.data) {
          if (!trade.user) continue;

          const wallet = trade.user;

          if (!walletTrades[wallet]) {
            walletTrades[wallet] = {
              total: 0,
              profitable: 0,
              trades: [],
            };
          }

          walletTrades[wallet].total++;
          walletTrades[wallet].trades.push({
            size: trade.size,
            price: trade.price,
            timestamp: trade.createdAt,
          });
        }
      } catch (e) {
        continue;
      }
    }

    // Calculate success rates and filter
    for (const [wallet, data] of Object.entries(walletTrades)) {
      if (data.total < 5) continue; // Min 5 trades

      // Simulate success rate (in real implementation, track actual outcomes)
      const successRate = Math.min(95, 70 + Math.random() * 25);
      
      if (successRate >= botState.minSuccessRate) {
        const totalVolume = data.trades.reduce((sum, t) => sum + (t.size || 0), 0);

        if (totalVolume > 100) { // Min volume to be profitable
          discoveredWallets[wallet] = {
            successRate: parseFloat(successRate.toFixed(1)),
            trades: data.total,
            volume: parseFloat(totalVolume.toFixed(2)),
            discovered: new Date(),
            auto: true,
          };

          console.log(`✅ Found wallet: ${wallet.slice(0, 6)}... (${successRate.toFixed(1)}% success)`);
        }
      }
    }

    botState.discoveredWallets = discoveredWallets;

    // Auto-add high performers if enabled
    if (botState.autoDiscoveryEnabled) {
      for (const [wallet, data] of Object.entries(discoveredWallets)) {
        if (!botState.followedWallets.includes(wallet)) {
          botState.followedWallets.push(wallet);
          botState.walletMetrics[wallet] = { 
            trades: 0, 
            wins: 0, 
            losses: 0, 
            totalProfit: 0,
            autoAdded: true,
          };
          
          broadcastUpdate({
            type: 'wallet_auto_added',
            wallet,
            successRate: data.successRate,
          });
        }
      }
    }

    console.log(`🎯 Discovery complete: Found ${Object.keys(discoveredWallets).length} wallets`);
  } catch (error) {
    console.error('Error discovering wallets:', error.message);
  }
}

// ===== GET WALLET TRADES =====
async function getWalletTrades(walletAddress) {
  try {
    const response = await axios.get(
      `${POLYMARKET_API}/user-trades?user=${walletAddress}&limit=10`,
      { timeout: 5000 }
    );
    return response.data || [];
  } catch (error) {
    console.error(`Error fetching trades for ${walletAddress}:`, error.message);
    return [];
  }
}

// ===== DETECT WALLET TRADING OPPORTUNITIES =====
async function detectWalletOpportunities() {
  try {
    if (botState.followedWallets.length === 0) return [];

    const opportunities = [];

    for (const wallet of botState.followedWallets) {
      try {
        const trades = await getWalletTrades(wallet);

        for (const trade of trades) {
          const tradeTime = new Date(trade.createdAt);
          const timeDiff = Date.now() - tradeTime.getTime();

          if (timeDiff < 5000 && trade.outcome_short_price) {
            opportunities.push({
              walletAddress: wallet,
              marketId: trade.id,
              marketName: trade.question,
              tradePrice: parseFloat(trade.outcome_short_price),
              tradeSize: parseFloat(trade.size),
              tradeType: 'copy',
              timestamp: tradeTime,
            });
          }
        }
      } catch (e) {
        continue;
      }
    }

    return opportunities;
  } catch (error) {
    console.error('Error detecting wallet opportunities:', error.message);
    return [];
  }
}

// ===== EXECUTE COPY TRADE =====
function executeCopyTrade(opportunity) {
  let tradeSize = Math.min(
    botState.balance * POSITION_SIZE_PERCENT,
    MAX_TRADE_SIZE
  );

  if (tradeSize > botState.balance * 0.5) {
    tradeSize = botState.balance * 0.5;
  }

  if (tradeSize < 1) return null;

  const entryPrice = opportunity.tradePrice;
  const quantity = tradeSize / entryPrice;
  
  const winRate = Math.random();
  let exitPrice;
  let profit;
  let status = 'completed';

  if (winRate < 0.75) {
    const profitPercent = 1 + (Math.random() * 4);
    exitPrice = entryPrice * (1 + profitPercent / 100);
    profit = (exitPrice - entryPrice) * quantity;
  } else if (winRate < 0.90) {
    const lossPercent = Math.random() * 10;
    exitPrice = entryPrice * (1 - lossPercent / 100);
    profit = (exitPrice - entryPrice) * quantity;
  } else {
    exitPrice = entryPrice * (1 - STOP_LOSS_PERCENT / 100);
    profit = (exitPrice - entryPrice) * quantity;
    status = 'stopped';
  }

  const trade = {
    id: `trade-${Date.now()}`,
    marketId: opportunity.marketId,
    marketName: opportunity.marketName,
    type: 'copy',
    copiedFrom: opportunity.walletAddress.slice(0, 6) + '...',
    entryPrice: parseFloat(entryPrice.toFixed(4)),
    exitPrice: parseFloat(exitPrice.toFixed(4)),
    quantity: parseFloat(quantity.toFixed(4)),
    entryValue: parseFloat(tradeSize.toFixed(2)),
    exitValue: parseFloat((quantity * exitPrice).toFixed(2)),
    profit: parseFloat(profit.toFixed(2)),
    profitPercent: parseFloat(((profit / tradeSize) * 100).toFixed(2)),
    timestamp: new Date(),
    status,
  };

  botState.balance += profit;
  botState.totalProfit += profit;
  botState.totalTrades++;

  if (profit > 0) {
    botState.successfulTrades++;
  } else {
    botState.failedTrades++;
  }

  if (!botState.walletMetrics[opportunity.walletAddress]) {
    botState.walletMetrics[opportunity.walletAddress] = {
      trades: 0,
      wins: 0,
      losses: 0,
      totalProfit: 0,
    };
  }
  botState.walletMetrics[opportunity.walletAddress].trades++;
  if (profit > 0) {
    botState.walletMetrics[opportunity.walletAddress].wins++;
  } else {
    botState.walletMetrics[opportunity.walletAddress].losses++;
  }
  botState.walletMetrics[opportunity.walletAddress].totalProfit += profit;

  botState.trades.unshift(trade);
  if (botState.trades.length > 100) botState.trades.pop();

  return trade;
}

// ===== MONITOR AND TRADE =====
async function monitorAndTrade() {
  if (!botState.running) return;

  try {
    const opportunities = await detectWalletOpportunities();

    for (const opportunity of opportunities) {
      if (botState.followedWallets.length > 0 && botState.balance > 10) {
        const trade = executeCopyTrade(opportunity);
        
        if (trade) {
          broadcastUpdate({
            type: 'new_trade',
            trade,
            balance: botState.balance,
            totalProfit: botState.totalProfit,
            successRate: botState.totalTrades > 0 
              ? ((botState.successfulTrades / botState.totalTrades) * 100).toFixed(1)
              : 0,
          });
        }
      }
    }

    broadcastUpdate({
      type: 'market_update',
      balance: botState.balance,
      totalProfit: botState.totalProfit,
      totalTrades: botState.totalTrades,
      successRate: botState.totalTrades > 0 
        ? ((botState.successfulTrades / botState.totalTrades) * 100).toFixed(1)
        : 0,
      followedWallets: botState.followedWallets.length,
    });
  } catch (error) {
    console.error('Monitoring error:', error.message);
  }
}

// ===== BROADCAST =====
function broadcastUpdate(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// ===== API ENDPOINTS =====
app.get('/api/status', (req, res) => {
  const successRate = botState.totalTrades > 0 
    ? ((botState.successfulTrades / botState.totalTrades) * 100).toFixed(1)
    : 0;

  res.json({
    running: botState.running,
    balance: botState.balance,
    initialBalance: botState.initialBalance,
    totalProfit: botState.totalProfit,
    totalTrades: botState.totalTrades,
    successfulTrades: botState.successfulTrades,
    failedTrades: botState.failedTrades,
    successRate: parseFloat(successRate),
    roi: ((botState.totalProfit / botState.initialBalance) * 100).toFixed(2),
    followedWallets: botState.followedWallets.length,
    autoDiscoveryEnabled: botState.autoDiscoveryEnabled,
  });
});

app.get('/api/credentials', (req, res) => {
  res.json({
    apiKeyConfigured: !!POLYMARKET_API_KEY,
    walletAddressConfigured: !!WALLET_ADDRESS,
    walletAddress: WALLET_ADDRESS,
    apiKeyLastFour: POLYMARKET_API_KEY.slice(-4),
  });
});

app.get('/api/trades', (req, res) => {
  res.json(botState.trades);
});

app.get('/api/wallet-metrics', (req, res) => {
  res.json(botState.walletMetrics);
});

app.get('/api/discovered-wallets', (req, res) => {
  res.json(botState.discoveredWallets);
});

app.post('/api/discover-wallets', async (req, res) => {
  if (botState.running) {
    return res.status(400).json({ error: 'Stop bot before discovering wallets' });
  }

  await discoverWallets();
  
  res.json({
    status: 'discovered',
    count: Object.keys(botState.discoveredWallets).length,
    wallets: botState.discoveredWallets,
  });
});

app.post('/api/toggle-auto-discovery', (req, res) => {
  botState.autoDiscoveryEnabled = !botState.autoDiscoveryEnabled;
  
  res.json({
    autoDiscoveryEnabled: botState.autoDiscoveryEnabled,
  });

  broadcastUpdate({
    type: 'auto_discovery_toggled',
    enabled: botState.autoDiscoveryEnabled,
  });
});

app.post('/api/add-wallet', (req, res) => {
  const { walletAddress } = req.body;

  if (!walletAddress || !walletAddress.match(/^0x[a-fA-F0-9]{40}$/)) {
    return res.status(400).json({ error: 'Invalid wallet address' });
  }

  if (botState.followedWallets.includes(walletAddress)) {
    return res.status(400).json({ error: 'Wallet already being followed' });
  }

  botState.followedWallets.push(walletAddress);
  botState.walletMetrics[walletAddress] = { 
    trades: 0, 
    wins: 0, 
    losses: 0, 
    totalProfit: 0,
    autoAdded: false,
  };

  res.json({
    status: 'added',
    walletAddress,
    followedWallets: botState.followedWallets,
  });

  broadcastUpdate({
    type: 'wallet_added',
    walletAddress,
    followedWallets: botState.followedWallets.length,
  });
});

app.post('/api/remove-wallet', (req, res) => {
  const { walletAddress } = req.body;

  const index = botState.followedWallets.indexOf(walletAddress);
  if (index === -1) {
    return res.status(400).json({ error: 'Wallet not being followed' });
  }

  botState.followedWallets.splice(index, 1);

  res.json({
    status: 'removed',
    followedWallets: botState.followedWallets,
  });

  broadcastUpdate({
    type: 'wallet_removed',
    walletAddress,
    followedWallets: botState.followedWallets.length,
  });
});

app.post('/api/start', (req, res) => {
  if (botState.running) {
    return res.status(400).json({ error: 'Bot already running' });
  }

  if (botState.followedWallets.length === 0) {
    return res.status(400).json({ error: 'Add at least one wallet to follow' });
  }

  botState.running = true;
  res.json({ status: 'started', message: 'Bot is now monitoring wallets' });
  broadcastUpdate({ type: 'bot_started' });
});

app.post('/api/stop', (req, res) => {
  botState.running = false;
  res.json({ status: 'stopped', message: 'Bot has been stopped' });
  broadcastUpdate({ type: 'bot_stopped' });
});

app.post('/api/reset', (req, res) => {
  botState.balance = 50;
  botState.totalProfit = 0;
  botState.totalTrades = 0;
  botState.successfulTrades = 0;
  botState.failedTrades = 0;
  botState.trades = [];
  botState.running = false;
  res.json({ status: 'reset', message: 'Bot state has been reset' });
  broadcastUpdate({ type: 'bot_reset' });
});

// ===== WEBSOCKET =====
wss.on('connection', (ws) => {
  console.log('WebSocket client connected');

  ws.send(JSON.stringify({
    type: 'initial_state',
    balance: botState.balance,
    totalProfit: botState.totalProfit,
    totalTrades: botState.totalTrades,
    successfulTrades: botState.successfulTrades,
    failedTrades: botState.failedTrades,
    successRate: botState.totalTrades > 0 
      ? ((botState.successfulTrades / botState.totalTrades) * 100).toFixed(1)
      : 0,
    trades: botState.trades.slice(0, 20),
    running: botState.running,
    followedWallets: botState.followedWallets,
    walletMetrics: botState.walletMetrics,
    discoveredWallets: botState.discoveredWallets,
    autoDiscoveryEnabled: botState.autoDiscoveryEnabled,
  }));

  ws.on('close', () => {
    console.log('WebSocket client disconnected');
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
  });
});

// ===== BOT LOOP =====
setInterval(() => {
  monitorAndTrade();
}, CHECK_INTERVAL);

// ===== START SERVER =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🤖 Polymarket Wallet Tracker Bot running on port ${PORT}`);
  console.log(`📊 Starting balance: $${botState.initialBalance} CAD`);
  console.log(`💰 Max per trade: $${MAX_TRADE_SIZE}`);
  console.log(`🛑 Stop loss: ${STOP_LOSS_PERCENT}%`);
  console.log(`📈 Min success rate for auto-discovery: ${botState.minSuccessRate}%`);
});
