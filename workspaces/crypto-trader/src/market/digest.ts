#!/usr/bin/env node

interface MarketDigest {
  timestamp: string;
  fearGreedIndex: {
    value: number;
    classification: string;
    timestamp: string;
  } | null;
  bitcoinDominance: number | null;
  globalMarketCap: number | null;
  cryptoNews: Array<{
    title: string;
    url: string;
    published: string;
    source: string;
  }>;
  majorEvents: string[];
  summary: string;
}

async function fetchFearGreedIndex() {
  try {
    const response = await fetch('https://api.alternative.me/fng/?limit=1');
    const data = await response.json();
    return data.data[0];
  } catch (error) {
    console.error('Error fetching Fear & Greed index:', error);
    return null;
  }
}

async function fetchGlobalData() {
  try {
    const response = await fetch('https://api.coingecko.com/api/v3/global');
    const data = await response.json();
    return {
      btcDominance: data.data.market_cap_percentage?.btc || null,
      totalMarketCap: data.data.total_market_cap?.usd || null,
    };
  } catch (error) {
    console.error('Error fetching global data:', error);
    return { btcDominance: null, totalMarketCap: null };
  }
}

async function fetchCryptoNews(hours = 24, maxNews = 10) {
  // Simplified news - in real implementation, use NewsAPI or similar
  try {
    const fakeNews = [
      {
        title: "Bitcoin consolidates above $98,000 as markets await Fed decision",
        url: "https://example.com/news1",
        published: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
        source: "CryptoNews",
      },
      {
        title: "Ethereum sees increased institutional adoption",
        url: "https://example.com/news2", 
        published: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
        source: "CoinDesk",
      },
    ];
    
    return fakeNews.slice(0, maxNews);
  } catch (error) {
    console.error('Error fetching crypto news:', error);
    return [];
  }
}

function identifyMajorEvents() {
  const now = new Date();
  const events: string[] = [];
  
  // Check for major economic events (simplified)
  const dayOfWeek = now.getUTCDay();
  const hour = now.getUTCHours();
  
  // FOMC meetings typically on Wednesdays
  if (dayOfWeek === 3 && hour >= 14 && hour <= 16) {
    events.push("⚠️ Potential FOMC meeting time window");
  }
  
  // CPI usually first Friday of month
  if (dayOfWeek === 5 && now.getUTCDate() <= 7 && hour >= 12 && hour <= 14) {
    events.push("⚠️ Potential CPI release time window");
  }
  
  // Sunday low liquidity warning
  if (dayOfWeek === 0) {
    events.push("⚠️ Sunday - low liquidity period");
  }
  
  return events;
}

async function generateMarketDigest(hours = 24, maxNews = 10): Promise<MarketDigest> {
  console.log(`📰 Generating market digest for last ${hours} hours...`);
  
  const [fearGreed, globalData, news] = await Promise.all([
    fetchFearGreedIndex(),
    fetchGlobalData(),
    fetchCryptoNews(hours, maxNews),
  ]);
  
  const majorEvents = identifyMajorEvents();
  
  // Generate summary
  let summary = "";
  if (fearGreed) {
    const sentiment = fearGreed.value > 75 ? "extreme greed" : 
                     fearGreed.value > 55 ? "greed" :
                     fearGreed.value > 45 ? "neutral" :
                     fearGreed.value > 25 ? "fear" : "extreme fear";
    summary += `Market sentiment: ${sentiment} (${fearGreed.value}). `;
  }
  
  if (globalData.btcDominance) {
    summary += `Bitcoin dominance at ${globalData.btcDominance.toFixed(1)}%. `;
  }
  
  if (majorEvents.length > 0) {
    summary += `Major events: ${majorEvents.join(', ')}. `;
  }
  
  if (news.length > 0) {
    summary += `${news.length} news items in last ${hours} hours.`;
  }
  
  return {
    timestamp: new Date().toISOString(),
    fearGreedIndex: fearGreed,
    bitcoinDominance: globalData.btcDominance,
    globalMarketCap: globalData.totalMarketCap,
    cryptoNews: news,
    majorEvents,
    summary,
  };
}

// CLI execution
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  
  const hours = parseInt(args.find(arg => arg.startsWith('--hours='))?.split('=')[1] || '24');
  const maxNews = parseInt(args.find(arg => arg.startsWith('--max-news='))?.split('=')[1] || '10');
  
  generateMarketDigest(hours, maxNews)
    .then(digest => {
      console.log('\n📊 MARKET DIGEST:');
      console.log(JSON.stringify(digest, null, 2));
      process.exit(0);
    })
    .catch(error => {
      console.error('❌ Error:', error.message);
      process.exit(1);
    });
}

export { generateMarketDigest };