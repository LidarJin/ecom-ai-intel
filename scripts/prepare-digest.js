#!/usr/bin/env node

// ============================================================================
// Ecommerce AI Intel — Prepare Digest
// ============================================================================
// Gathers everything the LLM needs to produce a weekly digest:
// - Fetches the central feeds (tweets + blogs)
// - Fetches the latest prompts from GitHub
// - Reads the user's config (language, delivery method)
// - Outputs a single JSON blob to stdout
//
// Usage: node prepare-digest.js
// Output: JSON to stdout
// ============================================================================

import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

// -- Constants ---------------------------------------------------------------

const USER_DIR = join(homedir(), '.ecom-ai-intel');
const CONFIG_PATH = join(USER_DIR, 'config.json');

const FEED_X_URL = 'https://raw.githubusercontent.com/LidarJin/ecom-ai-intel/main/feed-x.json';
const FEED_BLOGS_URL = 'https://raw.githubusercontent.com/LidarJin/ecom-ai-intel/main/feed-blogs.json';

const PROMPTS_BASE = 'https://raw.githubusercontent.com/LidarJin/ecom-ai-intel/main/prompts';
const PROMPT_FILES = [
  'summarize-tweets.md',
  'summarize-blogs.md',
  'digest-intro.md',
  'translate.md'
];

// -- Fetch helpers -----------------------------------------------------------

async function fetchJSON(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function fetchText(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return res.text();
  } catch {
    return null;
  }
}

// -- Main --------------------------------------------------------------------

async function main() {
  const errors = [];

  // 1. Read user config
  let config = {
    language: 'bilingual',
    frequency: 'weekly',
    delivery: { method: 'stdout' }
  };
  if (existsSync(CONFIG_PATH)) {
    try {
      config = JSON.parse(await readFile(CONFIG_PATH, 'utf-8'));
    } catch (err) {
      errors.push(`Could not read config: ${err.message}`);
    }
  }

  // 2. Fetch feeds — try remote first, fall back to local
  let feedX = await fetchJSON(FEED_X_URL);
  let feedBlogs = await fetchJSON(FEED_BLOGS_URL);

  // Fallback: read local feed files (for dev or when remote not yet set up)
  const scriptDir = decodeURIComponent(new URL('.', import.meta.url).pathname);
  if (!feedX) {
    const localPath = join(scriptDir, '..', 'feed-x.json');
    if (existsSync(localPath)) {
      try {
        feedX = JSON.parse(await readFile(localPath, 'utf-8'));
      } catch {
        errors.push('Could not read local feed-x.json');
      }
    } else {
      errors.push('Could not fetch tweet feed (remote or local)');
    }
  }
  if (!feedBlogs) {
    const localPath = join(scriptDir, '..', 'feed-blogs.json');
    if (existsSync(localPath)) {
      try {
        feedBlogs = JSON.parse(await readFile(localPath, 'utf-8'));
      } catch {
        errors.push('Could not read local feed-blogs.json');
      }
    } else {
      errors.push('Could not fetch blog feed (remote or local)');
    }
  }

  // 3. Load prompts: user custom > remote (GitHub) > local default
  const prompts = {};
  const localPromptsDir = join(scriptDir, '..', 'prompts');
  const userPromptsDir = join(USER_DIR, 'prompts');

  for (const filename of PROMPT_FILES) {
    const key = filename.replace('.md', '').replace(/-/g, '_');
    const userPath = join(userPromptsDir, filename);
    const localPath = join(localPromptsDir, filename);

    if (existsSync(userPath)) {
      prompts[key] = await readFile(userPath, 'utf-8');
      continue;
    }

    const remote = await fetchText(`${PROMPTS_BASE}/${filename}`);
    if (remote) {
      prompts[key] = remote;
      continue;
    }

    if (existsSync(localPath)) {
      prompts[key] = await readFile(localPath, 'utf-8');
    } else {
      errors.push(`Could not load prompt: ${filename}`);
    }
  }

  // 4. Build output
  const output = {
    status: 'ok',
    generatedAt: new Date().toISOString(),

    config: {
      language: config.language || 'bilingual',
      frequency: config.frequency || 'weekly',
      delivery: config.delivery || { method: 'stdout' }
    },

    x: feedX?.x || [],
    blogs: feedBlogs?.blogs || [],

    stats: {
      xAccounts: feedX?.x?.length || 0,
      totalTweets: (feedX?.x || []).reduce((sum, a) => sum + a.tweets.length, 0),
      blogPosts: feedBlogs?.blogs?.length || 0,
      feedGeneratedAt: feedX?.generatedAt || feedBlogs?.generatedAt || null
    },

    prompts,
    errors: errors.length > 0 ? errors : undefined
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => {
  console.error(JSON.stringify({
    status: 'error',
    message: err.message
  }));
  process.exit(1);
});
