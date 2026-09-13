// Shared leaderboard logic: aggregate approved submissions, build the embed,
// and post/update the single leaderboard message in the LB channel.
import { getStore } from "@netlify/blobs";

function store(name) {
  const siteID = process.env.BLOBS_SITE_ID, token = process.env.BLOBS_TOKEN;
  return siteID && token ? getStore({ name, siteID, token }) : getStore(name);
}
const usd = (n) => "$" + Number(n || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export async function aggregate(period = "month") {
  const s = store("submissions");
  const now = new Date();
  const inPeriod = (iso) => {
    const d = new Date(iso);
    if (period === "today") return d.toDateString() === now.toDateString();
    if (period === "week") return (now - d) / 86400000 <= 7;
    if (period === "month") return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    return true; // lifetime
  };
  const agg = {};
  try {
    const { blobs } = await s.list();
    for (const b of blobs) {
      const rec = await s.get(b.key, { type: "json" });
      if (!rec || rec.status !== "approved" || !inPeriod(rec.created)) continue;
      const k = rec.userId || rec.username;
      if (!agg[k]) agg[k] = { name: rec.username, amount: 0, deals: 0 };
      agg[k].amount += Number(rec.amount) || 0;
      agg[k].deals += Number(rec.metric) || 1;
    }
  } catch (e) { /* empty */ }
  return Object.values(agg).sort((a, b) => b.amount - a.amount);
}

export function buildEmbed(list, period) {
  const labels = { today: "Today", week: "This Week", month: "This Month", lifetime: "Lifetime" };
  const medals = { 0: "🥇", 1: "🥈", 2: "🥉" };
  const top = list.slice(0, 10);
  const lines = top.length
    ? top.map((p, i) => `${medals[i] || `\`#${i + 1}\``} **${p.name}** — ${usd(p.amount)} (${p.deals} honiči)`).join("\n")
    : "_Zatiaľ žiadne výsledky._";
  const totalDeals = list.reduce((a, p) => a + p.deals, 0);
  const totalPremium = list.reduce((a, p) => a + p.amount, 0);
  const desc =
    lines +
    "\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n" +
    "📊 **Agency Totals**\n" +
    `📄 Total honiči: **${totalDeals}**\n` +
    `💰 Total premium: **${usd(totalPremium)}**`;
  return {
    title: `🏆 WSB Agency Leaderboard — ${labels[period] || period}`,
    description: desc,
    color: 0x8b5cf6,
    image: { url: "https://wsbagency-leaderboard.netlify.app/bar.png" },
    footer: { text: "Last updated" },
    timestamp: new Date().toISOString(),
  };
}

export async function postOrUpdateLeaderboard(period = "month") {
  const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
  const LB_CHANNEL_ID = process.env.LB_CHANNEL_ID;
  if (!BOT_TOKEN || !LB_CHANNEL_ID) return { ok: false, error: "missing LB_CHANNEL_ID or DISCORD_BOT_TOKEN" };

  const embed = buildEmbed(await aggregate(period), period);
  const meta = store("meta");
  const auth = { authorization: `Bot ${BOT_TOKEN}`, "content-type": "application/json" };

  let ref = null;
  try { ref = await meta.get("lb_message", { type: "json" }); } catch (e) { /* none yet */ }

  // Try to edit the existing message in place.
  if (ref?.channelId && ref?.messageId) {
    const r = await fetch(`https://discord.com/api/v10/channels/${ref.channelId}/messages/${ref.messageId}`, {
      method: "PATCH", headers: auth, body: JSON.stringify({ embeds: [embed] }),
    });
    if (r.ok) return { ok: true, edited: true };
  }

  // Otherwise post a new one and remember its id.
  const r = await fetch(`https://discord.com/api/v10/channels/${LB_CHANNEL_ID}/messages`, {
    method: "POST", headers: auth, body: JSON.stringify({ embeds: [embed] }),
  });
  if (!r.ok) return { ok: false, error: `post failed ${r.status}` };
  const msg = await r.json();
  await meta.setJSON("lb_message", { channelId: LB_CHANNEL_ID, messageId: msg.id });
  return { ok: true, posted: true };
}
