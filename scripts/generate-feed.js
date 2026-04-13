#!/usr/bin/env node

// ============================================================================
// Ecommerce AI Intel — Central Feed Generator
// ============================================================================
// Runs on GitHub Actions (weekly) to fetch content and publish
// feed-x.json and feed-blogs.json.
//
// Deduplication: tracks previously seen tweet IDs and article URLs
// in state-feed.json so content is never repeated across runs.
//
// Usage: node generate-feed.js [--tweets-only | --blogs-only]
// Env vars needed: X_BEARER_TOKEN
// ============================================================================

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

// -- Constants ---------------------------------------------------------------

const X_API_BASE = 'https://api.x.com/2';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TWEET_LOOKBACK_HOURS = 168; // 7 days
const BLOG_LOOKBACK_HOURS = 168;  // 7 days
const MAX_TWEETS_PER_USER = 5;
const MAX_ARTICLES_PER_BLOG = 5;

const SCRIPT_DIR = decodeURIComponent(new URL('.', import.meta.url).pathname);
const STATE_PATH = join(SCRIPT_DIR, '..', 'state-feed.json');

// -- State Management --------------------------------------------------------

async function loadState() {
  if (!existsSync(STATE_PATH)) {
    return { seenTweets: {}, seenArticles: {} };
  }
  try {
    const state = JSON.parse(await readFile(STATE_PATH, 'utf-8'));
    if (!state.seenArticles) state.seenArticles = {};
    if (!state.seenTweets) state.seenTweets = {};
    return state;
  } catch {
    return { seenTweets: {}, seenArticles: {} };
  }
}

async function saveState(state) {
  const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000; // 14 days for weekly
  for (const [id, ts] of Object.entries(state.seenTweets)) {
    if (ts < cutoff) delete state.seenTweets[id];
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

// -- X/Twitter Fetching (Official API v2) ------------------------------------

async function fetchXContent(xAccounts, bearerToken, state, errors) {
  const results = [];
  const cutoff = new Date(Date.now() - TWEET_LOOKBACK_HOURS * 60 * 60 * 1000);

  // Batch lookup all user IDs
  const handles = xAccounts.map(a => a.handle);
  let userMap = {};

  for (let i = 0; i < handles.length; i += 100) {
    const batch = handles.slice(i, i + 100);
    try {
      const res = await fetch(
        `${X_API_BASE}/users/by?usernames=${batch.join(',')}&user.fields=name,description`,
        { headers: { 'Authorization': `Bearer ${bearerToken}` } }
      );

      if (!res.ok) {
        errors.push(`X API: User lookup failed: HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      for (const user of (data.data || [])) {
        userMap[user.username.toLowerCase()] = {
          id: user.id,
          name: user.name,
          description: user.description || ''
        };
      }
      if (data.errors) {
        for (const err of data.errors) {
          errors.push(`X API: User not found: ${err.value || err.detail}`);
        }
      }
    } catch (err) {
      errors.push(`X API: User lookup error: ${err.message}`);
    }
  }

  // Fetch recent tweets per user
  for (const account of xAccounts) {
    const userData = userMap[account.handle.toLowerCase()];
    if (!userData) continue;

    try {
      const res = await fetch(
        `${X_API_BASE}/users/${userData.id}/tweets?` +
        `max_results=10` +
        `&tweet.fields=created_at,public_metrics,referenced_tweets,note_tweet` +
        `&exclude=retweets,replies` +
        `&start_time=${cutoff.toISOString()}`,
        { headers: { 'Authorization': `Bearer ${bearerToken}` } }
      );

      if (!res.ok) {
        if (res.status === 429) {
          errors.push(`X API: Rate limited, skipping remaining accounts`);
          break;
        }
        errors.push(`X API: Failed to fetch tweets for @${account.handle}: HTTP ${res.status}`);
        continue;
      }

      const data = await res.json();
      const allTweets = data.data || [];

      const newTweets = [];
      for (const t of allTweets) {
        if (state.seenTweets[t.id]) continue;
        if (newTweets.length >= MAX_TWEETS_PER_USER) break;

        newTweets.push({
          id: t.id,
          text: t.note_tweet?.text || t.text,
          createdAt: t.created_at,
          url: `https://x.com/${account.handle}/status/${t.id}`,
          likes: t.public_metrics?.like_count || 0,
          retweets: t.public_metrics?.retweet_count || 0,
          replies: t.public_metrics?.reply_count || 0,
          isQuote: t.referenced_tweets?.some(r => r.type === 'quoted') || false
        });

        state.seenTweets[t.id] = Date.now();
      }

      if (newTweets.length === 0) continue;

      results.push({
        source: 'x',
        name: account.name,
        handle: account.handle,
        category: account.category || 'person',
        company: account.company || '',
        bio: userData.description,
        tweets: newTweets
      });

      await new Promise(r => setTimeout(r, 200));
    } catch (err) {
      errors.push(`X API: Error fetching @${account.handle}: ${err.message}`);
    }
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
  const blogsOnly = args.includes('--blogs-only');

  const runTweets = tweetsOnly || !blogsOnly;
  const runBlogs = blogsOnly || !tweetsOnly;

  const xBearerToken = process.env.X_BEARER_TOKEN;

  if (runTweets && !xBearerToken) {
    console.error('X_BEARER_TOKEN not set');
    process.exit(1);
  }

  const sources = await loadSources();
  const state = await loadState();
  const errors = [];

  // Fetch tweets
  if (runTweets) {
    console.error('Fetching X/Twitter content (7-day lookback)...');
    const xContent = await fetchXContent(sources.x_accounts, xBearerToken, state, errors);
    console.error(`  Found ${xContent.length} accounts with new tweets`);

    const totalTweets = xContent.reduce((sum, a) => sum + a.tweets.length, 0);
    const xFeed = {
      generatedAt: new Date().toISOString(),
      lookbackHours: TWEET_LOOKBACK_HOURS,
      x: xContent,
      stats: { xAccounts: xContent.length, totalTweets },
      errors: errors.filter(e => e.startsWith('X API')).length > 0
        ? errors.filter(e => e.startsWith('X API')) : undefined
    };
    await writeFile(join(SCRIPT_DIR, '..', 'feed-x.json'), JSON.stringify(xFeed, null, 2));
    console.error(`  feed-x.json: ${xContent.length} accounts, ${totalTweets} tweets`);
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
