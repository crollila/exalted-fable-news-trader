// tests/fixtures/polygonNews.js — Static Polygon /v2/reference/news fixture
// items. Field names/shapes mirror real Polygon responses, including string
// hash ids, publisher objects, and insights sentiment. No network involved.

export const POLYGON_NEWS_FIXTURES = [
  {
    id: '8ec638777ca03b553ae516761c2a22ba2fdd2f37befae3ab6fdab74e9e5193eb',
    publisher: {
      name: 'Example Wire',
      homepage_url: 'https://www.example-wire.com',
      logo_url: 'https://www.example-wire.com/logo.png',
      favicon_url: 'https://www.example-wire.com/favicon.ico',
    },
    title: 'Apple Expands Services Revenue With New Bundle',
    author: 'Jane Reporter',
    published_utc: '2026-06-09T13:30:00Z',
    article_url: 'https://www.example-wire.com/apple-services-bundle',
    tickers: ['AAPL'],
    image_url: 'https://www.example-wire.com/apple.jpg',
    description: 'Apple introduced a new services bundle aimed at families.',
    keywords: ['services', 'subscription'],
    insights: [
      {
        ticker: 'AAPL',
        sentiment: 'positive',
        sentiment_reasoning: 'New bundle expected to grow recurring revenue.',
      },
    ],
  },
  {
    id: '5b1c9a447de0e6f17b8a36577cf2b9e88a51d8e4a1b7d2c3e4f5061728394a5b',
    publisher: { name: 'Example Wire' },
    title: 'Banks Climb After Stress Test Results',
    author: 'Sam Writer',
    published_utc: '2026-06-09T14:15:00Z',
    article_url: 'https://www.example-wire.com/bank-stress-tests',
    tickers: ['JPM', 'BAC'],
    image_url: '',
    description: 'Major banks rose after passing annual stress tests.',
    keywords: ['banking'],
    insights: [
      { ticker: 'JPM', sentiment: 'positive', sentiment_reasoning: 'Passed with margin.' },
      { ticker: 'BAC', sentiment: 'neutral', sentiment_reasoning: 'In-line result.' },
    ],
  },
  {
    // Minimal item: empty author/description/keywords, single ticker.
    id: 'c0ffee1234abcd5678ef901234567890aabbccddeeff00112233445566778899',
    publisher: { name: 'Example Wire' },
    title: 'Delta Updates Fleet Schedule',
    author: '',
    published_utc: '2026-06-09T15:00:00Z',
    article_url: 'https://www.example-wire.com/delta-fleet',
    tickers: ['DAL'],
    image_url: '',
    description: '',
    keywords: [],
    insights: [],
  },
];
