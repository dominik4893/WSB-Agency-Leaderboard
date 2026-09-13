// One-time slash-command registration. Visit once in your browser:
//   https://<your-site>/.netlify/functions/register?key=YOUR_REGISTER_KEY
// It registers /submit in your server. Safe to re-run (it overwrites).
const APP_ID = process.env.DISCORD_APP_ID;
const GUILD_ID = process.env.GUILD_ID;
const BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;

const COMMANDS = [
  {
    name: "submit",
    description: "Submit your earnings with a proof screenshot.",
    options: [
      { name: "amount", description: "How much you earned, e.g. 40 or 40,00 or 1.234,56", type: 3, required: true },   // STRING (we parse it)
      { name: "proof", description: "Screenshot proof.", type: 11, required: true },                        // ATTACHMENT
      { name: "count", description: "How many (sales/etc). Default 1.", type: 4, required: false },         // INTEGER
    ],
  },
  {
    name: "post",
    description: "(staff) Send a message as the bot into a channel.",
    options: [
      { name: "channel", description: "Which channel to post in.", type: 7, required: true },   // CHANNEL
    ],
  },
];

export const handler = async (event) => {
  if ((event.queryStringParameters?.key || "") !== process.env.REGISTER_KEY)
    return { statusCode: 401, body: "unauthorized" };
  if (!APP_ID || !GUILD_ID || !BOT_TOKEN)
    return { statusCode: 500, body: "missing DISCORD_APP_ID / GUILD_ID / DISCORD_BOT_TOKEN env vars" };

  const res = await fetch(
    `https://discord.com/api/v10/applications/${APP_ID}/guilds/${GUILD_ID}/commands`,
    {
      method: "PUT",
      headers: { authorization: `Bot ${BOT_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify(COMMANDS),
    }
  );
  const text = await res.text();
  return {
    statusCode: res.status,
    headers: { "content-type": "application/json" },
    body: res.ok ? `OK — /submit registered.\n\n${text}` : `Error ${res.status}\n\n${text}`,
  };
};
