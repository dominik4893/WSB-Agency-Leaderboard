// Discord Interactions endpoint — handles /submit and Approve/Reject buttons.
// Set the app's "Interactions Endpoint URL" to:  https://<your-site>/api/interactions
import { verifyKey, InteractionType, InteractionResponseType } from "discord-interactions";
import { getStore } from "@netlify/blobs";

const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const APPROVALS_CHANNEL_ID = process.env.APPROVALS_CHANNEL_ID;
const STAFF_ROLE_IDS = (process.env.STAFF_ROLE_IDS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

function subStore() {
  const siteID = process.env.BLOBS_SITE_ID, token = process.env.BLOBS_TOKEN;
  return siteID && token
    ? getStore({ name: "submissions", siteID, token })
    : getStore("submissions");
}

const usd = (n) => "$" + Number(n || 0).toLocaleString("en-US");
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
    const opts = Object.fromEntries((body.data.options || []).map((o) => [o.name, o.value]));
    const amount = Number(opts.amount) || 0;
    const metric = Number(opts.count) || 1;
    const proofUrl = opts.proof ? body.data.resolved?.attachments?.[opts.proof]?.url : null;
    const user = body.member?.user || body.user;
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    await store.setJSON(id, {
      id, userId: user.id,
      username: body.member?.nick || user.global_name || user.username,
      amount, metric, proofUrl, status: "pending", created: new Date().toISOString(),
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

    return reply({
      type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
      data: { flags: 64, content: `✅ Submitted **${usd(amount)}**. Pending staff approval — you'll appear on the board once approved.` },
    });
  }

  // ---- Approve / Reject button ----
  if (body.type === InteractionType.MESSAGE_COMPONENT) {
    const [action, id] = (body.data.custom_id || "").split(":");
    const roles = body.member?.roles || [];
    const isStaff = STAFF_ROLE_IDS.length === 0 || roles.some((r) => STAFF_ROLE_IDS.includes(r));
    if (!isStaff)
      return reply({ type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE, data: { flags: 64, content: "Staff only." } });

    const rec = await store.get(id, { type: "json" });
    if (!rec)
      return reply({ type: InteractionResponseType.UPDATE_MESSAGE, data: { content: "Submission not found.", embeds: [], components: [] } });

    rec.status = action === "approve" ? "approved" : "rejected";
    await store.setJSON(id, rec);

    const who = body.member?.user?.username || "staff";
    const verb = rec.status === "approved" ? "✅ Approved" : "❌ Rejected";
    return reply({
      type: InteractionResponseType.UPDATE_MESSAGE,
      data: { content: `${verb} by ${who} — ${rec.username}: ${usd(rec.amount)}`, embeds: [], components: [] },
    });
  }

  return reply({ type: InteractionResponseType.PONG });
};
