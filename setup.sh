#!/bin/bash

# Polymarket Arbitrage Bot - Quick Start Script

echo "╔════════════════════════════════════════════╗"
echo "║   Polymarket Arbitrage Bot - Setup         ║"
echo "╚════════════════════════════════════════════╝"
echo ""

# Check if Node.js is installed
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not installed"
    echo "   Please install Node.js from https://nodejs.org"
    exit 1
fi

echo "✅ Node.js detected: $(node --version)"
echo "✅ npm detected: $(npm --version)"
echo ""

# Install dependencies
echo "📦 Installing dependencies..."
npm install

if [ $? -ne 0 ]; then
    echo "❌ Failed to install dependencies"
    exit 1
fi

echo ""
echo "✅ Dependencies installed successfully!"
echo ""
echo "╔════════════════════════════════════════════╗"
echo "║   Setup Complete!                         ║"
echo "╚════════════════════════════════════════════╝"
echo ""
echo "🚀 To start the bot, run:"
echo "   npm start"
echo ""
echo "📊 The dashboard will be available at:"
echo "   http://localhost:3000"
echo ""
echo "💡 Tips:"
echo "   - Click 'Start Bot' to begin monitoring markets"
echo "   - Check the dashboard for real-time updates"
echo "   - View trades in the table below the charts"
echo "   - Use 'Stop Bot' to pause monitoring"
echo "   - Use 'Reset' to start with fresh $50 balance"
echo ""
