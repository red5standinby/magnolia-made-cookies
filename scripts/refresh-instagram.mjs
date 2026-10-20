#!/usr/bin/env node
/**
 * Refresh the Magnolia Made Cookies Instagram snapshot and deploy.
 *
 * Instagram rate-limits Cloudflare's shared egress IPs (429), so the Pages
 * Function can't scrape reliably. This script runs from a home IP instead,
 * downloads the current feed, rewrites the baked-in snapshot in index.html,
 * commits, and deploys to Cloudflare Pages.
 *
 * Usage:
 *   CLOUDFLARE_API_TOKEN=... node scripts/refresh-instagram.mjs [--dry-run]
 *
 * Exit codes: 0 = ok (deployed or unchanged), 1 = error.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";

const REPO = path.resolve(import.meta.dirname, "..");
const IMAGES = path.join(REPO, "images");
const PROJECT = "magnolia-made-cookies";
const ACCOUNT_ID = "73c072be1b5751f7069b31817e7f162a";
const USERNAME = "magnoliamadecookies";
const MAX_POSTS = 9; // Instagram's logged-out ceiling; must be a multiple of 3.

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36";
const DRY = process.argv.includes("--dry-run");

const log = (...a) => console.log("[ig-refresh]", ...a);

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { cwd: REPO, encoding: "utf8", ...opts });
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent": UA,
      accept: "text/html,application/xhtml+xml",
      "accept-language": "en-US,en;q=0.9",
    },
  });
  if (!res.ok) throw new Error(`${res.status} ${url.split("?")[0]}`);
  return res.text();
}

function decode(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

function shortCaption(caption) {
  const noTags = caption.replace(/#[\p{L}\p{N}_]+/gu, "").replace(/\s+/g, " ").trim();
  const base = noTags || caption.trim();
  return base.length <= 70 ? base : base.slice(0, 67).replace(/[\s,;:.-]+$/, "") + "…";
}

async function getPosts() {
  const profile = await fetchText(`https://www.instagram.com/${USERNAME}/`);

  const codes = [];
  const seen = new Set();
  for (const m of profile.matchAll(/\/p\/([A-Za-z0-9_-]{6,})/g)) {
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      codes.push(m[1]);
    }
    if (codes.length >= MAX_POSTS) break;
  }
  if (!codes.length) throw new Error("no shortcodes found on profile page");

  const posts = [];
  for (const sc of codes) {
    try {
      const html = await fetchText(`https://www.instagram.com/p/${sc}/`);
      const og = (re) => {
        const m = html.match(re);
        return m ? decode(m[1]) : "";
      };
      const image = og(/<meta[^>]+property="og:image"[^>]+content="([^"]+)"/);
      const title = og(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/);
      if (!image) continue;

      const caption = title.replace(/^\s*[^:]{1,40}\s+on Instagram:?\s*/i, "").replace(/^"|"$/g, "").trim();
      posts.push({ sc, image, caption: shortCaption(caption) });
    } catch (err) {
      log(`  skip ${sc}: ${err.message}`);
    }
  }
  if (!posts.length) throw new Error("no posts parsed");
  return posts;
}

async function downloadImages(posts) {
  mkdirSync(IMAGES, { recursive: true });
  for (const p of posts) {
    const file = path.join(IMAGES, `${p.sc}.jpg`);
    const res = await fetch(p.image, { headers: { "user-agent": UA } });
    if (!res.ok) throw new Error(`image ${p.sc}: ${res.status}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    // Downscale to keep the page light; sips is macOS built-in.
    try {
      sh("sips", ["-Z", "900", file], { stdio: "ignore" });
    } catch {
      /* non-macOS: keep original */
    }
    log(`  saved ${p.sc}.jpg`);
  }
}

function esc(s) {
  return String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function buildGrid(posts) {
  return (
    '<div class="ig-feed-grid" id="igFeed" style="display:grid;grid-template-columns:repeat(3,1fr);gap:14px;">\n' +
    posts
      .map(
        (p) =>
          `        <a class="ig-cell" href="https://www.instagram.com/p/${p.sc}/" target="_blank" rel="noopener" aria-label="${esc(
            p.caption
          )} — view on Instagram">\n` +
          `          <img src="images/${p.sc}.jpg" alt="${esc(p.caption)}" loading="lazy" decoding="async">\n` +
          `          <span class="ig-cell-ov"><span class="ig-cell-cap">${esc(p.caption)}</span></span>\n` +
          `        </a>\n`
      )
      .join("") +
    "      </div>"
  );
}

function rewriteIndex(posts) {
  const file = path.join(REPO, "index.html");
  const html = readFileSync(file, "utf8");

  const start = html.indexOf('<div class="ig-feed-grid" id="igFeed"');
  if (start < 0) throw new Error("could not find #igFeed grid in index.html");

  // Walk to the matching close of this div.
  let depth = 0;
  let end = -1;
  const tag = /<\/?div\b/g;
  tag.lastIndex = start;
  let m;
  while ((m = tag.exec(html))) {
    if (m[0] === "<div") depth++;
    else {
      depth--;
      if (depth === 0) {
        end = m.index + "</div>".length;
        break;
      }
    }
  }
  if (end < 0) throw new Error("unbalanced grid markup");

  const next = html.slice(0, start) + buildGrid(posts) + html.slice(end);
  writeFileSync(file, next);
  return next;
}

function pruneStaleImages(posts) {
  const keep = new Set(posts.map((p) => `${p.sc}.jpg`));
  let removed = 0;
  for (const f of execFileSync("ls", [IMAGES], { encoding: "utf8" }).split("\n").filter(Boolean)) {
    if (/^[A-Za-z0-9_-]+\.jpg$/.test(f) && !keep.has(f)) {
      sh("git", ["rm", "-q", `images/${f}`]);
      removed++;
    }
  }
  return removed;
}

function deploy() {
  const tmp = "/tmp/mm-deploy";
  sh("rm", ["-rf", tmp]);
  sh("mkdir", ["-p", tmp]);
  sh("cp", ["index.html", path.join(tmp, "index.html")]);
  sh("cp", ["-r", "functions", tmp]);

  const out = execFileSync(
    "npx",
    ["wrangler", "pages", "deploy", ".", "--project-name", PROJECT, "--branch", "main"],
    {
      cwd: tmp,
      encoding: "utf8",
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT_ID },
    }
  );
  const url = (out.match(/https:\/\/([a-z0-9]+)\.magnolia-made-cookies\.pages\.dev/) || [])[0];
  return url || "(deployed)";
}

async function main() {
  log("fetching feed…");
  const posts = await getPosts();
  log(`got ${posts.length} posts`);

  log("downloading images…");
  await downloadImages(posts);

  log("rewriting index.html snapshot…");
  rewriteIndex(posts);

  const removed = pruneStaleImages(posts);
  if (removed) log(`pruned ${removed} stale image(s)`);

  if (DRY) {
    log("--dry-run: stopping before commit/deploy");
    return;
  }

  sh("git", ["add", "index.html", "images"]);
  const staged = sh("git", ["diff", "--cached", "--name-only"]).trim();
  if (!staged) {
    log("no changes — feed already current");
    return;
  }

  const list = posts.map((p) => p.sc).join(", ");
  sh("git", ["commit", "-q", "-m", `Refresh Instagram snapshot (${posts.length} posts)\n\n${list}`]);
  log("committed");

  const url = deploy();
  log(`deployed: ${url}`);

  try {
    sh("git", ["-c", "http.version=HTTP/1.1", "push", "-q", "origin", "gh-pages"]);
    log("pushed to GitHub");
  } catch (err) {
    log(`WARN: git push failed (deploy already succeeded): ${err.message.split("\n")[0]}`);
  }
}

main().catch((err) => {
  log(`ERROR: ${err.message}`);
  process.exit(1);
});
