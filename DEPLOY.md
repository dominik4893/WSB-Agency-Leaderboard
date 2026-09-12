# Deploy guide — WSB Leaderboard (Netlify + GitHub + Discord)

You'll: put the files on GitHub (via the website, no git commands), connect Netlify to
that repo, add the environment variables, point Discord at it, and register `/submit`.

---

## STEP 1 — Put the files on GitHub (website only)
1. Make a free account at **https://github.com** (skip if you have one).
2. Click **+ (top right) → New repository**. Name it `wsb-leaderboard`. Leave it Public
   or Private. Click **Create repository**.
3. On the new repo page click **"uploading an existing file"**.
4. Open the `wsb-leaderboard-web` folder on your PC, select **everything inside** it
   (index.html, netlify.toml, package.json, DEPLOY.md, and the **netlify** folder) and
   **drag it into the browser**. The `netlify/functions` folder must come along.
5. Click **Commit changes**.

## STEP 2 — Connect Netlify to the repo (keeps your current URL)
1. Netlify → your existing site (**wsbagency-leaderboard**) → **Site configuration →
   Build & deploy → Continuous deployment → Link repository** (or "Link site to Git").
2. Choose **GitHub**, authorize, pick the `wsb-leaderboard` repo.
3. Build settings: **Build command:** leave empty. **Publish directory:** `.`
   (Netlify reads `netlify.toml` for the rest.) Click **Deploy**.
   - If Netlify won't let you link the manual site, instead: **Add new site → Import from
     GitHub → pick the repo**, then rename that new site to reuse the name, or just use its
     new URL.

## STEP 3 — Add environment variables
Netlify → Site configuration → **Environment variables** → add these (Add a variable):

| Key | Value |
|-----|-------|
| `DISCORD_PUBLIC_KEY` | f3380250c3df4110b161e693cc81819b54e8f73724977acc9fbde2e6152eb080 |
| `DISCORD_APP_ID` | 1548346231015874680 |
| `GUILD_ID` | 1524885967083802644 |
| `APPROVALS_CHANNEL_ID` | 1548345765670293646 |
| `STAFF_ROLE_IDS` | 1548348902254846063,1524887857037054082 |
| `DISCORD_BOT_TOKEN` | *(your RESET bot token — secret)* |
| `REGISTER_KEY` | *(make up any random word, e.g. wsb-secret-9271)* |

Then **Deploys → Trigger deploy → Deploy site** so the vars take effect.

## STEP 4 — Point Discord at the site
1. Developer Portal → your app → **General Information**.
2. **Interactions Endpoint URL** =
   `https://wsbagency-leaderboard.netlify.app/api/interactions`
3. **Save Changes**. Discord sends a test — if it saves with no error, it works. ✅
   (If it errors: check the deploy finished and `DISCORD_PUBLIC_KEY` is exactly right.)

## STEP 5 — Register the /submit command (once)
Open this in your browser (replace the key with your `REGISTER_KEY`):
```
https://wsbagency-leaderboard.netlify.app/.netlify/functions/register?key=YOUR_REGISTER_KEY
```
You should see **"OK — /submit registered."** Give Discord a few seconds.

## STEP 6 — Test the whole flow
1. In your server type **`/submit`** → amount `1234`, attach any image, Enter.
2. It replies "pending approval" and appears in **#leaderboard-approvals** with
   **Approve / Reject** buttons.
3. Click **Approve** → within ~30s the entry shows on
   `https://wsbagency-leaderboard.netlify.app/` (it auto-refreshes).

---

## Notes
- The bot must be **in your server** with permission to post in the approvals channel
  (same invite as before — `bot` + `applications.commands`).
- Data lives in **Netlify Blobs** (free, automatic).
- Change the count word ("sales") in `index.html` (`METRIC_LABEL`) any time, re-upload.
- Any future edit: change the file on GitHub (or re-upload) → Netlify redeploys itself.
