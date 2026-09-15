// Background worker for /repost — copies one message OR a whole range of messages
// (text + embeds + re-uploaded files) into a target channel, in original order,
// then reports back by editing the deferred interaction reply.
// Runs up to 15 min (Netlify background fn).

const API = "https://discord.com/api/v10";
const MAX_MESSAGES = 50;   // safety cap for a range
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Keep only the fields Discord accepts when SENDING an embed. Drops auto-generated
// stuff (type/provider/video) so link/attachment auto-embeds don't get duplicated.
function cleanEmbed(e) {
  if (!e) return null;
  const o = {};
  if (e.title) o.title = e.title;
  if (e.description) o.description = e.description;
  if (e.url) o.url = e.url;
  if (typeof e.color === "number") o.color = e.color;
  if (e.timestamp) o.timestamp = e.timestamp;
  if (e.footer?.text) o.footer = { text: e.footer.text, icon_url: e.footer.icon_url };
  if (e.author?.name) o.author = { name: e.author.name, url: e.author.url, icon_url: e.author.icon_url };
  if (e.image?.url) o.image = { url: e.image.url };
  if (e.thumbnail?.url) o.thumbnail = { url: e.thumbnail.url };
  if (Array.isArray(e.fields) && e.fields.length)
    o.fields = e.fields.map((f) => ({ name: f.name, value: f.value, inline: !!f.inline }));
  return (o.title || o.description || o.fields || o.image || o.author) ? o : null;
}

// Snowflake IDs sort chronologically as BigInts.
const byIdAsc = (a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);

// Collect [startId .. endId] inclusive from one channel, oldest first.
async function fetchRange(srcCh, startId, endId, auth) {
  const first = await fetch(`${API}/channels/${srcCh}/messages/${startId}`, { headers: auth });
  if (!first.ok) return { error: `load start ${first.status}` };
  const start = await first.json();
  if (!endId || endId === startId) return { messages: [start] };

  const collected = [start];
  let after = startId, reachedEnd = false, guard = 0;
  while (guard++ < 30 && collected.length < MAX_MESSAGES + 1) {
    const r = await fetch(`${API}/channels/${srcCh}/messages?after=${after}&limit=100`, { headers: auth });
    if (!r.ok) break;
    const batch = await r.json();
    if (!batch.length) break;
    const asc = batch.slice().sort(byIdAsc);
    for (const m of asc) {
      collected.push(m);
      if (m.id === endId) { reachedEnd = true; break; }
      if (collected.length >= MAX_MESSAGES + 1) break;
    }
    if (reachedEnd) break;
    after = asc[asc.length - 1].id;
    await sleep(300); // be gentle on the API
  }
  let messages = collected.sort(byIdAsc);
  const cut = messages.findIndex((m) => m.id === endId);
  if (cut >= 0) messages = messages.slice(0, cut + 1);
  return { messages, reachedEnd, truncated: !reachedEnd };
}

// Re-send ONE message (text + embeds + re-uploaded files) into the target channel.
async function sendOne(msg, targetCh, auth) {
  const content = msg.content || "";
  const embeds = (msg.embeds || []).map(cleanEmbed).filter(Boolean);
  const attachments = (msg.attachments || []).slice(0, 10);
  if (!content.trim() && !embeds.length && !attachments.length) return { skipped: true };

  const payload = { allowed_mentions: { parse: [] } };
  if (content.trim()) payload.content = content;
  if (embeds.length) payload.embeds = embeds;
  const sendUrl = `${API}/channels/${targetCh}/messages`;

  if (attachments.length) {
    const form = new FormData();
    let idx = 0, failed = 0;
    for (const a of attachments) {
      try {
        const fr = await fetch(a.url);
        if (!fr.ok) { failed++; continue; }
        const bytes = new Uint8Array(await fr.arrayBuffer());
        form.append(`files[${idx}]`, new Blob([bytes]), a.filename || `file${idx}`);
        idx++;
      } catch { failed++; }
    }
    form.append("payload_json", JSON.stringify(payload));
    const res = await fetch(sendUrl, { method: "POST", headers: auth, body: form });
    return { ok: res.ok, status: res.status, failedFiles: failed };
  }

  const res = await fetch(sendUrl, {
    method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(payload),
  });
  return { ok: res.ok, status: res.status };
}

export default async (req) => {
  const { srcCh, msgId, endId, targetCh, appId, token } = await req.json().catch(() => ({}));
  const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
  const auth = { authorization: `Bot ${BOT_TOKEN}` };
  const patchUrl = `${API}/webhooks/${appId}/${token}/messages/@original`;
  const finish = (content) =>
    fetch(patchUrl, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) })
      .catch(() => {});

  if (!BOT_TOKEN || !appId || !token) return new Response("bad request", { status: 400 });

  try {
    const { messages, error, truncated } = await fetchRange(srcCh, msgId, endId, auth);
    if (error) {
      await finish(`❌ Nepodarilo sa načítať správy (${error}). Skontroluj, či má bot prístup do zdrojového kanála (View Channel + Read Message History).`);
      return new Response("ok");
    }
    if (!messages?.length) {
      await finish("❌ Žiadne správy na preposlanie.");
      return new Response("ok");
    }

    let sent = 0, skipped = 0, fileFails = 0, sendFail = null;
    for (const m of messages) {
      const r = await sendOne(m, targetCh, auth);
      if (r.skipped) { skipped++; continue; }
      if (!r.ok) { sendFail = r.status; break; }
      sent++;
      if (r.failedFiles) fileFails += r.failedFiles;
      await sleep(700); // stay under Discord's per-channel send rate limit
    }

    if (sendFail) {
      await finish(`⚠️ Preposlaných ${sent}/${messages.length} správ do <#${targetCh}>, potom to zlyhalo (${sendFail}). Skontroluj práva bota alebo veľkosť súborov.`);
      return new Response("ok");
    }

    const range = messages.length > 1 ? ` (${sent} správ)` : "";
    let note = "";
    if (fileFails) note += ` ⚠️ ${fileFails} súbor(y) sa nepreniesli (možno priveľké).`;
    if (truncated) note += ` ⚠️ Rozsah bol dlhší ako ${MAX_MESSAGES} správ — preposlaných prvých ${MAX_MESSAGES}.`;
    await finish(`✅ Preposlané do <#${targetCh}>${range} — vyzerá rovnako.${note}`);
    return new Response("ok");
  } catch (e) {
    await finish(`❌ Chyba pri preposielaní: \`${String(e).slice(0, 250)}\``);
    return new Response("ok");
  }
};
