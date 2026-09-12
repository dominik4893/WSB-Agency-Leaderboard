// Returns approved submissions aggregated per member, for the requested period.
// The page fetches:  /api/leaderboard?period=today|week|month|lifetime
import { getStore } from "@netlify/blobs";

function subStore() {
  const siteID = process.env.BLOBS_SITE_ID, token = process.env.BLOBS_TOKEN;
  return siteID && token
    ? getStore({ name: "submissions", siteID, token })
    : getStore("submissions");
}

export const handler = async (event) => {
  const period = event.queryStringParameters?.period || "lifetime";
  const store = subStore();

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
    const { blobs } = await store.list();
    for (const b of blobs) {
      const rec = await store.get(b.key, { type: "json" });
      if (!rec || rec.status !== "approved" || !inPeriod(rec.created)) continue;
      const k = rec.userId || rec.username;
      if (!agg[k]) agg[k] = { name: rec.username, amount: 0, metric: 0 };
      agg[k].amount += Number(rec.amount) || 0;
      agg[k].metric += Number(rec.metric) || 1;
    }
  } catch (e) {
    // no data yet / store not ready -> return empty (page falls back to demo)
  }

  const list = Object.values(agg).sort((a, b) => b.amount - a.amount).slice(0, 25);
  return {
    statusCode: 200,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
    body: JSON.stringify(list),
  };
};
