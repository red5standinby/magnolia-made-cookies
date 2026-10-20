# Instagram feed — how it works

The `#instagram` section on the home page pulls live posts from
[@magnoliamadecookies](https://instagram.com/magnoliamadecookies) at page load.

## Pieces

| File | Role |
| --- | --- |
| `functions/api/instagram.js` | Cloudflare Pages Function. Returns `{ posts: [...] }` as JSON. |
| `index.html` → `#instagram` | Static fallback cells + a small script that calls the API and re-renders. |
| `images/*.jpg` | Last-known-good snapshot (used only if the API is unreachable). |

## How a page load works

1. The HTML ships with 9 baked-in cells, so the grid is never empty or broken —
   it renders instantly, even with JS off or a cold cache.
2. The page fetches `/api/instagram`. If it returns posts, the grid is swapped
   to the live set (skipped while the cursor is hovering a tile).
3. The function is edge-cached for **30 minutes**, so Instagram is hit a handful
   of times per hour, not once per visitor.
4. If upstream fails, the function serves the last cached payload for up to
   **7 days** and marks it `stale: true` rather than showing an error.

## Where the data comes from

Tried in order:

1. **Instagram Graph API** — used automatically if `IG_ACCESS_TOKEN` is set in
   the Cloudflare Pages environment variables. This is the officially supported
   path and returns full captions and high-res images.
2. **Public profile scrape** — no auth. Reads the profile page for recent post
   shortcodes, then each post's OpenGraph tags. This is the current default and
   works unattended, but:

   > **Known limit:** Instagram's logged-out profile page only exposes the ~9
   > most recent posts, so the grid is set to 9 (`MAX_POSTS`). Getting more
   > requires the Graph API — and that requires the account to be Business or
   > Creator, which `@magnoliamadecookies` currently is not. See below.

## Adding the token (only if you want more than 9 posts)

> **Prerequisite:** the Instagram account must be **Business or Creator**.
> `@magnoliamadecookies` is currently a *personal* account (`is_business_account:
> false`), and the Graph API rejects personal accounts outright. Switching is
> free and takes ~30 seconds in the app, and doesn't change how the profile
> looks to followers — but it's a change to Laura's account, so get her OK first.
>
> Once switched: bump `MAX_POSTS` back to 12 (must stay a multiple of 3) and
> restore the extra snapshot images in `images/`.

1. Go to <https://developers.facebook.com/tools/explorer/> and pick
   *Instagram Graph API*.
2. Connect the Instagram account that manages `@magnoliamadecookies`.
3. Request `instagram_basic` + `pages_show_list`, then generate a long-lived
   token (60 days) for that Instagram Business/Creator account.
4. In the Cloudflare dashboard → Pages → this project → **Settings →
   Environment variables**, add `IG_ACCESS_TOKEN` (mark it a secret).
5. Redeploy. The function picks it up on the next invocation; no code change.

Long-lived tokens still expire every 60 days — that's a Meta rule, not something
the code can avoid. Calendar a refresh reminder.

## Tuning

In `functions/api/instagram.js`:

- `FRESH_SECONDS` (default 30 min) — how long edge responses stay fresh.
- `STALE_SECONDS` (default 7 days) — how long a stale payload may be served.
- `MAX_POSTS` (default 9) — grid size; must be a multiple of 3 for a clean grid.

## Local preview

```sh
# static only (fallback snapshot)
python3 -m http.server 8787

# with the API (needs Node 18+ for global fetch)
node /tmp/fntest/serve.mjs   # mock harness, or use `wrangler pages dev .`
```
