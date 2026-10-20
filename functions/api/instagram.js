/**
 * GET /api/instagram
 *
 * Live Instagram feed for @magnoliamadecookies.
 *
 * Strategy (in order, first one that works wins):
 *   1. Instagram Graph API — if IG_ACCESS_TOKEN is set in the Pages env.
 *   2. Public profile shortcode scrape + per-post OG tags (no auth needed).
 *   3. Stale edge cache — serve the last good payload if everything fails.
 *
 * Responses are edge-cached so the page loads instantly and Instagram sees
 * only a handful of requests per hour.
 */

const USERNAME = "magnoliamadecookies";
const MAX_POSTS = 12;

// How long a successful payload stays fresh at the edge.
const FRESH_SECONDS = 60 * 30; // 30 min
// How long we'll keep serving a stale payload if upstream is failing.
const STALE_SECONDS = 60 * 60 * 24 * 7; // 7 days

// Keep this short. Instagram serves a stripped page (no post links) to some
// full Chrome UA strings, and a usable one to this truncated form.
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";

function json(body, { status = 200, cacheSeconds = FRESH_SECONDS, staleSeconds = STALE_SECONDS } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": `public, max-age=${cacheSeconds}, s-maxage=${cacheSeconds}, stale-while-revalidate=${staleSeconds}`,
      "access-control-allow-origin": "*",
    },
  });
}

function decodeEntities(str) {
  return String(str)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

// Strip the "Username on Instagram: " prefix og:title adds.
function cleanCaption(title) {
  return decodeEntities(title)
    .replace(/^\s*[^:]{1,40}\s+on Instagram:?\s*/i, "")
    .replace(/^\s*"/, "")
    .replace(/"\s*$/, "")
    .trim();
}

// Shorten a caption down to a single readable line for the overlay.
function shortCaption(caption) {
  const noTags = caption.replace(/#[\p{L}\p{N}_]+/gu, "").replace(/\s+/g, " ").trim();
  const base = noTags || caption.trim();
  if (base.length <= 70) return base;
  return base.slice(0, 67).replace(/[\s,;:.-]+$/, "") + "…";
}

function relativeDate(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const days = Math.floor((Date.now() - then) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 7) return `${days} days ago`;
  const weeks = Math.floor(days / 7);
  if (weeks < 5) return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;
  const months = Math.floor(days / 30);
  return months <= 1 ? "1 month ago" : `${months} months ago`;
}

/* ───────────────────────── 1. Graph API ───────────────────────── */

async function fromGraphApi(token) {
  const fields = "id,caption,media_url,thumbnail_url,permalink,media_type,timestamp";
  const url = `https://graph.instagram.com/me/media?fields=${fields}&limit=${MAX_POSTS}&access_token=${encodeURIComponent(
    token
  )}`;

  const res = await fetch(url, { headers: { "user-agent": UA } });
  if (!res.ok) throw new Error(`graph ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data.data)) throw new Error("graph: no data");

  const posts = data.data
    .filter((p) => p.media_type !== "VIDEO" || p.thumbnail_url)
    .map((p) => ({
      id: p.id,
      permalink: p.permalink,
      image: p.media_type === "VIDEO" ? p.thumbnail_url : p.media_url,
      caption: p.caption ? shortCaption(decodeEntities(p.caption)) : "",
      fullCaption: p.caption || "",
      timestamp: p.timestamp,
      ago: relativeDate(p.timestamp),
    }));

  return { source: "graph", posts };
}

/* ─────────────────────── 2. Public scrape ─────────────────────── */

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`fetch ${res.status} ${url.split("?")[0]}`);
  return res.text();
}

async function fromScrape() {
  // Step 1: grab the profile page to discover recent post shortcodes.
  const profile = await fetchText(`https://www.instagram.com/${USERNAME}/`);

  const shortcodes = [];
  const seen = new Set();
  // Instagram escapes slashes in embedded JSON (\/p\/SC), so accept both forms.
  const scPattern = /\/p\/([A-Za-z0-9_-]{6,})/g;
  for (const m of profile.matchAll(scPattern)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      shortcodes.push(m[1]);
    }
    if (shortcodes.length >= MAX_POSTS) break;
  }
  if (!shortcodes.length) throw new Error("scrape: no shortcodes found");

  // Step 2: one light request per post for its OG metadata.
  const posts = [];
  for (const sc of shortcodes) {
    try {
      const html = await fetchText(`https://www.instagram.com/p/${sc}/`);
      const og = (re) => {
        const m = html.match(re);
        return m ? decodeEntities(m[1]) : "";
      };

      const image = og(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/);
      const title = og(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/);
      const description = og(/<meta[^>]+property="og:description"[^>]+content="([^"]+)"/);

      if (!image) continue;

      const dateMatch = description.match(/on ([A-Z][a-z]+ \d{1,2}, \d{4})/);
      const iso = dateMatch ? new Date(`${dateMatch[1]} UTC`).toISOString() : null;
      const caption = cleanCaption(title);

      posts.push({
        id: sc,
        permalink: `https://www.instagram.com/p/${sc}/`,
        image,
        caption: shortCaption(caption),
        fullCaption: caption,
        timestamp: iso,
        ago: iso ? relativeDate(iso) : "",
      });
    } catch (err) {
      // A single bad post shouldn't sink the whole feed.
      continue;
    }
  }

  if (!posts.length) throw new Error("scrape: no posts parsed");
  return { source: "scrape", posts };
}

/* ────────────────────────────── handler ───────────────────────── */

export async function onRequestGet(context) {
  const { request, env } = context;
  const cache = caches.default;

  // Serve from edge cache when warm.
  const cached = await cache.match(request);
  if (cached) return cached;

  const payloads = [];

  try {
    if (env && env.IG_ACCESS_TOKEN) {
      payloads.push(await fromGraphApi(env.IG_ACCESS_TOKEN));
    }
  } catch (err) {
    console.warn("[instagram] graph api failed:", err.message);
  }

  if (!payloads.length) {
    try {
      payloads.push(await fromScrape());
    } catch (err) {
      console.warn("[instagram] scrape failed:", err.message);
    }
  }

  if (!payloads.length) {
    // Nothing worked — try one more cached read (allows stale-on-error).
    const stale = await cache.match(request);
    if (stale) {
      const body = await stale.json();
      return json({ ...body, stale: true }, { cacheSeconds: 0, staleSeconds: 0 });
    }
    return json(
      { error: "feed unavailable", posts: [] },
      { status: 503, cacheSeconds: 60, staleSeconds: 0 }
    );
  }

  const winner = payloads[0];
  const body = {
    username: USERNAME,
    profile: `https://www.instagram.com/${USERNAME}/`,
    source: winner.source,
    fetchedAt: new Date().toISOString(),
    posts: winner.posts.slice(0, MAX_POSTS),
  };

  const response = json(body);

  // Store a detached copy at the edge (needs its own Response for CF cache).
  if (typeof context.waitUntil === "function") {
    context.waitUntil(cache.put(request, response.clone()));
  } else {
    await cache.put(request, response.clone());
  }

  return response;
}
