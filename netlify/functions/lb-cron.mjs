// Scheduled auto-update of the leaderboard embed (~every 5 days).
import { postOrUpdateLeaderboard } from "../lib/lb.mjs";

export default async () => {
  const period = process.env.LB_PERIOD || "month";
  const res = await postOrUpdateLeaderboard(period);
  console.log("lb-cron:", JSON.stringify(res));
  return new Response("ok");
};

// Runs at 12:00 UTC on days 1, 6, 11, 16, 21, 26 — roughly every 5 days.
export const config = { schedule: "0 12 */5 * *" };
