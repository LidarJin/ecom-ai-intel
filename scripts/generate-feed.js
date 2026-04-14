#!/usr/bin/env node

// ============================================================================
// Ecommerce AI Intel — Central Feed Generator
// ============================================================================
// Runs on GitHub Actions (weekly) to fetch content and publish
// feed-x.json, feed-linkedin.json, and feed-blogs.json.
//
// Deduplication: tracks previously seen post IDs/URLs
// in state-feed.json so content is never repeated across runs.
//
// Usage: node generate-feed.js [--tweets-only | --linkedin-only | --blogs-only]
// Env vars needed: BRIGHTDATA_API_TOKEN
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// -- Constants ---------------------------------------------------------------

const BRIGHTDATA_API_BASE = 'https://api.brightdata.com/datasets/v3';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TWEET_LOOKBACK_HOURS = 168; // 7 days
const LINKEDIN_LOOKBACK_HOURS = 168; // 7 days
const BLOG_LOOKBACK_HOURS = 168;  // 7 days
const MAX_POSTS_PER_USER = 5;
const MAX_ARTICLES_PER_BLOG = 5;

// Bright Data dataset IDs
const BD_TWITTER_POSTS = 'gd_lwxkxvnf1cynvib9co';    // Twitter posts (by profile URL or post URL)
const BD_TWITTER_PROFILES = 'gd_lwxmeb2u1cniijd7t4';  // Twitter profile info
const BD_LINKEDIN_POSTS = 'gd_lyy3tktm25m4avu764';    // LinkedIn posts

const SCRIPT_DIR = decodeURIComponent(new URL('.', import.meta.url).pathname);
const STATE_PATH = join(SCRIPT_DIR, '..', 'state-feed.json');

// -- State Management --------------------------------------------------------

async function loadState() {
  if (!existsSync(STATE_PATH)) {
    return { seenTweets: {}, seenLinkedin: {}, seenArticles: {} };
  }
  try {
    const state = JSON.parse(await readFile(STATE_PATH, 'utf-8'));
    if (!state.seenArticles) state.seenArticles = {};
    if (!state.seenTweets) state.seenTweets = {};
    if (!state.seenLinkedin) state.seenLinkedin = {};
    return state;
  } catch {
    return { seenTweets: {}, seenLinkedin: {}, seenArticles: {} };
  }
}

async function saveState(state) {
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
  for (const [id, ts] of Object.entries(state.seenTweets)) {
    if (ts < cutoff) delete state.seenTweets[id];
  }
  for (const [id, ts] of Object.entries(state.seenLinkedin)) {
    if (ts < cutoff) delete state.seenLinkedin[id];
  }
  for (const [id, ts] of Object.entries(state.seenArticles)) {
    if (ts < cutoff) delete state.seenArticles[id];
  }
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

// -- Load Sources ------------------------------------------------------------

async function loadSources() {
  const sourcesPath = join(SCRIPT_DIR, '..', 'config', 'default-sources.json');
  return JSON.parse(await readFile(sourcesPath, 'utf-8'));
}

// -- Bright Data helpers -----------------------------------------------------

// Trigger a Bright Data scraper and wait for results.
// Returns an array of result objects, or null on failure.
// Bright Data's flow: POST trigger → get snapshot_id → poll until ready → download
async function brightdataScrape(datasetId, inputs, apiToken, errors, label) {
  const maxPollAttempts = 20;
  const pollInterval = 15000; // 15 seconds

  try {
    // Step 1: Trigger the scraper
    const triggerRes = await fetch(
      `${BRIGHTDATA_API_BASE}/trigger?dataset_id=${datasetId}&format=json&type=discover_new&discover_by=url`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(inputs)
      }
    );

    if (!triggerRes.ok) {
      const errText = await triggerRes.text().catch(() => '');
      errors.push(`${label}: Trigger failed HTTP ${triggerRes.status}: ${errText.slice(0, 200)}`);
      return null;
    }

    const triggerData = await triggerRes.json();
    const snapshotId = triggerData.snapshot_id;
    if (!snapshotId) {
      errors.push(`${label}: No snapshot_id returned`);
      return null;
    }
    console.error(`    ${label}: triggered, snapshot_id=${snapshotId}`);

    // Step 2: Poll for completion
    for (let i = 0; i < maxPollAttempts; i++) {
      await new Promise(r => setTimeout(r, pollInterval));

      const statusRes = await fetch(
        `${BRIGHTDATA_API_BASE}/progress/${snapshotId}`,
        { headers: { 'Authorization': `Bearer ${apiToken}` } }
      );

      if (!statusRes.ok) continue;
      const statusData = await statusRes.json();
      console.error(`    ${label}: status=${statusData.status} (attempt ${i + 1})`);

      if (statusData.status === 'ready') {
        // Step 3: Download results
        const dataRes = await fetch(
          `${BRIGHTDATA_API_BASE}/snapshot/${snapshotId}?format=json`,
          { headers: { 'Authorization': `Bearer ${apiToken}` } }
        );
        if (!dataRes.ok) {
          errors.push(`${label}: Download failed HTTP ${dataRes.status}`);
          return null;
        }
        return await dataRes.json();
      }

      if (statusData.status === 'failed') {
        errors.push(`${label}: Scrape failed — ${statusData.error || 'unknown error'}`);
        return null;
      }
    }

    errors.push(`${label}: Timed out waiting for results`);
    return null;
  } catch (err) {
    errors.push(`${label}: ${err.message}`);
    return null;
  }
}

// -- X/Twitter Fetching (via Bright Data) ------------------------------------

async function fetchXContent(xAccounts, apiToken, state, errors) {
  const results = [];
  const cutoff = new Date(Date.now() - TWEET_LOOKBACK_HOURS * 60 * 60 * 1000);

  // Format dates for Bright Data: MM-DD-YYYY
  const startDate = `${String(cutoff.getMonth() + 1).padStart(2, '0')}-${String(cutoff.getDate()).padStart(2, '0')}-${cutoff.getFullYear()}`;
  const now = new Date();
  const endDate = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${now.getFullYear()}`;

  // Build inputs for Bright Data — one entry per account
  const inputs = xAccounts.map(a => ({
    url: `https://x.com/${a.handle}`,
    start_date: startDate,
    end_date: endDate
  }));

  console.error(`  Requesting tweets for ${xAccounts.length} accounts (${startDate} to ${endDate})...`);
  const rawResults = await brightdataScrape(BD_TWITTER_POSTS, inputs, apiToken, errors, 'X/Twitter');

  if (!rawResults || !Array.isArray(rawResults)) {
    console.error('  No results from Bright Data');
    return results;
  }

  console.error(`  Bright Data returned ${rawResults.length} raw posts`);

  // Group posts by user
  const byUser = {};
  for (const post of rawResults) {
    // Bright Data returns fields like: user_posted, name, description, date_posted, url, id, etc.
    const handle = post.user_posted || post.screen_name || '';
    if (!handle) continue;

    const handleLower = handle.toLowerCase();
    if (!byUser[handleLower]) {
      byUser[handleLower] = {
        name: post.name || handle,
        bio: post.description || post.user_description || '',
        posts: []
      };
    }
    byUser[handleLower].posts.push(post);
  }

  // Process each account
  for (const account of xAccounts) {
    const handleLower = account.handle.toLowerCase();
    const userData = byUser[handleLower];
    if (!userData || userData.posts.length === 0) continue;

    const newTweets = [];
    for (const post of userData.posts) {
      const postId = post.id || post.tweet_id || post.url?.split('/')?.pop() || '';
      if (!postId || state.seenTweets[postId]) continue;
      if (newTweets.length >= MAX_POSTS_PER_USER) break;

      const postUrl = post.url || `https://x.com/${account.handle}/status/${postId}`;
      newTweets.push({
        id: postId,
        text: post.text || post.tweet_text || post.content || '',
        createdAt: post.date_posted || post.created_at || null,
        url: postUrl,
        likes: post.likes || post.favorite_count || 0,
        retweets: post.retweets || post.retweet_count || 0,
        replies: post.replies || post.reply_count || 0
      });

      state.seenTweets[postId] = Date.now();
    }

    if (newTweets.length === 0) continue;

    results.push({
      source: 'x',
      name: account.name,
      handle: account.handle,
      category: account.category || 'person',
      company: account.company || '',
      bio: userData.bio,
      tweets: newTweets
    });
  }

  return results;
}

// -- LinkedIn Fetching (via Bright Data) -------------------------------------

async function fetchLinkedInContent(linkedinAccounts, apiToken, state, errors) {
  const results = [];
  if (!linkedinAccounts || linkedinAccounts.length === 0) return results;

  const cutoff = new Date(Date.now() - LINKEDIN_LOOKBACK_HOURS * 60 * 60 * 1000);

  const inputs = linkedinAccounts.map(a => ({ url: a.url }));

  console.error(`  Requesting LinkedIn posts for ${linkedinAccounts.length} accounts...`);
  const rawResults = await brightdataScrape(BD_LINKEDIN_POSTS, inputs, apiToken, errors, 'LinkedIn');

  if (!rawResults || !Array.isArray(rawResults)) {
    console.error('  No LinkedIn results from Bright Data');
    return results;
  }

  console.error(`  Bright Data returned ${rawResults.length} raw LinkedIn posts`);

  // Group posts by profile URL
  const byProfile = {};
  for (const post of rawResults) {
    const profileUrl = post.author_url || post.profile_url || '';
    if (!profileUrl) continue;

    // Normalize profile URL for matching
    const normalized = profileUrl.replace(/\/$/, '').toLowerCase();
    if (!byProfile[normalized]) {
      byProfile[normalized] = {
        name: post.author_name || post.name || '',
        headline: post.author_headline || post.headline || '',
        posts: []
      };
    }
    byProfile[normalized].posts.push(post);
  }

  // Process each account
  for (const account of linkedinAccounts) {
    const normalizedUrl = account.url.replace(/\/$/, '').toLowerCase();
    const userData = byProfile[normalizedUrl];
    if (!userData || userData.posts.length === 0) continue;

    const newPosts = [];
    for (const post of userData.posts) {
      const postId = post.post_id || post.id || post.url || '';
      if (!postId || state.seenLinkedin[postId]) continue;

      // Date filter
      const postDate = post.date_posted || post.published_at || post.date || null;
      if (postDate && new Date(postDate) < cutoff) continue;

      if (newPosts.length >= MAX_POSTS_PER_USER) break;

      newPosts.push({
        id: postId,
        text: post.text || post.content || post.description || '',
        createdAt: postDate,
        url: post.url || post.post_url || '',
        likes: post.likes || post.num_likes || 0,
        comments: post.comments || post.num_comments || 0
      });

      state.seenLinkedin[postId] = Date.now();
    }

    if (newPosts.length === 0) continue;

    results.push({
      source: 'linkedin',
      name: account.name,
      company: account.company || '',
      profileUrl: account.url,
      headline: userData.headline,
      posts: newPosts
    });
  }

  return results;
}

// -- Blog Fetching -----------------------------------------------------------

// Parse Atom feed (Shopify Engineering)
function parseAtomFeed(xml) {
  const articles = [];
  const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi;
  let entryMatch;
  while ((entryMatch = entryRegex.exec(xml)) !== null) {
    const block = entryMatch[1];

    const titleMatch = block.match(/<title[^>]*>([\s\S]*?)<\/title>/);
    const title = titleMatch ? titleMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1').trim() : 'Untitled';

    const linkMatch = block.match(/<link[^>]*href="([^"]*)"[^>]*\/?>/)
      || block.match(/<link[^>]*>([\s\S]*?)<\/link>/);
    const url = linkMatch ? linkMatch[1].trim() : null;

    const updatedMatch = block.match(/<updated>([\s\S]*?)<\/updated>/)
      || block.match(/<published>([\s\S]*?)<\/published>/);
    const publishedAt = updatedMatch ? new Date(updatedMatch[1].trim()).toISOString() : null;

    const summaryMatch = block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/)
      || block.match(/<content[^>]*>([\s\S]*?)<\/content>/);
    let description = '';
    if (summaryMatch) {
      description = summaryMatch[1]
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 500);
    }

    if (url) {
      articles.push({ title, url, publishedAt, description });
    }
  }
  return articles;
}

// Parse RSS feed
function parseRssFeed(xml) {
  const articles = [];
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let itemMatch;
  while ((itemMatch = itemRegex.exec(xml)) !== null) {
    const block = itemMatch[1];

    const titleMatch = block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/)
      || block.match(/<title>([\s\S]*?)<\/title>/);
    const title = titleMatch ? titleMatch[1].trim() : 'Untitled';

    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
    const url = linkMatch ? linkMatch[1].trim() : null;

    const pubDateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    const publishedAt = pubDateMatch ? new Date(pubDateMatch[1].trim()).toISOString() : null;

    const descMatch = block.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/)
      || block.match(/<description>([\s\S]*?)<\/description>/);
    const description = descMatch
      ? descMatch[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500)
      : '';

    if (url) {
      articles.push({ title, url, publishedAt, description });
    }
  }
  return articles;
}

// Generic HTML scraper — extracts article links from blog index pages
// Uses the linkPattern from the blog config to match the right links.
// linkPattern examples:
//   "/blog/[slug]"            → matches href="/blog/some-article"
//   "/blogs/[slug]"           → matches href="/blogs/some-article"
//   "/news/[slug]"            → matches href="/news/some-article"
//   "parcellab.com/blog/[slug]" → matches full URLs containing that pattern
function scrapeIndexPage(html, baseUrl, linkPattern) {
  const articles = [];
  const seenUrls = new Set();

  // Build regex from linkPattern
  // Replace [slug] with a capture group for URL-safe slugs
  let patternStr;
  if (linkPattern) {
    // Escape special regex chars, then replace [slug] placeholder
    patternStr = linkPattern
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      .replace('\\[slug\\]', '([a-z0-9][a-z0-9-]*[a-z0-9])');
  } else {
    // Fallback: match common blog URL patterns
    patternStr = '(?:\\/(?:blog|blogs|news|engineering)\\/([a-z0-9][a-z0-9-]*[a-z0-9]))';
  }

  const linkRegex = new RegExp(`href="([^"]*${patternStr}[^"]*)"`, 'gi');
  let linkMatch;
  while ((linkMatch = linkRegex.exec(html)) !== null) {
    let href = linkMatch[1];

    // Build full URL
    let url;
    try {
      url = new URL(href, baseUrl).href;
    } catch {
      continue;
    }

    // Normalize: remove trailing slash for dedup
    url = url.replace(/\/$/, '');
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);

    // Skip non-article pages (about, category, tag pages)
    if (/\/(about|category|tag|author|page|search)\b/i.test(url)) continue;

    articles.push({
      title: '',
      url,
      publishedAt: null,
      description: ''
    });
  }
  return articles;
}

// Extract content from a generic blog article page
function extractArticleContent(html) {
  let title = '';
  let author = '';
  let publishedAt = null;
  let content = '';

  // Try JSON-LD first
  const jsonLdRegex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let jsonLdMatch;
  while ((jsonLdMatch = jsonLdRegex.exec(html)) !== null) {
    try {
      const ld = JSON.parse(jsonLdMatch[1]);
      if (ld['@type'] === 'BlogPosting' || ld['@type'] === 'Article' || ld['@type'] === 'NewsArticle') {
        title = ld.headline || ld.name || title;
        author = ld.author?.name || (Array.isArray(ld.author) ? ld.author[0]?.name : '') || author;
        publishedAt = ld.datePublished || publishedAt;
        if (ld.articleBody) content = ld.articleBody;
        break;
      }
    } catch {
      // Not valid JSON-LD
    }
  }

  // Title fallback: <h1>
  if (!title) {
    const h1Match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
    if (h1Match) title = h1Match[1].replace(/<[^>]+>/g, '').trim();
  }

  // Title fallback: <title>
  if (!title) {
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    if (titleMatch) title = titleMatch[1].replace(/<[^>]+>/g, '').split('|')[0].split('-')[0].trim();
  }

  // Date fallback: meta tags
  if (!publishedAt) {
    const dateMatch = html.match(/<meta[^>]*(?:property|name)="(?:article:published_time|date|datePublished)"[^>]*content="([^"]*)"[^>]*\/?>/i);
    if (dateMatch) publishedAt = dateMatch[1];
  }

  // Date fallback: <time> tags
  if (!publishedAt) {
    const timeMatch = html.match(/<time[^>]*datetime="([^"]*)"[^>]*>/i);
    if (timeMatch) publishedAt = timeMatch[1];
  }

  // Date fallback: visible date text (e.g. "February 11, 2026" or "April 9, 2026")
  // Only match dates in 2025-2027 range to avoid false positives
  if (!publishedAt) {
    const visibleDate = html.match(/(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},?\s+202[5-7]/i);
    if (visibleDate) {
      try {
        const parsed = new Date(visibleDate[0]);
        if (!isNaN(parsed.getTime())) publishedAt = parsed.toISOString();
      } catch { /* ignore parse errors */ }
    }
  }

  // Content extraction: try <article>, then main content area
  if (!content) {
    const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    const bodyHtml = articleMatch ? articleMatch[1] : html;

    content = bodyHtml
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  // Truncate content to ~8000 chars (enough for LLM summarization)
  if (content.length > 8000) {
    content = content.slice(0, 8000) + '...';
  }

  return { title, author, publishedAt, content };
}

// Main blog fetching orchestrator
async function fetchBlogContent(blogs, state, errors) {
  const results = [];
  const cutoff = new Date(Date.now() - BLOG_LOOKBACK_HOURS * 60 * 60 * 1000);

  for (const blog of blogs) {
    console.error(`  Processing blog: ${blog.name}...`);

    try {
      let candidates = [];

      if (blog.type === 'rss') {
        // Fetch Atom/RSS feed
        const feedRes = await fetch(blog.feedUrl, {
          headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/atom+xml, application/rss+xml, application/xml, text/xml, */*' },
          signal: AbortSignal.timeout(30000)
        });
        if (!feedRes.ok) {
          errors.push(`Blog: Failed to fetch feed for ${blog.name}: HTTP ${feedRes.status}`);
          continue;
        }
        const feedXml = await feedRes.text();
        // Detect Atom vs RSS
        if (feedXml.includes('<feed') && feedXml.includes('xmlns="http://www.w3.org/2005/Atom"')) {
          candidates = parseAtomFeed(feedXml);
        } else {
          candidates = parseRssFeed(feedXml);
        }
        console.error(`    Feed: ${candidates.length} entries found`);

      } else {
        // Scrape blog index page
        const indexRes = await fetch(blog.indexUrl, {
          headers: { 'User-Agent': BROWSER_UA },
          signal: AbortSignal.timeout(30000)
        });
        if (!indexRes.ok) {
          errors.push(`Blog: Failed to fetch index for ${blog.name}: HTTP ${indexRes.status}`);
          continue;
        }
        const indexHtml = await indexRes.text();

        // Also try RSS discovery: common patterns
        const rssPatterns = [
          blog.indexUrl + '/feed',
          blog.indexUrl + '/rss.xml',
          blog.indexUrl + '/feed.xml',
          blog.indexUrl.replace(/\/blog\/?$/, '') + '/blog/feed',
          blog.indexUrl.replace(/\/blog\/?$/, '') + '/blog/rss.xml'
        ];

        let feedFound = false;
        for (const rssUrl of rssPatterns) {
          try {
            const rssRes = await fetch(rssUrl, {
              headers: { 'User-Agent': BROWSER_UA },
              signal: AbortSignal.timeout(10000)
            });
            if (rssRes.ok) {
              const rssText = await rssRes.text();
              if (rssText.includes('<rss') || rssText.includes('<feed')) {
                const parsed = rssText.includes('<feed') ? parseAtomFeed(rssText) : parseRssFeed(rssText);
                if (parsed.length > 0) {
                  console.error(`    Discovered RSS at ${rssUrl}: ${parsed.length} entries`);
                  candidates = parsed;
                  feedFound = true;
                  break;
                }
              }
            }
          } catch {
            // RSS probe failed, continue
          }
        }

        // Fallback: scrape HTML
        if (!feedFound) {
          const baseUrl = new URL(blog.indexUrl).origin;
          candidates = scrapeIndexPage(indexHtml, baseUrl, blog.linkPattern);
          console.error(`    Scraped: ${candidates.length} links found`);
        }
      }

      // Filter: unseen + within lookback window
      // For articles without dates (common with HTML scraping), limit to top 2
      // to avoid pulling in months of history on first run. Articles with dates
      // within the lookback window can go up to MAX_ARTICLES_PER_BLOG.
      const newArticles = [];
      let undatedCount = 0;
      const MAX_UNDATED = 2;
      for (const article of candidates.slice(0, MAX_ARTICLES_PER_BLOG * 2)) {
        if (state.seenArticles[article.url]) continue;
        if (article.publishedAt && new Date(article.publishedAt) < cutoff) continue;
        if (!article.publishedAt) {
          undatedCount++;
          if (undatedCount > MAX_UNDATED) continue;
        }
        newArticles.push(article);
        if (newArticles.length >= MAX_ARTICLES_PER_BLOG) break;
      }

      if (newArticles.length === 0) {
        console.error(`    No new articles`);
        continue;
      }

      console.error(`    Fetching ${newArticles.length} new article(s)...`);

      // Fetch full article content
      for (const article of newArticles) {
        try {
          // For RSS-sourced articles, we may already have content
          if (article.description && article.description.length > 200 && blog.type === 'rss') {
            results.push({
              source: 'blog',
              name: blog.name,
              title: article.title,
              url: article.url,
              publishedAt: article.publishedAt,
              content: article.description
            });
            state.seenArticles[article.url] = Date.now();
            continue;
          }

          const articleRes = await fetch(article.url, {
            headers: { 'User-Agent': BROWSER_UA },
            signal: AbortSignal.timeout(30000)
          });
          if (!articleRes.ok) {
            errors.push(`Blog: Failed to fetch ${article.url}: HTTP ${articleRes.status}`);
            continue;
          }
          const articleHtml = await articleRes.text();
          const extracted = extractArticleContent(articleHtml);

          if (!extracted.content || extracted.content.length < 100) {
            errors.push(`Blog: No content extracted from ${article.url}`);
            continue;
          }

          // Post-fetch date filter: if we now have a date from the article page,
          // check it against the lookback window. This catches old articles that
          // had no date on the index page but do have one in the article body.
          if (extracted.publishedAt && new Date(extracted.publishedAt) < cutoff) {
            console.error(`      Skipping "${extracted.title}" (published ${extracted.publishedAt}, too old)`);
            state.seenArticles[article.url] = Date.now();
            continue;
          }

          // AI keyword filter for blogs that mark it
          if (blog.aiKeywords) {
            const combined = (extracted.title + ' ' + extracted.content).toLowerCase();
            const hasAiContent = blog.aiKeywords.some(kw => combined.includes(kw));
            if (!hasAiContent) {
              console.error(`      Skipping "${extracted.title}" (no AI keywords)`);
              state.seenArticles[article.url] = Date.now();
              continue;
            }
          }

          results.push({
            source: 'blog',
            name: blog.name,
            title: extracted.title || article.title || 'Untitled',
            url: article.url,
            publishedAt: extracted.publishedAt || article.publishedAt,
            author: extracted.author || '',
            content: extracted.content
          });

          state.seenArticles[article.url] = Date.now();
          await new Promise(r => setTimeout(r, 500));
        } catch (err) {
          errors.push(`Blog: Error fetching ${article.url}: ${err.message}`);
        }
      }
    } catch (err) {
      errors.push(`Blog: Error processing ${blog.name}: ${err.message}`);
    }
  }

  return results;
}

// -- Main --------------------------------------------------------------------

async function main() {
  const args = process.argv.slice(2);
  const tweetsOnly = args.includes('--tweets-only');
  const linkedinOnly = args.includes('--linkedin-only');
  const blogsOnly = args.includes('--blogs-only');
  const socialOnly = args.includes('--social-only'); // tweets + linkedin

  const runTweets = tweetsOnly || socialOnly || (!linkedinOnly && !blogsOnly);
  const runLinkedin = linkedinOnly || socialOnly || (!tweetsOnly && !blogsOnly);
  const runBlogs = blogsOnly || (!tweetsOnly && !linkedinOnly && !socialOnly);

  const bdToken = process.env.BRIGHTDATA_API_TOKEN;

  if ((runTweets || runLinkedin) && !bdToken) {
    console.error('BRIGHTDATA_API_TOKEN not set');
    process.exit(1);
  }

  const sources = await loadSources();
  const state = await loadState();
  const errors = [];

  // Fetch tweets via Bright Data
  if (runTweets && sources.x_accounts?.length > 0) {
    console.error('Fetching X/Twitter content via Bright Data (7-day lookback)...');
    const xContent = await fetchXContent(sources.x_accounts, bdToken, state, errors);
    console.error(`  Found ${xContent.length} accounts with new tweets`);

    const totalTweets = xContent.reduce((sum, a) => sum + a.tweets.length, 0);
    const xFeed = {
      generatedAt: new Date().toISOString(),
      lookbackHours: TWEET_LOOKBACK_HOURS,
      x: xContent,
      stats: { xAccounts: xContent.length, totalTweets },
      errors: errors.filter(e => e.startsWith('X/')).length > 0
        ? errors.filter(e => e.startsWith('X/')) : undefined
    };
    await writeFile(join(SCRIPT_DIR, '..', 'feed-x.json'), JSON.stringify(xFeed, null, 2));
    console.error(`  feed-x.json: ${xContent.length} accounts, ${totalTweets} tweets`);
  }

  // Fetch LinkedIn posts via Bright Data
  if (runLinkedin && sources.linkedin_accounts?.length > 0) {
    console.error('Fetching LinkedIn content via Bright Data (7-day lookback)...');
    const liContent = await fetchLinkedInContent(sources.linkedin_accounts, bdToken, state, errors);
    console.error(`  Found ${liContent.length} accounts with new posts`);

    const totalPosts = liContent.reduce((sum, a) => sum + a.posts.length, 0);
    const liFeed = {
      generatedAt: new Date().toISOString(),
      lookbackHours: LINKEDIN_LOOKBACK_HOURS,
      linkedin: liContent,
      stats: { linkedinAccounts: liContent.length, totalPosts },
      errors: errors.filter(e => e.startsWith('LinkedIn')).length > 0
        ? errors.filter(e => e.startsWith('LinkedIn')) : undefined
    };
    await writeFile(join(SCRIPT_DIR, '..', 'feed-linkedin.json'), JSON.stringify(liFeed, null, 2));
    console.error(`  feed-linkedin.json: ${liContent.length} accounts, ${totalPosts} posts`);
  }

  // Fetch blogs
  if (runBlogs) {
    console.error('Fetching blog content (7-day lookback)...');
    const blogContent = await fetchBlogContent(sources.blogs, state, errors);
    console.error(`  Found ${blogContent.length} new blog post(s)`);

    const blogFeed = {
      generatedAt: new Date().toISOString(),
      lookbackHours: BLOG_LOOKBACK_HOURS,
      blogs: blogContent,
      stats: { blogPosts: blogContent.length },
      errors: errors.filter(e => e.startsWith('Blog')).length > 0
        ? errors.filter(e => e.startsWith('Blog')) : undefined
    };
    await writeFile(join(SCRIPT_DIR, '..', 'feed-blogs.json'), JSON.stringify(blogFeed, null, 2));
    console.error(`  feed-blogs.json: ${blogContent.length} posts`);
  }

  await saveState(state);

  if (errors.length > 0) {
    console.error(`  ${errors.length} non-fatal errors`);
  }
}

main().catch(err => {
  console.error('Feed generation failed:', err.message);
  process.exit(1);
});
