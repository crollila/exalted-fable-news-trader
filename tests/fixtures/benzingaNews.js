// tests/fixtures/benzingaNews.js — Static Benzinga newsfeed API fixture items.
// Field names/shapes mirror real Benzinga responses, including RFC-2822
// timestamps with timezone offsets and object-wrapped stocks/channels.
// No network involved.

export const BENZINGA_NEWS_FIXTURES = [
  {
    id: 38291444,
    author: 'Benzinga Newsdesk',
    created: 'Tue, 09 Jun 2026 09:30:00 -0400', // = 2026-06-09T13:30:00Z
    updated: 'Tue, 09 Jun 2026 09:32:00 -0400',
    title: 'Apple Raises Guidance After Strong Quarter',
    teaser: 'Apple lifted its full-year outlook following better-than-expected results.',
    body: '<p>Apple Inc. raised its guidance for the fiscal year...</p>',
    url: 'https://www.benzinga.com/news/apple-guidance',
    channels: [{ name: 'News' }, { name: 'Guidance' }],
    stocks: [{ name: 'AAPL' }],
    tags: [{ name: 'earnings' }],
  },
  {
    id: 38291890,
    author: 'Sam Analyst',
    created: 'Tue, 09 Jun 2026 10:15:00 -0400', // = 2026-06-09T14:15:00Z
    updated: 'Tue, 09 Jun 2026 10:15:00 -0400',
    title: 'Chipmakers Rally On Datacenter Demand',
    teaser: 'Semiconductor names moved higher in early trading.',
    body: '<p>Shares of major chipmakers rallied...</p>',
    url: 'https://www.benzinga.com/news/chip-rally',
    channels: [{ name: 'News' }],
    stocks: [{ name: 'NVDA' }, { name: 'AMD' }],
    tags: [],
  },
  {
    // Minimal item: empty author/teaser/body, single stock, no channels.
    id: 38292001,
    author: '',
    created: 'Tue, 09 Jun 2026 11:00:00 -0400', // = 2026-06-09T15:00:00Z
    updated: 'Tue, 09 Jun 2026 11:00:00 -0400',
    title: 'Ford Files Routine Disclosure',
    teaser: '',
    body: '',
    url: 'https://www.benzinga.com/news/ford-filing',
    channels: [],
    stocks: [{ name: 'F' }],
    tags: [],
  },
];
