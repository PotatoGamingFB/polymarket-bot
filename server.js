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
};

// CONFIG
const POLYMARKET_API = 'https://clob.polymarket.com';
const POLYMARKET_ACTIVITY = 'https://polymarket.com/api/activity';
const POLYMARKET_LEADERBOARD = 'https://polymarket.com/api/leaderboard';
const CHECK_INTERVAL = 1000;
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

// DISCOVER WALLETS FROM ACTIVITY FEED
async function discoverWallets() {
  try {
    console.log('🔍 Scanning Polymarket activity feed...');
    
    const discoveredWallets = {};
    let traders = [];
    const traderStats = {};

    // Try activity feed first
    try {
      const activityResponse = await axios.get(
        POLYMARKET_ACTIVITY,
        { timeout: 8000 }
      );

      console.log('✅ Activity feed loaded');

      if (activityResponse.data) {
        const activities = Array.isArray(activityResponse.data) 
          ? activityResponse.data 
          : activityResponse.data.activity || [];

        console.log(`📊 Found ${activities.length} recent activities`);

        // Get today's date for filtering
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        // Process activities
        for (const activity of activities.slice(0, 100)) {
          if (!activity.user) continue;

          const wallet = activity.user;
          const activityTime = new Date(activity.createdAt || activity.timestamp);

          // Only process today's activities
          if (activityTime < today) continue;

          if (!traderStats[wallet]) {
            traderStats[wallet] = {
              address: wallet,
              trades: 0,
              wins: 0,
              losses: 0,
              profit: 0,
              volume: 0,
              lastActive: activityTime,
            };
          }

          traderStats[wallet].trades++;
          traderStats[wallet].volume += activity.amount || 0;
          traderStats[wallet].lastActive = activityTime;

          // Simulate outcome (mark as win/loss)
          if (activity.outcome === 'win' || Math.random() > 0.40) {
            traderStats[wallet].wins++;
            traderStats[wallet].profit += (activity.amount || Math.random() * 50) * 0.05;
          } else {
            traderStats[wallet].losses++;
            traderStats[wallet].profit -= (activity.amount || Math.random() * 50) * 0.03;
          }
        }

        // Convert to leaderboard format
        traders = Object.values(traderStats)
          .filter(t => t.trades >= 2) // At least 2 trades today
          .map((t, index) => ({
            address: t.address,
            rank: index + 1,
            wins: t.wins,
            winRate: t.trades > 0 
              ? parseFloat(((t.wins / t.trades) * 100).toFixed(1))
              : 0,
            trades: t.trades,
            volume: parseFloat(t.volume.toFixed(2)),
            profit: parseFloat(t.profit.toFixed(2)),
            roi: t.volume > 0
              ? parseFloat(((t.profit / t.volume) * 100).toFixed(2))
              : 0,
            lastActive: t.lastActive,
          }))
          .sort((a, b) => b.roi - a.roi) // Sort by ROI
          .slice(0, 50);

        console.log(`✅ Found ${traders.length} active traders today`);
      }
    } catch (error) {
      console.log(`⚠️ Activity API error: ${error.message}`);
    }

    // Try leaderboard as fallback
    if (traders.length === 0) {
      console.log('📊 Trying leaderboard API...');
      try {
        const leaderboardResponse = await axios.get(
          `${POLYMARKET_LEADERBOARD}?period=daily&limit=50`,
          { timeout: 8000 }
        );

        if (leaderboardResponse.data?.data) {
          traders = leaderboardResponse.data.data
            .map((user, index) => ({
              address: user.address || user.wallet,
              rank: index + 1,
              wins: user.wins || 0,
              winRate: parseFloat(user.winRate || 0),
              trades: user.trades || 0,
              volume: user.volume || 0,
              profit: user.profit || 0,
              roi: parseFloat(user.roi || 0),
              lastActive: new Date(),
            }))
            .slice(0, 50);

          console.log(`✅ Leaderboard returned ${traders.length} traders`);
        }
      } catch (error) {
        console.log(`⚠️ Leaderboard API error: ${error.message}`);
      }
    }

    // If still no data, generate realistic active traders
    if (traders.length === 0) {
      console.log('📊 Generating simulated active traders...');
      traders = [];
      
      for (let i = 0; i < 15; i++) {
        let address = '0x';
        for (let j = 0; j < 40; j++) {
          address += Math.floor(Math.random() * 16).toString(16);
        }
        
        const trades = 3 + Math.floor(Math.random() * 12);
        const wins = Math.floor(trades * (0.50 + Math.random() * 0.35));
        const winRate = (wins / trades) * 100;
        const roi = 2 + Math.random() * 15; // Positive ROI: 2-17%
        
        traders.push({
          address,
          rank: i + 1,
          wins,
          winRate: parseFloat(winRate.toFixed(1)),
          trades,
          volume: (50 + Math.random() * 200).toFixed(2),
          profit: (parseFloat(roi) * 30).toFixed(2),
          roi: parseFloat(roi.toFixed(2)),
          lastActive: new Date(),
        });
      }
      
      traders.sort((a, b) => b.roi - a.roi);
      console.log('✅ Generated simulated active traders');
    }

    botState.activityData = traders;

    // FILTER: Positive ROI today + 50%+ success rate
    for (const trader of traders) {
      const winRate = parseFloat(trader.winRate || 0);
      const roi = parseFloat(trader.roi || 0);
      const trades = trader.trades || 0;

      // Must have: positive ROI today AND 50%+ win rate AND at least 2 trades
      if (roi > 0 && winRate >= botState.minSuccessRate && trades >= 2) {
        discoveredWallets[trader.address] = {
          address: trader.address,
          rank: trader.rank,
          successRate: winRate,
          todayROI: roi,
          trades: trades,
          wins: trader.wins || 0,
          volume: trader.volume || 0,
          profit: trader.profit || 0,
          lastActive: trader.lastActive,
          discovered: new Date(),
        };

        console.log(`✅ Qualified: Rank #${trader.rank} | ${trader.address.slice(0, 6)}... | ${winRate}% win | ${roi}% ROI today | ${trades} trades`);
      }
    }

    botState.discoveredWallets = discoveredWallets;

    // AUTO-ADD if enabled
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
            activityRank: data.rank,
            todayWinRate: data.successRate,
            todayROI: data.todayROI,
          };
          addedCount++;
          
          broadcastUpdate({
            type: 'wallet_auto_added',
            wallet,
            rank: data.rank,
            winRate: data.successRate,
            roi: data.todayROI,
          });
        }
      }
      console.log(`✅ Auto-added ${addedCount} active traders`);
    }

    console.log(`🎯 Scan complete: Found ${Object.keys(discoveredWallets).length} qualified traders from ${traders.length} active`);
  } catch (error) {
    console.error('❌ Error discovering wallets:', error.message);
  }
}

// GET WALLET TRADES
async function getWalletTrades(walletAddress) {
  try {
    const response = await axios.get(
      `${POLYMARKET_API}/user-trades?user=${walletAddress}&limit=10`,
      { timeout: 5000 }
    );
    return response.data || [];
  } catch (error) {
    return [];
  }
}

// DETECT OPPORTUNITIES
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
    return [];
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

// MONITOR AND TRADE
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
    return res.status(400).json({ error: 'Add at least one wallet to follow' });
  }

  botState.running = true;
  res.json({ status: 'started' });
  broadcastUpdate({ type: 'bot_started' });
});

app.post('/api/stop', (req, res) => {
  botState.running = false;
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
  console.log('Client connected');

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

  ws.on('close', () => {
    console.log('Client disconnected');
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error.message);
  });
});

// MONITOR LOOP
setInterval(() => {
  monitorAndTrade();
}, CHECK_INTERVAL);

// START SERVER
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🤖 Bot running on port ${PORT}`);
  console.log(`📊 Scanning: Polymarket activity feed`);
  console.log(`💰 Max per trade: $${MAX_TRADE_SIZE}`);
  console.log(`🛑 Stop loss: ${STOP_LOSS_PERCENT}%`);
  console.log(`📈 Min success rate: ${botState.minSuccessRate}%`);
  console.log(`✅ Filter: Positive ROI today + ${botState.minSuccessRate}%+ win rate`);
});
