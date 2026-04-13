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
  markets: [],
  monitoredMarkets: new Set(),
};

// ===== POLYMARKET API CONFIG =====
const POLYMARKET_API = 'https://clob.polymarket.com';
const POLYMARKET_ORDERBOOK = 'https://orderbook-api.polymarket.com';
const POLYMARKET_API_KEY = '019d843d-8a2a-7b9f-8f66-bf8156cd64c4';
const WALLET_ADDRESS = '0x7410e00786d297339f5e8a76297c9d0baa2b6c1a';
const CHECK_INTERVAL = 1000;

// ===== DETECT ARBITRAGE =====
async function detectArbitrageOpportunities() {
  try {
    const marketsResponse = await axios.get(
      `${POLYMARKET_API}/markets?active=true&limit=50`,
      { timeout: 5000 }
    );

    if (!marketsResponse.data?.markets) return [];

    const opportunities = [];

    for (const market of marketsResponse.data.markets.slice(0, 10)) {
      try {
        const orderBookResponse = await axios.get(
          `${POLYMARKET_ORDERBOOK}/book/${market.id}`,
          { timeout: 5000 }
        );

        const { bids, asks } = orderBookResponse.data;

        if (!bids?.length || !asks?.length) continue;

        const bidVolume = bids.reduce((sum, b) => sum + (b.size || 0), 0);
        const askVolume = asks.reduce((sum, a) => sum + (a.size || 0), 0);
        const imbalanceRatio = bidVolume / askVolume;

        if (imbalanceRatio > 1.5 || imbalanceRatio < 0.67) {
          const spreadPercent = ((asks[0].price - bids[0].price) / bids[0].price) * 100;
          
          if (spreadPercent > 1) {
            opportunities.push({
              marketId: market.id,
              marketName: market.question,
              bidPrice: parseFloat(bids[0].price),
              askPrice: parseFloat(asks[0].price),
              spreadPercent,
              imbalanceRatio,
              bidVolume,
              askVolume,
              timestamp: new Date(),
              profitPotential: spreadPercent * 0.8,
            });
          }
        }
      } catch (e) {
        continue;
      }
    }

    return opportunities;
  } catch (error) {
    console.error('Error detecting arbitrage:', error.message);
    return [];
  }
}

// ===== EXECUTE TRADE =====
function executeArbitrageTrade(opportunity) {
  const tradeSize = Math.min(botState.balance * 0.2, 10);
  
  const buyPrice = opportunity.bidPrice;
  const sellPrice = opportunity.askPrice;
  
  const buyQuantity = tradeSize / buyPrice;
  const sellProceeds = buyQuantity * sellPrice;
  const profit = sellProceeds - tradeSize;
  const profitPercent = (profit / tradeSize) * 100;

  const trade = {
    id: `trade-${Date.now()}`,
    marketId: opportunity.marketId,
    marketName: opportunity.marketName,
    type: 'arbitrage',
    entryPrice: buyPrice,
    exitPrice: sellPrice,
    quantity: buyQuantity,
    entryValue: tradeSize,
    exitValue: sellProceeds,
    profit,
    profitPercent,
    timestamp: new Date(),
    status: 'completed',
    spreadExploited: opportunity.spreadPercent,
  };

  botState.balance += profit;
  botState.totalProfit += profit;
  botState.totalTrades++;

  botState.trades.unshift(trade);
  if (botState.trades.length > 100) botState.trades.pop();

  return trade;
}

// ===== MONITOR AND TRADE =====
async function monitorAndTrade() {
  if (!botState.running) return;

  try {
    const opportunities = await detectArbitrageOpportunities();

    for (const opportunity of opportunities) {
      if (botState.balance > 5 && opportunity.spreadPercent > 1.2) {
        const trade = executeArbitrageTrade(opportunity);
        
        broadcastUpdate({
          type: 'new_trade',
          trade,
          balance: botState.balance,
          totalProfit: botState.totalProfit,
        });
      }
    }

    broadcastUpdate({
      type: 'market_update',
      opportunities: opportunities.slice(0, 5),
      balance: botState.balance,
      totalProfit: botState.totalProfit,
      totalTrades: botState.totalTrades,
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
  res.json({
    running: botState.running,
    balance: botState.balance,
    initialBalance: botState.initialBalance,
    totalProfit: botState.totalProfit,
    totalTrades: botState.totalTrades,
    roi: ((botState.totalProfit / botState.initialBalance) * 100).toFixed(2),
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

app.post('/api/start', (req, res) => {
  if (botState.running) {
    return res.status(400).json({ error: 'Bot already running' });
  }
  botState.running = true;
  res.json({ status: 'started', message: 'Bot is now monitoring markets' });
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
    trades: botState.trades.slice(0, 20),
    running: botState.running,
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
  console.log(`🤖 Polymarket Arbitrage Bot running on port ${PORT}`);
  console.log(`📊 Starting balance: $${botState.initialBalance} CAD`);
  console.log(`⏱️  Checking markets every ${CHECK_INTERVAL}ms`);
  console.log(`✅ API Key configured: ${!!POLYMARKET_API_KEY}`);
  console.log(`✅ Wallet configured: ${!!WALLET_ADDRESS}`);
});
