const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Configuration from environment variables
const CONFIG = {
  DISCORD_WEBHOOK: process.env.DISCORD_WEBHOOK || '',
  MIN_BET_AMOUNT: parseFloat(process.env.MIN_BET_AMOUNT) || 10000,
  NEW_ACCOUNT_DAYS: parseInt(process.env.NEW_ACCOUNT_DAYS) || 7,
  CHECK_INTERVAL: parseInt(process.env.CHECK_INTERVAL) || 60000, // 60 seconds
};

// In-memory store to prevent duplicate alerts
const alertedOrders = new Set();
const MAX_STORED_ALERTS = 10000;

// Polymarket API endpoints
const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';

console.log('🚀 Polymarket Insider Trading Tracker Started');
console.log('⚙️  Min bet amount: $' + CONFIG.MIN_BET_AMOUNT.toLocaleString());
console.log('⏱️  New account threshold: ' + CONFIG.NEW_ACCOUNT_DAYS + ' days');
console.log('🔔 Discord alerts: ' + (CONFIG.DISCORD_WEBHOOK ? '✅ ENABLED' : '❌ DISABLED'));

/**
 * Fetch active markets from Polymarket
 */
async function getActiveMarkets() {
  try {
    const response = await axios.get(`${GAMMA_API}/markets`, {
      params: {
        limit: 100,
        closed: false,
        active: true
      },
      timeout: 10000
    });
    return response.data || [];
  } catch (error) {
    console.error('⚠️  Error fetching markets:', error.message);
    return [];
  }
}

/**
 * Fetch recent trades for a specific market
 */
async function getMarketTrades(conditionId) {
  try {
    const response = await axios.get(`${CLOB_API}/trades`, {
      params: {
        market: conditionId,
        limit: 20
      },
      timeout: 10000
    });
    return response.data || [];
  } catch (error) {
    console.error('⚠️  Error fetching trades:', error.message);
    return [];
  }
}

/**
 * Get user information from Polymarket
 */
async function getUserInfo(address) {
  try {
    const response = await axios.get(`${GAMMA_API}/users/${address}`, {
      timeout: 10000
    });
    return response.data;
  } catch (error) {
    return null;
  }
}

/**
 * Check if account is new (within threshold)
 */
function checkAccountAge(userData) {
  if (!userData || !userData.createdAt) {
    return { isNew: true, description: 'Unknown (No creation date)' };
  }

  try {
    const createdAt = userData.createdAt;
    const createdDate = new Date(createdAt > 10000000000 ? createdAt : createdAt * 1000);
    const now = new Date();
    const ageInDays = Math.floor((now - createdDate) / (1000 * 60 * 60 * 24));

    if (ageInDays <= CONFIG.NEW_ACCOUNT_DAYS) {
      if (ageInDays === 0) {
        return { isNew: true, description: '🆕 Brand New Account - Created Today!' };
      } else if (ageInDays === 1) {
        return { isNew: true, description: '🆕 New Account - Created Yesterday' };
      } else {
        return { isNew: true, description: `🆕 New Account - ${ageInDays} days old` };
      }
    } else {
      return { isNew: false, description: `Account age: ${ageInDays} days` };
    }
  } catch (error) {
    return { isNew: true, description: 'Unknown (Error parsing date)' };
  }
}

/**
 * Send alert to Discord
 */
async function sendDiscordAlert(market, trade, userData, accountAgeDesc) {
  if (!CONFIG.DISCORD_WEBHOOK) {
    console.log('⚠️  Discord webhook not configured, skipping alert');
    return;
  }

  try {
    // Determine YES or NO position
    const outcome = trade.outcome || trade.asset_id || '';
    let position = 'UNKNOWN';
    
    if (outcome.toLowerCase().includes('yes') || outcome === '1') {
      position = 'YES ✅';
    } else if (outcome.toLowerCase().includes('no') || outcome === '0') {
      position = 'NO ❌';
    }

    // Calculate bet amount
    const price = parseFloat(trade.price || 0);
    const size = parseFloat(trade.size || 0);
    const betAmount = price * size;

    // Create market URL
    const marketSlug = market.slug || market.market_slug || '';
    const marketUrl = marketSlug ? `https://polymarket.com/event/${marketSlug}` : 'N/A';

    // Build Discord embed
    const embed = {
      title: '🚨 POTENTIAL INSIDER TRADING DETECTED',
      color: 0xFF0000, // Red color
      fields: [
        {
          name: '📊 Market',
          value: market.question || market.title || 'Unknown Market',
          inline: false
        },
        {
          name: '💰 Bet Amount',
          value: `$${betAmount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
          inline: true
        },
        {
          name: '🎯 Position',
          value: position,
          inline: true
        },
        {
          name: '👤 Account Age',
          value: accountAgeDesc,
          inline: false
        },
        {
          name: '🔗 Market Link',
          value: marketUrl !== 'N/A' ? `[View Market](${marketUrl})` : 'N/A',
          inline: false
        }
      ],
      timestamp: new Date().toISOString(),
      footer: {
        text: 'Polymarket Insider Trading Tracker'
      }
    };

    await axios.post(CONFIG.DISCORD_WEBHOOK, {
      embeds: [embed]
    });

    console.log('✅ Alert sent to Discord');
  } catch (error) {
    console.error('❌ Error sending Discord alert:', error.message);
  }
}

/**
 * Main monitoring function
 */
async function monitorMarkets() {
  console.log('🔍 Checking for suspicious activity...');

  const markets = await getActiveMarkets();
  console.log(`📊 Found ${markets.length} active markets`);

  for (const market of markets.slice(0, 20)) { // Check top 20 markets to avoid rate limits
    try {
      const conditionId = market.condition_id || market.conditionId;
      if (!conditionId) continue;

      const trades = await getMarketTrades(conditionId);

      for (const trade of trades) {
        const tradeId = trade.id || trade.trade_id;
        if (!tradeId || alertedOrders.has(tradeId)) continue;

        // Calculate trade size
        const price = parseFloat(trade.price || 0);
        const size = parseFloat(trade.size || 0);
        const tradeAmount = price * size;

        // Check if trade meets minimum amount
        if (tradeAmount < CONFIG.MIN_BET_AMOUNT) continue;

        console.log(`💵 Large trade detected: $${tradeAmount.toLocaleString()} on ${market.question || 'Unknown'}`);

        // Get user info
        const userAddress = trade.maker_address || trade.maker || trade.user;
        if (!userAddress) continue;

        const userData = await getUserInfo(userAddress);
        const accountAge = checkAccountAge(userData);

        // Only alert on new accounts
        if (accountAge.isNew) {
          console.log(`🚨 NEW ACCOUNT LARGE TRADE: $${tradeAmount.toLocaleString()}`);

          // Send Discord alert
          await sendDiscordAlert(market, trade, userData, accountAge.description);

          // Mark as alerted
          alertedOrders.add(tradeId);

          // Prevent memory leak by limiting stored alerts
          if (alertedOrders.size > MAX_STORED_ALERTS) {
            const firstItem = alertedOrders.values().next().value;
            alertedOrders.delete(firstItem);
          }
        }

        // Small delay to avoid rate limits
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Delay between markets
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error) {
      console.error(`⚠️  Error processing market:`, error.message);
    }
  }

  console.log('✅ Scan complete');
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    config: {
      minBetAmount: CONFIG.MIN_BET_AMOUNT,
      newAccountDays: CONFIG.NEW_ACCOUNT_DAYS,
      discordEnabled: !!CONFIG.DISCORD_WEBHOOK
    },
    alertsTracked: alertedOrders.size
  });
});

// Status endpoint
app.get('/status', (req, res) => {
  res.json({
    running: true,
    alertsTracked: alertedOrders.size,
    uptime: process.uptime()
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Server running on port ${PORT}`);
  console.log(`📊 Monitoring starting in 10 seconds...`);

  // Start monitoring after a short delay
  setTimeout(() => {
    monitorMarkets();
    // Run checks at the configured interval
    setInterval(monitorMarkets, CONFIG.CHECK_INTERVAL);
  }, 10000);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 Shutting down gracefully...');
  process.exit(0);
});
