import assert from 'node:assert/strict';
import test from 'node:test';

import { RssChannelFeedAdapter, RssNewsSourceAdapter, parseChannelFeed, parseNewsFeed } from '../src/rss.js';

const NEWS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <item>
    <title>Moisés Caicedo anota en Chelsea - Diario Deportivo</title>
    <link>https://news.example.local/nota/1</link>
    <guid>https://news.example.local/nota/1</guid>
    <pubDate>Wed, 12 Nov 2026 10:00:00 GMT</pubDate>
    <description><![CDATA[<p>El mediocampista marcó y fue figura.</p>]]></description>
  </item>
  <item>
    <title>Sin enlace se descarta</title>
    <pubDate>Wed, 12 Nov 2026 10:00:00 GMT</pubDate>
  </item>
</channel></rss>`;

const CHANNEL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015">
  <title>Canal Demo</title>
  <entry>
    <id>yt:video:abc123</id>
    <yt:videoId>abc123</yt:videoId>
    <yt:channelId>UCdemo</yt:channelId>
    <title>Resumen del partido</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=abc123"/>
    <published>2026-11-12T11:00:00+00:00</published>
  </entry>
</feed>`;

test('parseNewsFeed maps Google News RSS fields to the n8n news shape', () => {
  const rows = parseNewsFeed(NEWS_XML, {
    jugador: 'Moisés Caicedo',
    seleccion: 'Ecuador',
    source_kind: 'google_news_rss',
    source_name: 'Google News RSS',
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].jugador, 'Moisés Caicedo');
  assert.equal(rows[0].seleccion, 'Ecuador');
  assert.equal(rows[0].titular, 'Moisés Caicedo anota en Chelsea');
  assert.equal(rows[0].fuente, 'Diario Deportivo');
  assert.equal(rows[0].fuente_origen, 'google_news_rss');
  assert.equal(rows[0].estado_revision, 'pendiente');
  assert.equal(rows[0].snippet, 'El mediocampista marcó y fue figura.');
  assert.match(rows[0].id_noticia, /^Moisés Caicedo-2026-11-12-/);
});

test('RssNewsSourceAdapter fetches the request feed_url and rejects HTTP failures', async () => {
  const urls = [];
  const adapter = new RssNewsSourceAdapter({
    fetchImpl: async (url) => {
      urls.push(url);
      return { ok: true, status: 200, async text() { return NEWS_XML; } };
    },
  });

  const rows = await adapter.fetchFeed({ feed_url: 'https://news.example.local/rss', jugador: 'Piero Hincapié' });
  assert.equal(urls[0], 'https://news.example.local/rss');
  assert.equal(rows[0].jugador, 'Piero Hincapié');

  const failing = new RssNewsSourceAdapter({
    fetchImpl: async () => ({ ok: false, status: 502, async text() { return ''; } }),
  });
  await assert.rejects(() => failing.fetchFeed({ feed_url: 'https://news.example.local/rss' }), /RSS request failed/);
});

test('parseChannelFeed and RssChannelFeedAdapter read the public YouTube feed', async () => {
  const parsed = parseChannelFeed(CHANNEL_XML, { channelId: 'UCdemo' });
  assert.equal(parsed.title, 'Canal Demo');
  assert.equal(parsed.videos[0].videoId, 'abc123');
  assert.equal(parsed.videos[0].publishedAt, '2026-11-12T11:00:00+00:00');

  const adapter = new RssChannelFeedAdapter({
    fetchImpl: async (url) => {
      assert.equal(url, 'https://www.youtube.com/feeds/videos.xml?channel_id=UCdemo');
      return { ok: true, status: 200, async text() { return CHANNEL_XML; } };
    },
  });
  const channel = await adapter.fetchChannel({ channelId: 'UCdemo' });
  assert.equal(channel.channelId, 'UCdemo');
  assert.equal(channel.videos.length, 1);
});
