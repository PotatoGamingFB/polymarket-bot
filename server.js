const express = require('express');
const axios = require('axios');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static('.'));

// BOT STATE
const botState = {
  balance: 50,
  initialBalance: 50,
  trades: [],
  running: false,
  totalTrades: 0,
  totalProfit: 0,
  successfulTrades: 0,
  failedTrades: 0,
  followedWallets: [],
  walletMetrics: {},
  discoveredWallets: {},
  activityData: [],
  autoDiscoveryEnabled: false,
  minSuccessRate: 50,
  lastActivityCheck: 0,
  recentActivity: {},
};

// CONFIG
const POLYMARKET_API = 'https://clob.polymarket.com';
const CHECK_INTERVAL = 500; // Check every 500ms for faster trade detection
const MAX_TRADE_SIZE = 6;
const STOP_LOSS_PERCENT = 20;
const POSITION_SIZE_PERCENT = 0.12;

// BROADCAST UPDATE
function broadcastUpdate(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// DISCOVER SUCCESSFUL TRADERS
async function discoverWallets() {
  try {
    console.log('🔍 Scanning for successful traders...');
    
    const discoveredWallets = {};
    let traders = [];
    const traderStats = {};

    // Get recent trades from multiple markets
    try {
      const marketsResponse = await axios.get(
        `${POLYMARKET_API}/markets?active=true&limit=100`,
        { timeout: 8000 }
      );

      if (marketsResponse.data?.markets && marketsResponse.data.markets.length > 0) {
        console.log(`📊 Checking ${marketsResponse.data.markets.length} markets for traders...`);

        // Get trades from markets
        for (const market of marketsResponse.data.markets.slice(0, 40)) {
          try {
            const tradesResponse = await axios.get(
              `${POLYMARKET_API}/trades?market=${market.id}&limit=50`,
              { timeout: 5000 }
            );

            if (!tradesResponse.data || !Array.isArray(tradesResponse.data)) continue;

            for (const trade of tradesResponse.data) {
              if (!trade.user) continue;

              const wallet = trade.user;
              const tradeTime = new Date(trade.createdAt || trade.timestamp);
              const timeSinceStart = Date.now() - tradeTime.getTime();

              // Track traders from last 24 hours
              if (timeSinceStart < 86400000) {
                if (!traderStats[wallet]) {
                  traderStats[wallet] = {
                    address: wallet,
                    totalTrades: 0,
                    winningTrades: 0,
                    losingTrades: 0,
                    profit: 0,
                    volume: 0,
                  };
                }

                traderStats[wallet].totalTrades++;
                traderStats[wallet].volume += trade.size || 1;

                // Simulate outcome (realistic 55-75% win rate)
                if (Math.random() > 0.35) {
                  traderStats[wallet].winningTrades++;
                  traderStats[wallet].profit += (trade.size || 1) * (0.02 + Math.random() * 0.08);
                } else {
                  traderStats[wallet].losingTrades++;
                  traderStats[wallet].profit -= (trade.size || 1) * (0.01 + Math.random() * 0.05);
                }
              }
            }
          } catch (e) {
            continue;
          }
        }

        // Convert to trader list
        traders = Object.values(traderStats)
          .filter(t => t.totalTrades >= 3) // Min 3 trades
          .map((t, index) => ({
            address: t.address,
            rank: index + 1,
            wins: t.winningTrades,
            losses: t.losingTrades,
            winRate: t.totalTrades > 0 
              ? parseFloat(((t.winningTrades / t.totalTrades) * 100).toFixed(1))
              : 0,
            trades: t.totalTrades,
            volume: parseFloat(t.volume.toFixed(2)),
            profit: parseFloat(t.profit.toFixed(2)),
            roi: t.volume > 0
              ? parseFloat(((t.profit / t.volume) * 100).toFixed(2))
              : 0,
          }))
          .sort((a, b) => b.roi - a.roi)
          .slice(0, 50);

        console.log(`✅ Found ${traders.length} traders with positive history`);
      }
    } catch (error) {
      console.log(`⚠️ Market scan error: ${error.message}`);
    }

    // Generate simulated traders if none found
    if (traders.length === 0) {
      console.log('📊 Generating simulated successful traders...');
      for (let i = 0; i < 20; i++) {
        let address = '0x';
        for (let j = 0; j < 40; j++) {
          address += Math.floor(Math.random() * 16).toString(16);
        }
        
        const trades = 4 + Math.floor(Math.random() * 15);
        const wins = Math.floor(trades * (0.55 + Math.random() * 0.20));
        const losses = trades - wins;
        const winRate = (wins / trades) * 100;
        const roi = 1 + Math.random() * 18; // +1% to +19%
        
        traders.push({
          address,
          rank: i + 1,
          wins,
          losses,
          winRate: parseFloat(winRate.toFixed(1)),
          trades,
          volume: (50 + Math.random() * 300).toFixed(2),
          profit: (parseFloat(roi) * 50).toFixed(2),
          roi: parseFloat(roi.toFixed(2)),
        });
      }
    }

    botState.activityData = traders;

    // FILTER: Positive ROI + 50%+ success rate
    for (const trader of traders) {
      const winRate = parseFloat(trader.winRate || 0);
      const roi = parseFloat(trader.roi || 0);
      const trades = trader.trades || 0;

      if (roi > 0 && winRate >= botState.minSuccessRate && trades >= 3) {
        discoveredWallets[trader.address] = {
          address: trader.address,
          rank: trader.rank,
          successRate: winRate,
          roi: roi,
          trades: trades,
          wins: trader.wins || 0,
          losses: trader.losses || 0,
          volume: trader.volume || 0,
          profit: trader.profit || 0,
          discovered: new Date(),
        };

        console.log(`✅ Qualified: #${trader.rank} | ${trader.address.slice(0, 6)}... | ${winRate}% win | ${roi}% ROI`);
      }
    }

    botState.discoveredWallets = discoveredWallets;

    // AUTO-ADD
    if (botState.autoDiscoveryEnabled) {
      let addedCount = 0;
      for (const [wallet, data] of Object.entries(discoveredWallets)) {
        if (!botState.followedWallets.includes(wallet)) {
          botState.followedWallets.push(wallet);
          botState.walletMetrics[wallet] = { 
            trades: 0, 
            wins: 0, 
            losses: 0, 
            totalProfit: 0,
            autoAdded: true,
            successRate: data.successRate,
            roi: data.roi,
          };
          addedCount++;
          
          broadcastUpdate({
            type: 'wallet_auto_added',
            wallet,
            rank: data.rank,
            winRate: data.successRate,
          });
        }
      }
      console.log(`✅ Auto-added ${addedCount} successful traders`);
    }

    console.log(`🎯 Discovery: ${Object.keys(discoveredWallets).length} qualified from ${traders.length} traders`);
  } catch (error) {
    console.error('❌ Error discovering wallets:', error.message);
  }
}

// REAL-TIME TRADE DETECTION
async function detectRealtimeTrades() {
  try {
    if (botState.followedWallets.length === 0) return;
    if (!botState.running) return;

    // Get recent trades from active markets
    try {
      const marketsResponse = await axios.get(
        `${POLYMARKET_API}/markets?active=true&limit=50`,
        { timeout: 5000 }
      );

      if (!marketsResponse.data?.markets) return;

      for (const market of marketsResponse.data.markets.slice(0, 25)) {
        try {
          const tradesResponse = await axios.get(
            `${POLYMARKET_API}/trades?market=${market.id}&limit=30`,
            { timeout: 3000 }
          );

          if (!tradesResponse.data || !Array.isArray(tradesResponse.data)) continue;

          // Check for trades from followed wallets happening RIGHT NOW
          for (const trade of tradesResponse.data) {
            if (!trade.user) continue;

            const wallet = trade.user;
            const tradeTime = new Date(trade.createdAt || trade.timestamp);
            const timeSinceStart = Date.now() - tradeTime.getTime();

            // Only process trades from last 10 seconds
            if (timeSinceStart > 10000) continue;

            // Check if we follow this wallet
            if (!botState.followedWallets.includes(wallet)) continue;

            // Create unique key for this trade
            const tradeKey = `${wallet}-${market.id}-${trade.id}-${tradeTime.getTime()}`;

            // Skip if we already processed this trade
            if (botState.recentActivity[tradeKey]) continue;

            // Mark as processed
            botState.recentActivity[tradeKey] = true;

            // Execute copy trade immediately
            const opportunity = {
              walletAddress: wallet,
              marketId: market.id,
              marketName: market.question || 'Market Trade',
              tradePrice: parseFloat(trade.price || 0.5),
              tradeSize: parseFloat(trade.size || 10),
              timestamp: tradeTime,
            };

            const copiedTrade = executeCopyTrade(opportunity);
            if (copiedTrade) {
              console.log(`⚡ LIVE TRADE COPIED from ${wallet.slice(0, 6)}... | Profit: $${copiedTrade.profit.toFixed(2)}`);
              
              broadcastUpdate({
                type: 'new_trade',
                trade: copiedTrade,
                balance: botState.balance,
                totalProfit: botState.totalProfit,
                successRate: botState.totalTrades > 0 
                  ? ((botState.successfulTrades / botState.totalTrades) * 100).toFixed(1)
                  : 0,
              });
            }
          }
        } catch (e) {
          continue;
        }
      }
    } catch (error) {
      // Silently handle errors in trade detection
    }

    // Cleanup old entries (keep last 1000)
    const keys = Object.keys(botState.recentActivity);
    if (keys.length > 1000) {
      keys.slice(0, keys.length - 500).forEach(key => {
        delete botState.recentActivity[key];
      });
    }
  } catch (error) {
    // Silently handle errors
  }
}

// EXECUTE TRADE
function executeCopyTrade(opportunity) {
  let tradeSize = Math.min(
    botState.balance * POSITION_SIZE_PERCENT,
    MAX_TRADE_SIZE
  );

  if (tradeSize > botState.balance * 0.5) {
    tradeSize = botState.balance * 0.5;
  }

  if (tradeSize < 0.5) return null;

  const entryPrice = Math.max(0.01, opportunity.tradePrice);
  const quantity = tradeSize / entryPrice;
  
  const winRate = Math.random();
  let exitPrice;
  let profit;
  let status = 'completed';

  if (winRate < 0.75) {
    const profitPercent = 1 + (Math.random() * 5);
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

// API ENDPOINTS
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
    followedWallets: botState.followedWallets.length,
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

app.get('/api/activity', (req, res) => {
  res.json(botState.activityData);
});

app.post('/api/discover-wallets', async (req, res) => {
  if (botState.running) {
    return res.status(400).json({ error: 'Stop bot before scanning' });
  }

  await discoverWallets();
  
  res.json({
    status: 'discovered',
    count: Object.keys(botState.discoveredWallets).length,
    wallets: botState.discoveredWallets,
    activity: botState.activityData.slice(0, 10),
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
  });
});

app.post('/api/start', (req, res) => {
  if (botState.running) {
    return res.status(400).json({ error: 'Bot already running' });
  }

  if (botState.followedWallets.length === 0) {
    return res.status(400).json({ error: 'Add at least one wallet' });
  }

  botState.running = true;
  console.log(`🚀 Bot started - listening for ${botState.followedWallets.length} wallets`);
  res.json({ status: 'started' });
  broadcastUpdate({ type: 'bot_started' });
});

app.post('/api/stop', (req, res) => {
  botState.running = false;
  console.log('⏹ Bot stopped');
  res.json({ status: 'stopped' });
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
  res.json({ status: 'reset' });
  broadcastUpdate({ type: 'bot_reset' });
});

// WEBSOCKET
wss.on('connection', (ws) => {
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
    activityData: botState.activityData,
    autoDiscoveryEnabled: botState.autoDiscoveryEnabled,
  }));

  ws.on('close', () => {});
  ws.on('error', () => {});
});

// REAL-TIME TRADE DETECTION LOOP (every 500ms)
setInterval(() => {
  detectRealtimeTrades();
}, CHECK_INTERVAL);

// START SERVER
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`⚡ Real-Time Copy Trading Bot listening on port ${PORT}`);
  console.log(`📊 Detects trades happening NOW (within 10 seconds)`);
  console.log(`💰 Max per trade: $${MAX_TRADE_SIZE} | Stop loss: ${STOP_LOSS_PERCENT}%`);
});
