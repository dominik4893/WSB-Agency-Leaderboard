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
    // if a file is attached, stash its URL so we can send it after the modal
    let fileKey = "";
    if (opts.file) {
      const att = body.data.resolved?.attachments?.[opts.file];
      if (att?.url) {
        fileKey = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        await postFilesStore().setJSON(fileKey, { url: att.url, filename: att.filename || "file" }).catch(() => {});
      }
    }
    return reply({
      type: InteractionResponseType.MODAL,
      data: {
        custom_id: `postmodal:${opts.channel}:${fileKey}`,
        title: "Správa pre kanál",
        components: [{ type: 1, components: [
          { type: 4, custom_id: "content", label: "Text správy (markdown, do 4000 znakov)", style: 2, required: true, max_length: 4000 },
        ]}],
      },
    });
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
      if (!BOT_TOKEN || !content.trim())
        return reply({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: 64, content: "❌ Prázdna správa alebo chýba token." } });

      const embed = {
        description: content,
        color: 0x8b5cf6,
        image: { url: "https://wsbagency-leaderboard.netlify.app/bar.png" },
      };
      const url = `https://discord.com/api/v10/channels/${id}/messages`;
      const mentions = { parse: ["users", "roles", "everyone"] };

      // With an attached file: download it and re-upload as multipart.
      if (fileKey) {
        const info = await postFilesStore().get(fileKey, { type: "json" }).catch(() => null);
        await postFilesStore().delete(fileKey).catch(() => {});
        if (!info?.url)
          return reply({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: 64, content: "❌ Súbor sa nenašiel, skús znova." } });
        const fr = await fetch(info.url);
        if (!fr.ok)
          return reply({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: 64, content: "❌ Nepodarilo sa načítať súbor." } });
        const bytes = new Uint8Array(await fr.arrayBuffer());
        // 1) the embed (text box) on top
        const r1 = await fetch(url, {
          method: "POST", headers: { authorization: `Bot ${BOT_TOKEN}`, "content-type": "application/json" },
          body: JSON.stringify({ embeds: [embed], allowed_mentions: mentions }),
        });
        // 2) the file right below, as its own message
        const form = new FormData();
        form.append("payload_json", JSON.stringify({ allowed_mentions: { parse: [] } }));
        form.append("files[0]", new Blob([bytes]), info.filename || "file");
        const r2 = await fetch(url, { method: "POST", headers: { authorization: `Bot ${BOT_TOKEN}` }, body: form });
        return reply({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { flags: 64, content: (r1.ok && r2.ok) ? "✅ Embed a súbor odoslané do kanála." : "❌ Odoslanie zlyhalo — bot možno nemá prístup do kanála, alebo je súbor priveľký." } });
      }

      // No file: plain embed.
      const res = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bot ${BOT_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ embeds: [embed], allowed_mentions: mentions }),
      });
      return reply({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: { flags: 64, content: res.ok ? "✅ Správa odoslaná do kanála." : "❌ Nepodarilo sa odoslať — bot možno nemá prístup do toho kanála." },
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
