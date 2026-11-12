import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { RssChannelFeedAdapter, RssNewsSourceAdapter, parseChannelFeed, parseNewsFeed } from '../src/rss.js';

const NEWS_XML = readFileSync(new URL('../../test-fixtures/rss/google-news-feed.xml', import.meta.url), 'utf8');

const CHANNEL_XML = readFileSync(new URL('../../test-fixtures/rss/youtube-channel-feed.xml', import.meta.url), 'utf8');

test('parseNewsFeed maps Google News RSS fields to the n8n news shape', () => {
  const rows = parseNewsFeed(NEWS_XML, {
    jugador: 'Nicolás Arbelo',
    seleccion: 'Aurenia',
    source_kind: 'google_news_rss',
    source_name: 'Google News RSS',
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].jugador, 'Nicolás Arbelo');
  assert.equal(rows[0].seleccion, 'Aurenia');
  assert.equal(rows[0].titular, 'Nicolás Arbelo anota en Costa Azul FC');
  assert.equal(rows[0].fuente, 'Diario Deportivo');
  assert.equal(rows[0].fuente_origen, 'google_news_rss');
  assert.equal(rows[0].estado_revision, 'pendiente');
  assert.equal(rows[0].snippet, 'El mediocampista marcó y fue figura.');
  assert.match(rows[0].id_noticia, /^Nicolás Arbelo-2026-11-12-/);
});

test('RssNewsSourceAdapter fetches the request feed_url and rejects HTTP failures', async () => {
  const urls = [];
  const adapter = new RssNewsSourceAdapter({
    fetchImpl: async (url) => {
      urls.push(url);
      return { ok: true, status: 200, async text() { return NEWS_XML; } };
    },
  });

  const rows = await adapter.fetchFeed({ feed_url: 'https://news.example.local/rss', jugador: 'Mateo Salvatierra' });
  assert.equal(urls[0], 'https://news.example.local/rss');
  assert.equal(rows[0].jugador, 'Mateo Salvatierra');

  const failing = new RssNewsSourceAdapter({
    fetchImpl: async () => ({ ok: false, status: 502, async text() { return ''; } }),
  });
  await assert.rejects(() => failing.fetchFeed({ feed_url: 'https://news.example.local/rss' }), /RSS request failed/);
});

test('parseChannelFeed and RssChannelFeedAdapter read the public YouTube feed', async () => {
  const parsed = parseChannelFeed(CHANNEL_XML, { channelId: 'UCdemo' });
  assert.equal(parsed.title, 'Demo Sports News');
  assert.equal(parsed.videos[0].videoId, 'video-1');
  assert.equal(parsed.videos[0].publishedAt, '2026-01-01T10:00:00+00:00');

  const adapter = new RssChannelFeedAdapter({
    fetchImpl: async (url) => {
      assert.equal(url, 'https://www.youtube.com/feeds/videos.xml?channel_id=UCdemo');
      return { ok: true, status: 200, async text() { return CHANNEL_XML; } };
    },
  });
  const channel = await adapter.fetchChannel({ channelId: 'UCdemo' });
  assert.equal(channel.channelId, 'UCdemo');
  assert.equal(channel.videos.length, 2);
});
