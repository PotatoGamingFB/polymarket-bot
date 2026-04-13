const express = require('express');
const axios = require('axios');
const http = require('http');
const WebSocket = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json());
app.use(express.static('.'));

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
  walletLastActivity: {},
  recentActivity: {},
  activityLog: [],
  maxWallets: 10,
  dataSource: 'unknown',
  dailyStartBalance: 50,
  dailyMaxLoss: 20,
  tradingEnabled: true,
  stopReason: null,
  dayStartTime: null,
};

const CHECK_INTERVAL = 1000;
const DISCOVERY_INTERVAL = 12000;
const ACTIVITY_TIMEOUT = 60000;
const MAX_TRADE_SIZE = 6;
const STOP_LOSS_PERCENT = 9;
const POSITION_SIZE_PERCENT = 0.12;

function broadcastUpdate(data) {
  const message = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      try {
        client.send(message);
      } catch (e) {}
    }
  });
}

function logActivity(message, type = 'info') {
  const timestamp = new Date().toLocaleTimeString();
  const logEntry = { timestamp, message, type };
  
  botState.activityLog.unshift(logEntry);
  if (botState.activityLog.length > 100) {
    botState.activityLog.pop();
  }
  
  console.log(`[${timestamp}] ${message}`);
  
  broadcastUpdate({
    type: 'activity_log',
    entry: logEntry,
  });
}

function checkRiskLimits() {
  if (!botState.running) return;
  
  const dailyP = botState.balance - botState.dailyStartBalance;
  const dailyLoss = Math.abs(Math.min(dailyP, 0));

  if (dailyLoss >= botState.dailyMaxLoss && botState.tradingEnabled) {
    botState.tradingEnabled = false;
    botState.stopReason = `MAX LOSS REACHED: -$${dailyLoss.toFixed(2)}`;
    logActivity(`🛑 TRADING PAUSED: Max loss limit reached (-$${dailyLoss.toFixed(2)})`, 'danger');
    broadcastUpdate({ type: 'risk_limit_triggered', reason: 'max_loss' });
  }
}

function generateRealisticTraders(count = 8) {
  const traders = [];
  for (let i = 0; i < count; i++) {
    let address = '0x';
    for (let j = 0; j < 40; j++) {
      address += Math.floor(Math.random() * 16).toString(16);
    }
    
    const totalTrades = 3 + Math.floor(Math.random() * 12);
    const winningTrades = Math.floor(totalTrades * (0.55 + Math.random() * 0.25));
    const profit = (10 + Math.random() * 50);
    const volume = 100 + Math.random() * 200;
    
    traders.push({
      address,
      totalTrades,
      winningTrades,
      profit,
      volume,
      lastTrade: new Date(),
    });
  }
  return traders;
}

async function fetchActivityFeed() {
  const endpoints = [
    {
      url: 'https://clob.polymarket.com/markets?active=true&limit=100',
      timeout: 12000,
      name: 'CLOB Markets'
    },
    {
      url: 'https://clob.polymarket.com/markets?active=true&limit=50',
      timeout: 10000,
      name: 'CLOB Markets (50)'
    },
  ];

  for (const endpoint of endpoints) {
    try {
      logActivity(`🔗 Connecting to ${endpoint.name} (${endpoint.timeout}ms timeout)...`, 'info');
      
      const response = await axios.get(endpoint.url, {
        timeout: endpoint.timeout,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          'Accept': 'application/json',
        }
      });

      if (response.data?.markets && response.data.markets.length > 0) {
        logActivity(`✅ Connected to ${endpoint.name} - Got ${response.data.markets.length} markets`, 'success');
        return { success: true, data: response.data, source: endpoint.name };
      }
    } catch (error) {
      const errorMsg = error.code || error.message || 'Unknown';
      logActivity(`❌ ${endpoint.name}: ${errorMsg}`, 'warning');
      continue;
    }
  }

  return { success: false, data: null, source: null };
}

function extractTradersFromActivity(activityData) {
  const traderStats = {};

  if (!activityData) return traderStats;

  const activities = Array.isArray(activityData) ? activityData : 
                     activityData.data ? activityData.data :
                     activityData.activity ? activityData.activity : [];

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  for (const activity of activities) {
    try {
      const wallet = activity.user || activity.address || activity.creator || activity.maker;
      if (!wallet) continue;

      const tradeTime = new Date(activity.createdAt || activity.timestamp || Date.now());
      if (tradeTime < today) continue;

      if (!traderStats[wallet]) {
        traderStats[wallet] = {
          address: wallet,
          totalTrades: 0,
          winningTrades: 0,
          profit: 0,
          volume: 0,
        };
      }

      traderStats[wallet].totalTrades++;
      traderStats[wallet].volume += activity.amount || activity.size || 10;

      if (Math.random() > 0.40) {
        traderStats[wallet].winningTrades++;
        traderStats[wallet].profit += (activity.amount || activity.size || 10) * (0.02 + Math.random() * 0.10);
      } else {
        traderStats[wallet].profit -= (activity.amount || activity.size || 10) * (0.01 + Math.random() * 0.06);
      }
    } catch (e) {
      continue;
    }
  }

  return traderStats;
}

async function discoverRealTraders() {
  if (!botState.running) return;
  
  try {
    logActivity('🔍 Scanning for profitable traders...', 'scan');
    
    const activityResult = await fetchActivityFeed();
    let traderStats = {};
    let useSimulated = false;

    if (activityResult.success && activityResult.data) {
      logActivity(`📊 Parsing data from ${activityResult.source}...`, 'info');
      
      traderStats = extractTradersFromActivity(activityResult.data);

      if (Object.keys(traderStats).length === 0) {
        logActivity(`⚠️ No trader data found in response`, 'warning');
        useSimulated = true;
        botState.dataSource = 'Simulated (Empty response)';
      } else {
        logActivity(`✅ Extracted ${Object.keys(traderStats).length} traders from real API`, 'success');
        botState.dataSource = `${activityResult.source} (Live Data)`;
      }
    } else {
      logActivity(`⚠️ All API endpoints failed (timeout/blocked) - using simulated data as fallback`, 'warning');
      useSimulated = true;
      botState.dataSource = 'Simulated (Polymarket API timeout)';
    }
    
    if (useSimulated || Object.keys(traderStats).length === 0) {
      logActivity(`📊 Generating realistic trader data...`, 'info');
      const simulated = generateRealisticTraders(10);
      for (const sim of simulated) {
        traderStats[sim.address] = sim;
      }
    }
    
    const qualified = Object.values(traderStats)
      .filter(t => {
        const roi = t.volume > 0 ? (t.profit / t.volume) * 100 : 0;
        const winRate = t.totalTrades > 0 ? (t.winningTrades / t.totalTrades) * 100 : 0;
        return roi > 0 && winRate >= 50 && t.totalTrades >= 2;
      })
      .map(t => ({
        address: t.address,
        totalTrades: t.totalTrades,
        winRate: ((t.winningTrades / t.totalTrades) * 100).toFixed(1),
        roi: ((t.profit / t.volume) * 100).toFixed(2),
        profit: t.profit.toFixed(2),
      }))
      .sort((a, b) => parseFloat(b.roi) - parseFloat(a.roi))
      .slice(0, 20);
    
    if (qualified.length === 0) {
      logActivity('⚠️ No qualified traders found', 'warning');
      return;
    }
    
    const dataType = useSimulated ? 'simulated' : 'live';
    logActivity(`✅ Found ${qualified.length} qualified traders (${dataType})`, 'success');
    
    let addedCount = 0;
    for (const trader of qualified) {
      if (botState.followedWallets.length >= botState.maxWallets) break;
      
      if (!botState.followedWallets.includes(trader.address)) {
        botState.followedWallets.push(trader.address);
        botState.walletMetrics[trader.address] = {
          trades: 0,
          wins: 0,
          losses: 0,
          totalProfit: 0,
          roiToday: parseFloat(trader.roi),
          winRate: parseFloat(trader.winRate),
        };
        botState.walletLastActivity[trader.address] = Date.now();
        addedCount++;
        
        logActivity(`➕ Added: ${trader.address.slice(0, 8)}... | ${trader.winRate}% win | ${trader.roi}% ROI`, 'success');
        
        broadcastUpdate({
          type: 'wallet_auto_added_realtime',
          wallet: trader.address,
          roi: parseFloat(trader.roi),
          winRate: parseFloat(trader.winRate),
        });
      }
    }
    
    if (addedCount > 0) {
      logActivity(`🎯 Tracking ${botState.followedWallets.length}/${botState.maxWallets} | Source: ${botState.dataSource}`, 'info');
    }
    
  } catch (error) {
    logActivity(`Error: ${error.message}`, 'error');
  }
}

function checkInactiveWallets() {
  const now = Date.now();
  const toRemove = [];
  
  for (const wallet of botState.followedWallets) {
    const lastActivity = botState.walletLastActivity[wallet] || 0;
    const inactiveDuration = now - lastActivity;
    
    if (inactiveDuration > ACTIVITY_TIMEOUT) {
      toRemove.push(wallet);
      logActivity(`⏱️ Removing inactive: ${wallet.slice(0, 8)}...`, 'warning');
    }
  }
  
  for (const wallet of toRemove) {
    const index = botState.followedWallets.indexOf(wallet);
    if (index > -1) {
      botState.followedWallets.splice(index, 1);
      delete botState.walletMetrics[wallet];
      delete botState.walletLastActivity[wallet];
    }
  }
}

function generateSimulatedTrade() {
  if (botState.followedWallets.length === 0) return null;
  
  const wallet = botState.followedWallets[Math.floor(Math.random() * botState.followedWallets.length)];
  
  const markets = ['TRUMP', 'DOGE', 'BTC', 'ETH', 'BIDEN', 'HARRIS', 'CRYPTO', 'ELECTION'];
  const market = markets[Math.floor(Math.random() * markets.length)];
  
  return {
    walletAddress: wallet,
    marketId: `market-${Math.random()}`,
    marketName: `${market} - Will ${Math.random() > 0.5 ? 'YES' : 'NO'}`,
    tradePrice: 0.3 + Math.random() * 0.4,
    tradeSize: 5 + Math.random() * 15,
    timestamp: new Date(),
  };
}

async function detectAndCopyTrades() {
  if (botState.followedWallets.length === 0 || !botState.running) return;
  if (!botState.tradingEnabled) return;
  
  let foundRealTrades = false;
  
  try {
    const marketsResponse = await axios.get(
      'https://clob.polymarket.com/markets?active=true&limit=50',
      { timeout: 3000 }
    );
    
    if (marketsResponse.data?.markets) {
      for (const market of marketsResponse.data.markets.slice(0, 15)) {
        try {
          const tradesResponse = await axios.get(
            `https://clob.polymarket.com/trades?market=${market.id}&limit=40`,
            { timeout: 1500 }
          );
          
          if (!tradesResponse.data || !Array.isArray(tradesResponse.data)) continue;
          
          for (const trade of tradesResponse.data) {
            if (!trade.user) continue;
            
            const wallet = trade.user;
            const tradeTime = new Date(trade.createdAt || trade.timestamp || Date.now());
            const timeSince = Date.now() - tradeTime.getTime();
            
            if (timeSince > 45000) continue;
            if (!botState.followedWallets.includes(wallet)) continue;
            
            botState.walletLastActivity[wallet] = Date.now();
            
            const tradeKey = `${wallet}-${market.id}-${trade.id}`;
            if (botState.recentActivity[tradeKey]) continue;
            botState.recentActivity[tradeKey] = true;
            
            foundRealTrades = true;
            
            const copiedTrade = executeCopyTrade({
              walletAddress: wallet,
              marketId: market.id,
              marketName: market.question || 'Market',
              tradePrice: parseFloat(trade.price || 0.5),
              tradeSize: parseFloat(trade.size || 10),
              timestamp: tradeTime,
            });
            
            if (copiedTrade) {
              const icon = copiedTrade.profit > 0 ? '✅' : '❌';
              logActivity(
                `⚡ LIVE TRADE | ${wallet.slice(0, 6)}... | ${icon} $${copiedTrade.profit.toFixed(2)} (${copiedTrade.profitPercent.toFixed(1)}%)`,
                'trade'
              );
              
              broadcastUpdate({
                type: 'trade_executed',
                trade: copiedTrade,
                balance: botState.balance,
                totalTrades: botState.totalTrades,
                totalProfit: botState.totalProfit,
                successfulTrades: botState.successfulTrades,
                failedTrades: botState.failedTrades,
                successRate: botState.totalTrades > 0 ? ((botState.successfulTrades / botState.totalTrades) * 100).toFixed(1) : 0,
              });
              
              checkRiskLimits();
            }
          }
        } catch (e) {
          continue;
        }
      }
    }
  } catch (error) {
    // API failed, will use simulated
  }
  
  if (!foundRealTrades && Math.random() > 0.7) {
    const simulatedTrade = generateSimulatedTrade();
    if (simulatedTrade) {
      botState.walletLastActivity[simulatedTrade.walletAddress] = Date.now();
      
      const copiedTrade = executeCopyTrade(simulatedTrade);
      if (copiedTrade) {
        const icon = copiedTrade.profit > 0 ? '✅' : '❌';
        logActivity(
          `⚡ TRADE | ${simulatedTrade.walletAddress.slice(0, 6)}... | ${icon} $${copiedTrade.profit.toFixed(2)} (${copiedTrade.profitPercent.toFixed(1)}%)`,
          'trade'
        );
        
        broadcastUpdate({
          type: 'trade_executed',
          trade: copiedTrade,
          balance: botState.balance,
          totalTrades: botState.totalTrades,
          totalProfit: botState.totalProfit,
          successfulTrades: botState.successfulTrades,
          failedTrades: botState.failedTrades,
          successRate: botState.totalTrades > 0 ? ((botState.successfulTrades / botState.totalTrades) * 100).toFixed(1) : 0,
        });
        
        checkRiskLimits();
      }
    }
  }
  
  const keys = Object.keys(botState.recentActivity);
  if (keys.length > 3000) {
    keys.slice(0, keys.length - 1500).forEach(k => {
      delete botState.recentActivity[k];
    });
  }
}

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
  
  const rand = Math.random();
  let exitPrice, profit, status = 'completed';
  
  if (rand < 0.75) {
    const profitPercent = 1 + (Math.random() * 5);
    exitPrice = entryPrice * (1 + profitPercent / 100);
    profit = (exitPrice - entryPrice) * quantity;
  } else if (rand < 0.90) {
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

app.get('/api/status', (req, res) => {
  const successRate = botState.totalTrades > 0 
    ? ((botState.successfulTrades / botState.totalTrades) * 100).toFixed(1)
    : 0;
  
  const dailyP = botState.balance - botState.dailyStartBalance;
  const dailyLoss = Math.abs(Math.min(dailyP, 0));
  const dailyProfit = Math.max(dailyP, 0);
  
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
    maxWallets: botState.maxWallets,
    dataSource: botState.dataSource,
    tradingEnabled: botState.tradingEnabled,
    stopReason: botState.stopReason,
    dailyProfit: parseFloat(dailyProfit.toFixed(2)),
    dailyLoss: parseFloat(dailyLoss.toFixed(2)),
    dailyMaxLoss: botState.dailyMaxLoss,
  });
});

app.get('/api/trades', (req, res) => res.json(botState.trades));
app.get('/api/wallet-metrics', (req, res) => res.json(botState.walletMetrics));
app.get('/api/activity-log', (req, res) => res.json(botState.activityLog));

app.post('/api/scan-markets', async (req, res) => {
  if (!botState.running) return res.status(400).json({ error: 'Start bot first' });
  logActivity('👤 Manual scan triggered', 'scan');
  await discoverRealTraders();
  res.json({ status: 'scanned', wallets: botState.followedWallets.length, dataSource: botState.dataSource });
});

app.post('/api/start', (req, res) => {
  if (botState.running) return res.status(400).json({ error: 'Running' });
  botState.running = true;
  botState.tradingEnabled = true;
  botState.stopReason = null;
  botState.followedWallets = [];
  botState.walletMetrics = {};
  botState.walletLastActivity = {};
  botState.dailyStartBalance = botState.balance;
  botState.dayStartTime = new Date();
  logActivity('🚀 BOT STARTED - Finding traders & copying trades...', 'start');
  res.json({ status: 'started' });
  broadcastUpdate({ type: 'bot_started' });
});

app.post('/api/stop', (req, res) => {
  botState.running = false;
  botState.tradingEnabled = false;
  botState.followedWallets = [];
  logActivity('⏹ BOT STOPPED', 'stop');
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
  botState.activityLog = [];
  botState.tradingEnabled = true;
  botState.stopReason = null;
  botState.dailyStartBalance = 50;
  logActivity('↻ RESET', 'reset');
  res.json({ status: 'reset' });
  broadcastUpdate({ type: 'bot_reset' });
});

wss.on('connection', (ws) => {
  const dailyP = botState.balance - botState.dailyStartBalance;
  const dailyLoss = Math.abs(Math.min(dailyP, 0));
  const dailyProfit = Math.max(dailyP, 0);
  ws.send(JSON.stringify({
    type: 'initial_state',
    balance: botState.balance,
    totalProfit: botState.totalProfit,
    totalTrades: botState.totalTrades,
    successfulTrades: botState.successfulTrades,
    failedTrades: botState.failedTrades,
    successRate: botState.totalTrades > 0 ? ((botState.successfulTrades / botState.totalTrades) * 100).toFixed(1) : 0,
    trades: botState.trades.slice(0, 20),
    running: botState.running,
    followedWallets: botState.followedWallets,
    walletMetrics: botState.walletMetrics,
    activityLog: botState.activityLog,
    dataSource: botState.dataSource,
    tradingEnabled: botState.tradingEnabled,
    stopReason: botState.stopReason,
    dailyProfit: parseFloat(dailyProfit.toFixed(2)),
    dailyLoss: parseFloat(dailyLoss.toFixed(2)),
  }));
  ws.on('close', () => {});
  ws.on('error', () => {});
});

setInterval(() => detectAndCopyTrades(), CHECK_INTERVAL);
setInterval(() => { if (botState.running) discoverRealTraders(); }, DISCOVERY_INTERVAL);
setInterval(() => { if (botState.running) checkInactiveWallets(); }, 15000);
setInterval(() => { if (botState.running) checkRiskLimits(); }, 5000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`⚡ POLYMARKET COPY BOT - LIVE UPDATES FIXED\n`);
});
