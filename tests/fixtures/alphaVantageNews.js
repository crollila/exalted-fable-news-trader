// tests/fixtures/alphaVantageNews.js — Static Alpha Vantage NEWS_SENTIMENT
// fixture entries. Field names/shapes mirror real responses, including
// compact UTC timestamps and ticker_sentiment arrays. No network involved.

export const ALPHA_VANTAGE_NEWS_FIXTURES = [
  {
    title: 'Apple Supplier Ramps Production Ahead Of Launch',
    url: 'https://www.example-news.com/apple-supplier-ramp',
    time_published: '20260609T133000', // = 2026-06-09T13:30:00Z
    authors: ['Jane Reporter', 'Co Author'],
    summary: 'Suppliers are increasing output ahead of the fall launch.',
    banner_image: 'https://www.example-news.com/img.jpg',
    source: 'Example News',
    category_within_source: 'Technology',
    source_domain: 'www.example-news.com',
    topics: [{ topic: 'Earnings', relevance_score: '0.6' }],
    overall_sentiment_score: 0.31,
    overall_sentiment_label: 'Somewhat-Bullish',
    ticker_sentiment: [
      {
        ticker: 'AAPL',
        relevance_score: '0.85',
        ticker_sentiment_score: '0.42',
        ticker_sentiment_label: 'Bullish',
      },
    ],
  },
  {
    title: 'Energy Names Slip As Crude Retreats',
    url: 'https://www.example-news.com/energy-slip',
    time_published: '20260609T141500', // = 2026-06-09T14:15:00Z
    authors: ['Sam Writer'],
    summary: 'Oil prices fell, dragging energy shares lower.',
    banner_image: '',
    source: 'Example News',
    category_within_source: 'Markets',
    source_domain: 'www.example-news.com',
    topics: [],
    overall_sentiment_score: -0.18,
    overall_sentiment_label: 'Somewhat-Bearish',
    ticker_sentiment: [
      { ticker: 'XOM', relevance_score: '0.7', ticker_sentiment_score: '-0.2', ticker_sentiment_label: 'Somewhat-Bearish' },
      { ticker: 'CVX', relevance_score: '0.6', ticker_sentiment_score: '-0.15', ticker_sentiment_label: 'Somewhat-Bearish' },
    ],
  },
  {
    // Minimal item: empty authors/summary/category, single ticker.
    title: 'Boeing Receives Routine Certification Update',
    url: 'https://www.example-news.com/boeing-cert',
    time_published: '20260609T150000', // = 2026-06-09T15:00:00Z
    authors: [],
    summary: '',
    banner_image: '',
    source: 'Example News',
    category_within_source: '',
    source_domain: 'www.example-news.com',
    topics: [],
    overall_sentiment_score: 0.02,
    overall_sentiment_label: 'Neutral',
    ticker_sentiment: [
      { ticker: 'BA', relevance_score: '0.9', ticker_sentiment_score: '0.0', ticker_sentiment_label: 'Neutral' },
    ],
  },
];
