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
  leaderboardData: [],
  autoDiscoveryEnabled: false,
  minSuccessRate: 50,
};

// CONFIG
const POLYMARKET_API = 'https://clob.polymarket.com';
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

// DISCOVER WALLETS FROM LEADERBOARD
async function discoverWallets() {
  try {
    console.log('🔍 Starting leaderboard discovery...');
    
    const discoveredWallets = {};
    let leaderboard = [];

    // Try to get real market data
    try {
      const marketsResponse = await axios.get(
        `${POLYMARKET_API}/markets?active=true&limit=50`,
        { timeout: 5000 }
      );

      console.log('✅ Markets API response received');

      if (marketsResponse.data?.markets && marketsResponse.data.markets.length > 0) {
        console.log(`📊 Found ${marketsResponse.data.markets.length} active markets`);
        
        const walletStats = {};
        let marketCount = 0;

        for (const market of marketsResponse.data.markets.slice(0, 20)) {
          try {
            const tradesResponse = await axios.get(
              `${POLYMARKET_API}/trades?market=${market.id}&limit=20`,
              { timeout: 5000 }
            );

            if (tradesResponse.data && Array.isArray(tradesResponse.data)) {
              marketCount++;
              
              for (const trade of tradesResponse.data) {
                if (!trade.user) continue;

                const wallet = trade.user;

                if (!walletStats[wallet]) {
                  walletStats[wallet] = {
                    address: wallet,
                    totalTrades: 0,
                    winningTrades: 0,
                    totalVolume: 0,
                    profit: 0,
                  };
                }

                walletStats[wallet].totalTrades++;
                walletStats[wallet].totalVolume += trade.size || Math.random() * 100;

                // Simulate outcome based on random
                if (Math.random() > 0.40) {
                  walletStats[wallet].winningTrades++;
                  walletStats[wallet].profit += (trade.size || Math.random() * 50) * 0.08;
                } else {
                  walletStats[wallet].profit -= (trade.size || Math.random() * 50) * 0.05;
                }
              }
            }
          } catch (e) {
            console.log(`⚠️ Error fetching trades for market: ${e.message}`);
            continue;
          }
        }

        console.log(`✅ Processed ${marketCount} markets, found ${Object.keys(walletStats).length} wallets`);

        if (Object.keys(walletStats).length > 0) {
          const processed = Object.values(walletStats)
            .filter(user => user.totalTrades >= 2)
            .map(user => ({
              address: user.address,
              rank: 0,
              wins: user.winningTrades,
              winRate: user.totalTrades > 0 
                ? parseFloat(((user.winningTrades / user.totalTrades) * 100).toFixed(1))
                : 0,
              trades: user.totalTrades,
              volume: parseFloat((user.totalVolume).toFixed(2)),
              profit: parseFloat((user.profit).toFixed(2)),
              roi: user.totalVolume > 0
                ? parseFloat(((user.profit / user.totalVolume) * 100).toFixed(2))
                : 0,
            }))
            .sort((a, b) => b.winRate - a.winRate)
            .slice(0, 50);

          processed.forEach((user, index) => {
            user.rank = index + 1;
          });

          leaderboard = processed;
          console.log(`✅ Generated leaderboard with ${leaderboard.length} traders`);
        }
      }
    } catch (error) {
      console.error('⚠️ Error fetching market data:', error.message);
    }

    // If no data, generate realistic simulated leaderboard
    if (leaderboard.length === 0) {
      console.log('📊 Generating simulated leaderboard...');
      leaderboard = [];
      
      for (let i = 0; i < 20; i++) {
        const randomBytes = Math.random().toString(16).substring(2, 10);
        const address = `0x${randomBytes}${Math.random().toString(16).substring(2, 32)}`;
        const winRate = 50 + Math.random() * 35; // 50-85%
        const trades = 5 + Math.floor(Math.random() * 20);
        const roi = (Math.random() * 30 - 5).toFixed(2); // -5% to +25%
        
        leaderboard.push({
          address,
          rank: i + 1,
          wins: Math.ceil((trades * winRate) / 100),
          winRate: parseFloat(winRate.toFixed(1)),
          trades,
          volume: (100 + Math.random() * 400).toFixed(2),
          profit: (parseFloat(roi) * 50).toFixed(2),
          roi: parseFloat(roi),
        });
      }
      
      console.log('✅ Generated simulated leaderboard');
    }

    // Process discovered wallets
    const processedDiscovered = {};
    for (const user of leaderboard) {
      const winRate = parseFloat(user.winRate || 0);
      const trades = user.trades || 0;

      if (winRate >= botState.minSuccessRate && trades >= 3) {
        processedDiscovered[user.address] = {
          address: user.address,
          rank: user.rank,
          successRate: winRate,
          trades: trades,
          wins: user.wins || 0,
          volume: user.volume || 0,
          roi: parseFloat(user.roi || 0),
          profit: user.profit || 0,
          discovered: new Date(),
        };

        console.log(`✅ Found: Rank #${user.rank} | ${user.address.slice(0, 6)}... | ${winRate}% win | ${trades} trades`);
      }
    }

    botState.discoveredWallets = processedDiscovered;
    botState.leaderboardData = leaderboard;

    // Auto-add if enabled
    if (botState.autoDiscoveryEnabled) {
      let addedCount = 0;
      for (const [wallet, data] of Object.entries(processedDiscovered)) {
        if (!botState.followedWallets.includes(wallet)) {
          botState.followedWallets.push(wallet);
          botState.walletMetrics[wallet] = { 
            trades: 0, 
            wins: 0, 
            losses: 0, 
            totalProfit: 0,
            autoAdded: true,
            leaderboardRank: data.rank,
            leaderboardWinRate: data.successRate,
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
      console.log(`✅ Auto-added ${addedCount} wallets`);
    }

    console.log(`🎯 Discovery complete: Found ${Object.keys(processedDiscovered).length} qualifying traders from ${leaderboard.length} total`);
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

app.get('/api/leaderboard', (req, res) => {
  res.json(botState.leaderboardData);
});

app.post('/api/discover-wallets', async (req, res) => {
  if (botState.running) {
    return res.status(400).json({ error: 'Stop bot before discovering' });
  }

  await discoverWallets();
  
  res.json({
    status: 'discovered',
    count: Object.keys(botState.discoveredWallets).length,
    wallets: botState.discoveredWallets,
    leaderboard: botState.leaderboardData.slice(0, 10),
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
    leaderboardData: botState.leaderboardData,
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
  console.log(`💰 Max per trade: $${MAX_TRADE_SIZE}`);
  console.log(`🛑 Stop loss: ${STOP_LOSS_PERCENT}%`);
  console.log(`📈 Min success rate: ${botState.minSuccessRate}%`);
});
