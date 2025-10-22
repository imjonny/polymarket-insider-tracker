const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { ethers } = require('ethers');

const app = express();
app.use(cors());
app.use(express.json());

// Configuration
const CONFIG = {
  DISCORD_WEBHOOK: process.env.DISCORD_WEBHOOK || '',
  MIN_BET_AMOUNT: parseFloat(process.env.MIN_BET_AMOUNT) || 10000,
  NEW_ACCOUNT_DAYS: parseInt(process.env.NEW_ACCOUNT_DAYS) || 7,
  CHECK_INTERVAL: parseInt(process.env.CHECK_INTERVAL) || 30000, // 30 seconds
  POLYGON_RPC: process.env.POLYGON_RPC || 'https://polygon-rpc.com',
};

// Polymarket CTF Exchange contract address on Polygon
const CTF_EXCHANGE_ADDRESS = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';

// Simplified ABI for the events we care about
const CTF_EXCHANGE_ABI = [
  'event OrderFilled(bytes32 indexed orderHash, address indexed maker, address indexed taker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)',
  'event OrdersMatched(bytes32 indexed takerOrderHash, address indexed takerOrderMaker, uint256 makerAssetId, uint256 takerAssetId, uint256 makerAmountFilled, uint256 takerAmountFilled, uint256 fee)'
];

// In-memory stores
const alertedTrades = new Set();
const walletFirstSeen = new Map();
const MAX_STORED_ALERTS = 5000;

// Polymarket API for market info
const GAMMA_API = 'https://gamma-api.polymarket.com';

let provider;
let ctfContract;
let lastProcessedBlock = 0;

console.log('🚀 Polymarket Insider Trading Tracker - BLOCKCHAIN EDITION');
console.log('⚙️  Min bet amount: $' + CONFIG.MIN_BET_AMOUNT.toLocaleString());
console.log('⏱️  New account threshold: ' + CONFIG.NEW_ACCOUNT_DAYS + ' days');
console.log('🔔 Discord alerts: ' + (CONFIG.DISCORD_WEBHOOK ? '✅ ENABLED' : '❌ DISABLED'));

/**
 * Initialize blockchain connection
 */
async function initBlockchain() {
  try {
    provider = new ethers.JsonRpcProvider(CONFIG.POLYGON_RPC);
    ctfContract = new ethers.Contract(CTF_EXCHANGE_ADDRESS, CTF_EXCHANGE_ABI, provider);
    
    const currentBlock = await provider.getBlockNumber();
    lastProcessedBlock = currentBlock; // Start from NOW, not historical blocks
    
    console.log('⛓️  Connected to Polygon blockchain');
    console.log(`📦 Starting from current block ${lastProcessedBlock} (no historical data)`);
    return true;
  } catch (error) {
    console.error('❌ Failed to connect to blockchain:', error.message);
    return false;
  }
}

/**
 * Check wallet age on blockchain
 */
async function checkWalletAge(address) {
  try {
    // Check if we've seen this wallet before
    if (walletFirstSeen.has(address)) {
      const firstSeenTime = walletFirstSeen.get(address);
      const ageInDays = Math.floor((Date.now() - firstSeenTime) / (1000 * 60 * 60 * 24));
      return {
        isNew: ageInDays <= CONFIG.NEW_ACCOUNT_DAYS,
        ageInDays: ageInDays,
        description: ageInDays === 0 ? '🆕 Brand New - First Trade Today!' : `🆕 ${ageInDays} days old`
      };
    }

    // Get wallet's transaction history to determine age
    const txCount = await provider.getTransactionCount(address);
    
    // If very few transactions, likely a new wallet
    if (txCount <= 10) {
      // Try to find first transaction
      try {
        // Search recent blocks for first appearance
        const currentBlock = await provider.getBlockNumber();
        const blocksToSearch = Math.min(10000, currentBlock); // Search up to 10k blocks back (~5 hours on Polygon)
        
        let firstTxBlock = currentBlock;
        
        // Binary search for first transaction (approximate)
        for (let i = 0; i < 5; i++) {
          const midBlock = Math.floor((currentBlock - blocksToSearch + firstTxBlock) / 2);
          const balance = await provider.getBalance(address, midBlock);
          if (balance > 0) {
            firstTxBlock = midBlock;
          }
        }
        
        const block = await provider.getBlock(firstTxBlock);
        const firstSeenTimestamp = block.timestamp * 1000;
        const ageInMs = Date.now() - firstSeenTimestamp;
        const ageInDays = Math.floor(ageInMs / (1000 * 60 * 60 * 24));
        
        // Store for future reference
        walletFirstSeen.set(address, firstSeenTimestamp);
        
        return {
          isNew: ageInDays <= CONFIG.NEW_ACCOUNT_DAYS,
          ageInDays: ageInDays,
          description: ageInDays === 0 ? '🆕 Brand New - First Trade Today!' : `🆕 ${ageInDays} days old`
        };
      } catch (err) {
        // If we can't determine age precisely, mark as potentially new
        return {
          isNew: true,
          ageInDays: 0,
          description: '🆕 New Wallet (Low Transaction Count)'
        };
      }
    }
    
    // Wallet has many transactions, likely not new
    return {
      isNew: false,
      ageInDays: 999,
      description: `Established wallet (${txCount} transactions)`
    };
    
  } catch (error) {
    console.error(`⚠️  Error checking wallet age for ${address}:`, error.message);
    // On error, assume it might be new to be safe
    return {
      isNew: true,
      ageInDays: 0,
      description: '🆕 Unknown Age (Error checking blockchain)'
    };
  }
}

/**
 * Get market info from condition ID
 */
async function getMarketByConditionId(conditionId) {
  try {
    const response = await axios.get(`${GAMMA_API}/markets`, {
      params: {
        condition_id: conditionId,
        limit: 1
      },
      timeout: 10000
    });
    
    if (response.data && response.data.length > 0) {
      return response.data[0];
    }
    return null;
  } catch (error) {
    return null;
  }
}

/**
 * Convert asset ID to readable outcome (YES/NO)
 */
function getOutcomeFromAssetId(assetId) {
  // In Polymarket's CTF, asset IDs encode the position
  // This is a simplified version - the actual mapping is more complex
  const assetIdStr = assetId.toString();
  const lastDigit = parseInt(assetIdStr[assetIdStr.length - 1]);
  
  // Even = NO, Odd = YES (simplified heuristic)
  return lastDigit % 2 === 0 ? 'NO ❌' : 'YES ✅';
}

/**
 * Send Discord alert
 */
async function sendDiscordAlert(tradeData, walletInfo, market) {
  if (!CONFIG.DISCORD_WEBHOOK) {
    return;
  }

  try {
    const marketUrl = market && market.slug 
      ? `https://polymarket.com/event/${market.slug}`
      : 'https://polymarket.com';
    
    const marketTitle = market 
      ? (market.question || market.title || 'Unknown Market')
      : 'Unknown Market (Check Polymarket)';

    const embed = {
      title: '🚨 POTENTIAL INSIDER TRADING DETECTED',
      description: 'Large bet from a brand new wallet detected on-chain!',
      color: 0xFF0000,
      fields: [
        {
          name: '📊 Market',
          value: marketTitle,
          inline: false
        },
        {
          name: '💰 Bet Amount',
          value: `$${tradeData.amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
          inline: true
        },
        {
          name: '🎯 Position',
          value: tradeData.outcome,
          inline: true
        },
        {
          name: '👤 Wallet Age',
          value: walletInfo.description,
          inline: false
        },
        {
          name: '🔗 Wallet Address',
          value: `[${tradeData.wallet.slice(0, 6)}...${tradeData.wallet.slice(-4)}](https://polygonscan.com/address/${tradeData.wallet})`,
          inline: false
        },
        {
          name: '🔗 Market Link',
          value: `[View Market](${marketUrl})`,
          inline: false
        }
      ],
      timestamp: new Date().toISOString(),
      footer: {
        text: 'Polymarket Insider Trading Tracker • On-Chain Detection'
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
 * Process blockchain events
 */
async function processBlockchainEvents() {
  try {
    const currentBlock = await provider.getBlockNumber();
    
    if (currentBlock <= lastProcessedBlock) {
      console.log('📦 No new blocks to process');
      return;
    }

    // Limit scan to max 50 blocks at a time to avoid "block range too large" error
    const maxBlockRange = 50;
    const toBlock = Math.min(currentBlock, lastProcessedBlock + maxBlockRange);

    console.log(`🔍 Scanning blocks ${lastProcessedBlock + 1} to ${toBlock}...`);

    // Query OrderFilled events
    const orderFilledFilter = ctfContract.filters.OrderFilled();
    const events = await ctfContract.queryFilter(
      orderFilledFilter,
      lastProcessedBlock + 1,
      toBlock
    );

    console.log(`📊 Found ${events.length} trades in ${toBlock - lastProcessedBlock} blocks`);

    for (const event of events) {
      try {
        const { maker, makerAssetId, makerAmountFilled, orderHash } = event.args;
        
        // Calculate trade amount (simplified - assumes $0.50 average price)
        // In reality, you'd need to calculate from makerAmountFilled and price
        const tradeAmount = parseFloat(ethers.formatUnits(makerAmountFilled, 6)); // USDC has 6 decimals
        
        // Check if meets minimum
        if (tradeAmount < CONFIG.MIN_BET_AMOUNT) continue;

        // Create a more robust unique identifier to prevent duplicates
        // Combines: wallet + amount (rounded to nearest 100) + asset + date
        const today = new Date().toISOString().split('T')[0];
        const roundedAmount = Math.floor(tradeAmount / 100) * 100;
        const alertKey = `${maker.toLowerCase()}-${roundedAmount}-${makerAssetId.toString().slice(-8)}-${today}`;
        
        // Check if already alerted using the new key
        if (alertedTrades.has(alertKey)) {
          console.log(`   ↳ Skipping: Already alerted for this trade today`);
          continue;
        }

        console.log(`💵 Large trade detected: $${tradeAmount.toLocaleString()} from ${maker.slice(0, 6)}...${maker.slice(-4)}`);

        // Check wallet age
        const walletInfo = await checkWalletAge(maker);
        
        if (!walletInfo.isNew) {
          console.log(`   ↳ Skipping: Wallet is ${walletInfo.ageInDays} days old (not new enough)`);
          continue;
        }

        console.log(`🚨 NEW WALLET LARGE TRADE: $${tradeAmount.toLocaleString()} - ${walletInfo.description}`);

        // Get market info and validate it's active
        const conditionId = makerAssetId.toString().slice(0, 66); // Approximate condition ID extraction
        const market = await getMarketByConditionId(conditionId);

        // Skip if market is closed, resolved, or doesn't exist
        if (!market) {
          console.log(`   ↳ Skipping: Could not find market info`);
          continue;
        }
        
        if (market.closed === true || market.active === false) {
          console.log(`   ↳ Skipping: Market is closed or inactive`);
          continue;
        }

        // Prepare trade data
        const tradeData = {
          wallet: maker,
          amount: tradeAmount,
          outcome: getOutcomeFromAssetId(makerAssetId),
          orderHash: orderHash
        };

        // Send alert
        await sendDiscordAlert(tradeData, walletInfo, market);

        // Mark as alerted using the composite key
        alertedTrades.add(alertKey);

        // Prevent memory leak
        if (alertedTrades.size > MAX_STORED_ALERTS) {
          const firstItem = alertedTrades.values().next().value;
          alertedTrades.delete(firstItem);
        }

        // Rate limit
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (err) {
        console.error('⚠️  Error processing event:', err.message);
      }
    }

    lastProcessedBlock = toBlock;
    console.log('✅ Scan complete');

  } catch (error) {
    console.error('❌ Error scanning blockchain:', error.message);
  }
}

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    uptime: Math.floor(process.uptime()),
    lastBlock: lastProcessedBlock,
    config: {
      minBetAmount: CONFIG.MIN_BET_AMOUNT,
      newAccountDays: CONFIG.NEW_ACCOUNT_DAYS,
      discordEnabled: !!CONFIG.DISCORD_WEBHOOK
    },
    stats: {
      alertsSent: alertedTrades.size,
      walletsTracked: walletFirstSeen.size
    }
  });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🌐 Server running on port ${PORT}`);
  
  const connected = await initBlockchain();
  
  if (connected) {
    console.log('⏱️  Waiting for next block before monitoring...');
    console.log('⏱️  This ensures we only catch completely NEW trades');
    
    // Wait for next block to ensure we skip any in-progress transactions
    const startBlock = await provider.getBlockNumber();
    
    const waitForNextBlock = setInterval(async () => {
      const currentBlock = await provider.getBlockNumber();
      if (currentBlock > startBlock) {
        clearInterval(waitForNextBlock);
        lastProcessedBlock = currentBlock;
        console.log(`🎯 New block detected! Starting monitoring from block ${currentBlock}...`);
        
        processBlockchainEvents();
        
        // Scan every CHECK_INTERVAL
        setInterval(processBlockchainEvents, CONFIG.CHECK_INTERVAL);
      }
    }, 3000); // Check every 3 seconds
  } else {
    console.error('❌ Failed to initialize blockchain connection');
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('👋 Shutting down...');
  process.exit(0);
});
