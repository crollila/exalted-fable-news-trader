// tests/fixtures/alpacaNews.js — Static Alpaca News API v1beta1 fixture items.
// Field names and shapes mirror real Alpaca news responses. No network involved.

export const ALPACA_NEWS_FIXTURES = [
  {
    id: 24843171,
    headline: 'Apple Unveils New Product Line at March Event',
    author: 'Jane Reporter',
    created_at: '2026-06-09T13:30:00Z',
    updated_at: '2026-06-09T13:35:00Z',
    summary: 'Apple announced several new products at its spring event.',
    content: '<p>Apple announced several new products today, including...</p>',
    url: 'https://www.benzinga.com/news/apple-march-event',
    symbols: ['AAPL'],
    source: 'benzinga',
  },
  {
    id: 24843502,
    headline: 'Microsoft And Nvidia Expand AI Partnership',
    author: 'Sam Writer',
    created_at: '2026-06-09T14:05:00Z',
    updated_at: '2026-06-09T14:05:00Z',
    summary: 'The companies will collaborate on datacenter infrastructure.',
    content: '',
    url: 'https://www.benzinga.com/news/msft-nvda-ai',
    symbols: ['MSFT', 'NVDA'],
    source: 'benzinga',
  },
  {
    // Minimal item: no author, no summary/content, single symbol.
    id: 24843777,
    headline: 'Tesla Schedules Annual Shareholder Meeting',
    author: '',
    created_at: '2026-06-09T15:00:00Z',
    updated_at: '2026-06-09T15:00:00Z',
    summary: '',
    content: '',
    url: 'https://www.benzinga.com/news/tsla-meeting',
    symbols: ['TSLA'],
    source: 'benzinga',
  },
];
