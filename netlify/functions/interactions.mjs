// Discord Interactions endpoint — handles /submit and Approve/Reject buttons.
// Set the app's "Interactions Endpoint URL" to:  https://<your-site>/api/interactions
import { verifyKey, InteractionType, InteractionResponseType } from "discord-interactions";
import { getStore } from "@netlify/blobs";
import { postOrUpdateLeaderboard } from "../lib/lb.mjs";

const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const APPROVALS_CHANNEL_ID = process.env.APPROVALS_CHANNEL_ID;
const STAFF_ROLE_IDS = (process.env.STAFF_ROLE_IDS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const TICKETY_CATEGORY_ID = process.env.TICKETY_CATEGORY_ID;   // only allow /submit in tickets

function subStore() {
  const siteID = process.env.BLOBS_SITE_ID, token = process.env.BLOBS_TOKEN;
  return siteID && token
    ? getStore({ name: "submissions", siteID, token })
    : getStore("submissions");
}
function postFilesStore() {
  const siteID = process.env.BLOBS_SITE_ID, token = process.env.BLOBS_TOKEN;
  return siteID && token
    ? getStore({ name: "postfiles", siteID, token })
    : getStore("postfiles");
}

const usd = (n) => "$" + Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });

// Parse amounts the way people actually type them:
//   "40"      -> 40      "40.00" -> 40      "40,00" -> 40 (EU decimal comma)
//   "1,234.56"-> 1234.56 "1.234,56" -> 1234.56   "4,000" -> 4000
function parseAmount(input) {
  let s = String(input ?? "").trim().replace(/[^\d.,-]/g, "");
  if (!s) return 0;
  const hasComma = s.includes(","), hasDot = s.includes(".");
  if (hasComma && hasDot) {
    // the LAST separator is the decimal one
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if (hasComma) {
    const parts = s.split(",");
    // "40,00" -> decimal; "4,000" / "4,000,000" -> thousands
    s = parts[parts.length - 1].length === 2 ? s.replace(/,/g, ".").replace(/\.(?=.*\.)/g, "")
                                             : s.replace(/,/g, "");
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}
// Parse a Discord message link or bare ID into { channelId, messageId }.
//   https://discord.com/channels/<guild>/<channel>/<message>  -> from link
//   "123456789012345678"                                      -> id, use fallback channel
function parseMsgRef(input, fallbackChannel) {
  const s = String(input || "").trim();
  const m = s.match(/channels\/(\d+)\/(\d+)\/(\d+)/);
  if (m) return { channelId: m[2], messageId: m[3] };
  if (/^\d{5,}$/.test(s)) return { channelId: fallbackChannel, messageId: s };
  return null;
}
const reply = (obj, status = 200) => ({
  statusCode: status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(obj),
});

export const handler = async (event) => {
  const sig = event.headers["x-signature-ed25519"];
  const ts = event.headers["x-signature-timestamp"];
  const raw = event.body || "";

  // Discord requires signature verification on this endpoint.
  const valid = sig && ts && (await verifyKey(raw, sig, ts, PUBLIC_KEY));
  if (!valid) return { statusCode: 401, body: "invalid request signature" };

  const body = JSON.parse(raw);
  if (body.type === InteractionType.PING)
    return reply({ type: InteractionResponseType.PONG });

  const store = subStore();

  // ---- /submit ----
  if (body.type === InteractionType.APPLICATION_COMMAND && body.data?.name === "submit") {
    // Only allow inside a ticket in the TICKETY category.
    if (TICKETY_CATEGORY_ID && body.channel?.parent_id !== TICKETY_CATEGORY_ID) {
      return reply({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: 64, content: "❌ `/submit` funguje len v tvojom tickete. Otvor si tiket v #leaderboard-ticket a pošli výsledok tam." },
      });
    }
    const opts = Object.fromEntries((body.data.options || []).map((o) => [o.name, o.value]));
    const amount = parseAmount(opts.amount);
    if (!(amount > 0)) {
      return reply({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: 64, content: "❌ Zadaj platnú **sumu** — číslo väčšie ako 0 (napr. `100` alebo `100,50`). Nie slová ani 0." } });
    }
    const metric = opts.honici == null ? 1 : Number(opts.honici);
    if (!(metric >= 1)) {
      return reply({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: 64, content: "❌ Počet **honičov** musí byť číslo väčšie ako 0." } });
    }
    const proofUrl = opts.proof ? body.data.resolved?.attachments?.[opts.proof]?.url : null;
    const user = body.member?.user || body.user;
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    await store.setJSON(id, {
      id, userId: user.id,
      username: body.member?.nick || user.global_name || user.username,
      amount, metric, proofUrl, status: "pending", created: new Date().toISOString(),
      channelId: body.channel_id,
    });

    // post to the private approvals channel with Approve/Reject buttons
    if (BOT_TOKEN && APPROVALS_CHANNEL_ID) {
      await fetch(`https://discord.com/api/v10/channels/${APPROVALS_CHANNEL_ID}/messages`, {
        method: "POST",
        headers: { authorization: `Bot ${BOT_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          embeds: [{
            title: "🕓 New submission — needs review", color: 0x8b5cf6,
            fields: [
              { name: "Member", value: `<@${user.id}>`, inline: true },
              { name: "Amount", value: usd(amount), inline: true },
              { name: "Count", value: String(metric), inline: true },
              { name: "ID", value: id, inline: true },
            ],
            image: proofUrl ? { url: proofUrl } : undefined,
          }],
          components: [{
            type: 1, components: [
              { type: 2, style: 3, label: "Approve", custom_id: `approve:${id}` },
              { type: 2, style: 4, label: "Reject", custom_id: `reject:${id}` },
            ],
          }],
        }),
      }).catch(() => {});
    }

    // Visible confirmation in the ticket channel (not ephemeral).
    return reply({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { content: `✅ <@${user.id}>, tvoj výsledok **${usd(amount)}** bol odoslaný a čaká na schválenie. Po schválení sa objavíš na leaderboarde. 🏆` },
    });
  }

  // ---- /post (staff sends a message as the bot) ----
  if (body.type === InteractionType.APPLICATION_COMMAND && body.data?.name === "post") {
    const roles = body.member?.roles || [];
    const isStaff = STAFF_ROLE_IDS.length === 0 || roles.some((r) => STAFF_ROLE_IDS.includes(r));
    if (!isStaff)
      return reply({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: 64, content: "Staff only." } });
    const opts = Object.fromEntries((body.data.options || []).map((o) => [o.name, o.value]));
    // collect every attached file (file, file2..file5) and stash them for after the modal
    const atts = body.data.resolved?.attachments || {};
    const files = [];
    for (const o of (body.data.options || [])) {
      if (/^file\d*$/.test(o.name)) {
        const att = atts[o.value];
        if (att?.url) files.push({ url: att.url, filename: att.filename || "file" });
      }
    }
    let fileKey = "";
    if (files.length) {
      fileKey = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      await postFilesStore().setJSON(fileKey, { files }).catch(() => {});
    }
    return reply({
      type: InteractionResponseType.MODAL,
      data: {
        custom_id: `postmodal:${opts.channel}:${fileKey}`,
        title: "Správa pre kanál",
        components: [{ type: 1, components: [
          // optional: leave blank to send only the file(s)
          { type: 4, custom_id: "content", label: "Text (prázdne = len súbor)", style: 2, required: false, max_length: 4000 },
        ]}],
      },
    });
  }

  // ---- /repost (staff copy a whole message into another channel) ----
  if (body.type === InteractionType.APPLICATION_COMMAND && body.data?.name === "repost") {
    const roles = body.member?.roles || [];
    const isStaff = STAFF_ROLE_IDS.length === 0 || roles.some((r) => STAFF_ROLE_IDS.includes(r));
    if (!isStaff)
      return reply({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: 64, content: "Staff only." } });

    const opts = Object.fromEntries((body.data.options || []).map((o) => [o.name, o.value]));
    const ref = parseMsgRef(opts.message, opts.source || body.channel_id);
    if (!ref)
      return reply({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: 64, content: "❌ Neplatný odkaz/ID správy. Klikni pravým na správu → **Copy Message Link** a vlož to." } });

    // Optional end-of-range message. Must live in the same source channel as the start.
    let endId = null;
    if (opts.until) {
      const endRef = parseMsgRef(opts.until, ref.channelId);
      if (!endRef || endRef.channelId !== ref.channelId)
        return reply({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { flags: 64, content: "❌ `until` musí byť správa z **rovnakého kanála** ako prvá správa." } });
      endId = endRef.messageId;
    }

    // Kick off the heavy copy in a background function (re-uploading files can take >3s).
    const base = process.env.URL || "https://wsbagency-leaderboard.netlify.app";
    fetch(`${base}/.netlify/functions/repost-background`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        srcCh: ref.channelId, msgId: ref.messageId, endId, targetCh: opts.channel,
        appId: body.application_id, token: body.token,
      }),
    }).catch(() => {});

    // Deferred ephemeral ack — the background function edits this with the result.
    return reply({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: 64 } });
  }

  // ---- /updatelb (staff refresh the leaderboard embed) ----
  if (body.type === InteractionType.APPLICATION_COMMAND && body.data?.name === "updatelb") {
    const roles = body.member?.roles || [];
    const isStaff = STAFF_ROLE_IDS.length === 0 || roles.some((r) => STAFF_ROLE_IDS.includes(r));
    if (!isStaff)
      return reply({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: 64, content: "Staff only." } });
    const opts = Object.fromEntries((body.data.options || []).map((o) => [o.name, o.value]));
    const res = await postOrUpdateLeaderboard(opts.period || "month");
    return reply({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: 64, content: res.ok ? "✅ Leaderboard aktualizovaný." : `❌ ${res.error}` },
    });
  }

  // ---- Approve / Reject buttons ----
  if (body.type === InteractionType.MESSAGE_COMPONENT) {
    const [action, id] = (body.data.custom_id || "").split(":");
    const roles = body.member?.roles || [];
    const isStaff = STAFF_ROLE_IDS.length === 0 || roles.some((r) => STAFF_ROLE_IDS.includes(r));
    if (!isStaff)
      return reply({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: 64, content: "Staff only." } });

    if (action === "reject") {
      // ask the staffer for a reason via a popup
      return reply({
        type: InteractionResponseType.MODAL,
        data: {
          custom_id: `rejectmodal:${id}`,
          title: "Dôvod zamietnutia",
          components: [{ type: 1, components: [
            { type: 4, custom_id: "reason", label: "Prečo zamietaš tento výsledok?", style: 2, required: true, max_length: 400 },
          ]}],
        },
      });
    }

    // approve
    const rec = await store.get(id, { type: "json" });
    if (!rec)
      return reply({ type: InteractionResponseType.UPDATE_MESSAGE, data: { content: "Submission not found.", embeds: [], components: [] } });
    rec.status = "approved";
    await store.setJSON(id, rec);
    const who = body.member?.user?.username || "staff";
    if (BOT_TOKEN && rec.channelId) {
      await fetch(`https://discord.com/api/v10/channels/${rec.channelId}/messages`, {
        method: "POST", headers: { authorization: `Bot ${BOT_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ content: `✅ <@${rec.userId}> tvoj výsledok **${usd(rec.amount)}** bol schválený a je na leaderboarde! 🏆` }),
      }).catch(() => {});
    }
    // auto-refresh the pinned leaderboard embed right after approval
    try { await postOrUpdateLeaderboard(process.env.LB_PERIOD || "month"); } catch (e) { /* leaderboard update is best-effort */ }
    return reply({
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: { content: `✅ Approved by ${who} — ${rec.username}: ${usd(rec.amount)}`, embeds: [], components: [] },
    });
  }

  // ---- Modal submissions ----
  if (body.type === InteractionType.MODAL_SUBMIT) {
    const [tag, id, fileKey] = (body.data.custom_id || "").split(":");
    const roles = body.member?.roles || [];
    const isStaff = STAFF_ROLE_IDS.length === 0 || roles.some((r) => STAFF_ROLE_IDS.includes(r));
    if (!isStaff)
      return reply({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: 64, content: "Staff only." } });

    // /post -> send the pasted message (and optional file) as the bot into the chosen channel
    if (tag === "postmodal") {
      const content = body.data.components?.[0]?.components?.[0]?.value || "";
      if (!BOT_TOKEN)
        return reply({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: 64, content: "❌ Chýba token." } });

      // load any stashed files (supports both new {files:[...]} and old {url,filename})
      let files = [];
      if (fileKey) {
        const info = await postFilesStore().get(fileKey, { type: "json" }).catch(() => null);
        await postFilesStore().delete(fileKey).catch(() => {});
        files = Array.isArray(info?.files) ? info.files
              : (info?.url ? [{ url: info.url, filename: info.filename || "file" }] : []);
      }

      if (!content.trim() && !files.length)
        return reply({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: 64, content: "❌ Nič na odoslanie — napíš text alebo priloz súbor." } });

      const url = `https://discord.com/api/v10/channels/${id}/messages`;
      const mentions = { parse: ["users", "roles", "everyone"] };

      // 1) text embed on top — only if there is text
      let r1ok = true;
      if (content.trim()) {
        const embed = {
          description: content,
          color: 0x8b5cf6,
          image: { url: "https://wsbagency-leaderboard.netlify.app/bar.png" },
        };
        const r1 = await fetch(url, {
          method: "POST", headers: { authorization: `Bot ${BOT_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ embeds: [embed], allowed_mentions: mentions }),
        });
        r1ok = r1.ok;
      }

      // 2) all files together, in one message below (Discord allows up to 10)
      let r2ok = true;
      if (files.length) {
        const form = new FormData();
        form.append("payload_json", JSON.stringify({ allowed_mentions: { parse: [] } }));
        let idx = 0;
        for (const f of files.slice(0, 10)) {
          const fr = await fetch(f.url);
          if (!fr.ok) continue;
          const bytes = new Uint8Array(await fr.arrayBuffer());
          form.append(`files[${idx}]`, new Blob([bytes]), f.filename || `file${idx}`);
          idx++;
        }
        if (idx === 0) r2ok = false;
        else {
          const r2 = await fetch(url, { method: "POST", headers: { authorization: `Bot ${BOT_TOKEN}` }, body: form });
          r2ok = r2.ok;
        }
      }

      const ok = r1ok && r2ok;
      const okMsg = (content.trim() && files.length) ? "✅ Text a súbory odoslané do kanála."
                  : files.length ? "✅ Súbor(y) odoslané do kanála."
                  : "✅ Správa odoslaná do kanála.";
      return reply({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: 64, content: ok ? okMsg : "❌ Odoslanie zlyhalo — bot možno nemá prístup do kanála, alebo je súbor priveľký." },
      });
    }

    if (tag !== "rejectmodal") return reply({ type: InteractionResponseType.PONG });

    const reason = body.data.components?.[0]?.components?.[0]?.value || "—";
    const rec = await store.get(id, { type: "json" });
    if (!rec)
      return reply({ type: InteractionResponseType.UPDATE_MESSAGE, data: { content: "Submission not found.", embeds: [], components: [] } });
    rec.status = "rejected";
    rec.reason = reason;
    await store.setJSON(id, rec);

    const who = body.member?.user?.username || "staff";
    if (BOT_TOKEN && rec.channelId) {
      await fetch(`https://discord.com/api/v10/channels/${rec.channelId}/messages`, {
        method: "POST", headers: { authorization: `Bot ${BOT_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ content: `❌ <@${rec.userId}> tvoj výsledok **${usd(rec.amount)}** bol zamietnutý.\n**Dôvod:** ${reason}` }),
      }).catch(() => {});
    }
    return reply({
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: { content: `❌ Rejected by ${who} — ${rec.username}: ${usd(rec.amount)}\n**Reason:** ${reason}`, embeds: [], components: [] },
    });
  }

  return reply({ type: InteractionResponseType.PONG });
};
