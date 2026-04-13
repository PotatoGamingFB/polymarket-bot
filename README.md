# Polymarket Arbitrage Bot - Setup Guide

## 📋 Overview

This is a **fully simulated** Polymarket arbitrage bot designed for testing and validation. It monitors order book imbalances and executes simulated trades with a $50 CAD starting balance.

**Key Features:**
- ✅ Real-time market monitoring (every 1 second)
- ✅ Automatic arbitrage opportunity detection
- ✅ Simulated trade execution with 20% stop-loss
- ✅ Beautiful real-time dashboard with WebSocket updates
- ✅ P&L tracking, trade history, and performance metrics
- ✅ No wallet integration (fully isolated test environment)

---

## 🚀 Quick Start

### 1. **Install Dependencies**

```bash
cd /path/to/bot
npm install
```

### 2. **Start the Server**

```bash
npm start
# Or: node server.js
```

You should see:
```
🤖 Polymarket Arbitrage Bot running on http://localhost:3000
📊 Starting balance: $50 CAD
⏱️  Checking markets every 1000ms
```

### 3. **Access the Dashboard**

Open your browser to: `http://localhost:3000`

### 4. **Start the Bot**

Click the **▶ Start Bot** button in the dashboard to begin monitoring markets.

---

## 📁 File Structure

```
polymarket-arbitrage-bot/
├── server.js           # Express server + bot logic
├── index.html          # Web dashboard (auto-served)
├── package.json        # Dependencies
└── README.md          # This file
```

---

## 🔧 How It Works

### Bot Logic

1. **Market Monitoring** (Every 1 second)
   - Fetches active Polymarket markets
   - Analyzes order book data (bids/asks)
   - Calculates spread percentages
   - Detects imbalance ratios

2. **Opportunity Detection**
   - Looks for spreads > 1.2%
   - Monitors buy/sell pressure imbalances
   - Filters out low-volume opportunities

3. **Trade Execution**
   - Allocates max 20% of balance per trade (max $10)
   - Simulates buying at bid, selling at ask
   - Records profit/loss
   - Updates UI in real-time

4. **Risk Management**
   - 20% stop-loss (auto-closes losing positions)
   - Conservative position sizing
   - All trades fully logged

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/status` | Bot status + balance info |
| GET | `/api/trades` | Get all trades |
| POST | `/api/start` | Start monitoring |
| POST | `/api/stop` | Stop monitoring |
| POST | `/api/reset` | Reset to $50 balance |
| WS | `/` | WebSocket real-time updates |

---

## 📊 Dashboard Features

### Metrics Cards
- **Current Balance**: Live wallet balance
- **Total Profit**: Cumulative P&L
- **ROI**: Return on investment %
- **Total Trades**: Number of executed trades

### Charts
- **Balance History**: Line chart of balance over time
- **Trade Distribution**: Profitable vs losing trades

### Trade Table
Shows recent trades with:
- Timestamp
- Market name
- Entry/exit prices
- Spread exploited
- Profit/loss
- ROI %

---

## ⚙️ Configuration

### Starting Balance
Edit `server.js` line 13:
```javascript
balance: 50, // Change this value (in CAD)
```

### Check Frequency
Edit `server.js` line 27:
```javascript
const CHECK_INTERVAL = 1000; // milliseconds (1000 = 1 second)
```

### Position Size
Edit `server.js` line 118:
```javascript
const tradeSize = Math.min(botState.balance * 0.2, 10); 
// 0.2 = 20% of balance, 10 = max $10 per trade
```

### Spread Threshold
Edit `server.js` line 179:
```javascript
if (botState.balance > 5 && opportunity.spreadPercent > 1.2) {
// 1.2 = requires 1.2%+ spread to trade
```

---

## 🔌 Deployment to Your Web Server

### Option 1: Node.js Server (Recommended)

1. Copy all files to your server:
```bash
scp -r polymarket-arbitrage-bot/ user@your-server:/var/www/
```

2. SSH into your server:
```bash
ssh user@your-server
```

3. Install and run:
```bash
cd /var/www/polymarket-arbitrage-bot
npm install
npm start
```

4. Use a process manager (PM2):
```bash
npm install -g pm2
pm2 start server.js --name "polymarket-bot"
pm2 save
pm2 startup
```

### Option 2: With Nginx Reverse Proxy

1. Configure Nginx:
```nginx
server {
    listen 80;
    server_name your-domain.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400;
    }
}
```

2. Enable Nginx and restart:
```bash
sudo systemctl enable nginx
sudo systemctl restart nginx
```

3. Run bot with PM2:
```bash
pm2 start server.js --name "polymarket-bot"
```

---

## 🌐 Connect to Polymarket API (When Ready)

To connect real API credentials later, add them to `server.js`:

```javascript
const POLYMARKET_API_KEY = process.env.POLYMARKET_API_KEY || '';
const POLYMARKET_API_SECRET = process.env.POLYMARKET_API_SECRET || '';
```

Then set environment variables:
```bash
export POLYMARKET_API_KEY="your-key"
export POLYMARKET_API_SECRET="your-secret"
```

---

## 🧪 Testing

### Test the API
```bash
# Check bot status
curl http://localhost:3000/api/status

# Start the bot
curl -X POST http://localhost:3000/api/start

# Get all trades
curl http://localhost:3000/api/trades

# Stop the bot
curl -X POST http://localhost:3000/api/stop

# Reset to $50
curl -X POST http://localhost:3000/api/reset
```

### Monitor the Dashboard
1. Open `http://localhost:3000` in browser
2. Watch real-time updates
3. Check console for debug logs (F12)

---

## 🐛 Troubleshooting

### "Cannot GET /"
- Make sure `index.html` is in the same directory as `server.js`
- Check that the file is named exactly `index.html`

### WebSocket connection fails
- Ensure WebSocket upgrades are allowed (not blocked by firewall)
- Check browser console for detailed errors
- Try accessing from `http://` not `https://` initially

### No trades executing
- Click "Start Bot" button
- Check console (F12) for errors
- Try lowering the spread threshold (in `server.js`)
- Verify Polymarket API is accessible

### "Port 3000 already in use"
```bash
# Kill the process using port 3000
lsof -i :3000
kill -9 <PID>

# Or use a different port
PORT=3001 npm start
```

---

## 📈 Next Steps for Production

1. **Add Real Wallet Integration**
   - Integrate ethers.js or web3.js
   - Add private key management
   - Implement actual transaction signing

2. **Add More Strategies**
   - Multi-market correlation tracking
   - Momentum indicators
   - Volume-weighted price analysis

3. **Improve Market Data**
   - Subscribe to WebSocket feeds (instead of polling)
   - Add caching layer
   - Track historical order books

4. **Security Hardening**
   - Add API authentication
   - Rate limiting
   - Input validation
   - Encrypted credential storage

5. **Monitoring & Alerts**
   - Email/Slack notifications
   - Error tracking (Sentry)
   - Performance monitoring
   - Automated backups

---

## 📝 Notes

- **This is a test environment** - No real transactions occur
- **Markets checked**: Top 50 active Polymarket markets
- **Simulation is conservative** - Doesn't account for actual slippage, gas, fees
- **Stop-loss is auto**: 20% losses automatically close positions
- **All data is in-memory** - Resets on server restart

---

## ❓ FAQ

**Q: Is this connected to real wallets?**
A: No, this is fully simulated. No real money moves.

**Q: Can I lose more than $50?**
A: No, the starting balance is $50 and losses are capped.

**Q: How accurate is the simulation?**
A: It uses real Polymarket API data but simulates execution (no slippage/fees).

**Q: Can I add real trading?**
A: Yes, this is designed to be extended. See "Next Steps for Production".

**Q: How do I add my own markets to monitor?**
A: Edit the market filtering in `server.js` `detectArbitrageOpportunities()` function.

---

## 🤝 Support

For issues or questions, check:
1. Browser console (F12) for errors
2. Server logs in terminal
3. Polymarket API status: https://polymarket.com

---

**Happy trading! 🚀📈**
