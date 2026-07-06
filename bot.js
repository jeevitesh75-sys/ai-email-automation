require("dotenv").config();
const { google } = require("googleapis");
const { GoogleGenAI } = require("@google/genai");

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

// OAuth client setup
// OAuth client setup (Railway)
const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS).installed;
const token = JSON.parse(process.env.GOOGLE_TOKEN);

const auth = new google.auth.OAuth2(
  credentials.client_id,
  credentials.client_secret,
  credentials.redirect_uris[0]
);

auth.setCredentials(token);

const gmail = google.gmail({
  version: "v1",
  auth,
});

// Safely decode base64 email bodies
function decodeBase64(data = "") {
  try {
    return Buffer.from(data, "base64").toString("utf-8");
  } catch {
    return "";
  }
}

// Extract email from "Name <email@gmail.com>" string
function extractEmail(str) {
  if (!str) return "";
  const match = str.match(/<(.+?)>/);
  return match ? match[1] : str;
}

// Fetch only UNREAD emails
async function getUnreadEmails() {
  const res = await gmail.users.messages.list({
    userId: "me",
    q: "is:unread", // Crucial: Only grab emails that need attention
    maxResults: 5,
  });

  return res.data.messages || [];
}

// Read and parse email content
async function readEmail(id) {
  const res = await gmail.users.messages.get({
    userId: "me",
    id,
  });

  const payload = res.data.payload;
  const headers = payload.headers || [];

  let from = "";
  let subject = "";

  headers.forEach((h) => {
    if (h.name === "From") from = h.value;
    if (h.name === "Subject") subject = h.value;
  });

  let body = "";
  if (payload.parts && payload.parts.length) {
    // Look for plain text component
    const part = payload.parts.find(p => p.mimeType === "text/plain");
    body = decodeBase64(part?.body?.data || "");
  } else {
    body = decodeBase64(payload.body?.data || "");
  }

  return { id, from, subject, body };
}

// Send email reply
async function sendReply(to, subject, message) {
  const email = [
    `To: ${to}`,
    `Subject: Re: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    message,
  ].join("\n");

  const encodedMessage = Buffer.from(email)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw: encodedMessage,
    },
  });
}

// Archive/Mark email as read so it isn't processed again
async function markAsRead(id) {
  await gmail.users.messages.batchModify({
    userId: "me",
    requestBody: {
      ids: [id],
      removeLabelIds: ["UNREAD"],
    },
  });
}

// Generate an intelligent, contextual response
async function generateReply(emailText) {
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: `
You are a professional assistant writing a response on behalf of B.Jeevitesh.

Review the following email and draft a short, polite, and helpful response.
Sign off the email formally as:
Best regards,
B.Jeevitesh

Email received:
"${emailText}"
`,
  });

  return response.text;
}

// Main execution loop
async function runBot() {
  console.log("🤖 Professional AI Email Bot Active & Monitoring...");

  setInterval(async () => {
    try {
      const emails = await getUnreadEmails();

      if (emails.length === 0) {
        console.log("No new unread emails.");
        return;
      }

      for (const mail of emails) {
        const full = await readEmail(mail.id);
        const sender = extractEmail(full.from);

if (
  sender.toLowerCase() === process.env.EMAIL_USER.toLowerCase()
) {
  await markAsRead(mail.id);
  continue;
}
        if (!full.body || !sender) {
          await markAsRead(mail.id); // Clear it anyway so it doesn't stall the queue
          continue;
        }

console.log(`Processing email from: ${sender}`);

// 1. Generate the AI response
let reply;

try {
  reply = await generateReply(full.body);
} catch (e) {
  if (e.status === 429) {
    console.log("⚠️ Gemini quota exceeded. Using fallback reply.");

    reply = `Thank you for your email. I have received your message and will get back to you as soon as possible.

Best regards,
B.Jeevitesh`;
  } else {
    throw e;
  }
}

// 2. Send the reply
await sendReply(sender, full.subject, reply);
console.log(`✅ Replied to: ${sender}`);

// 3. Mark as read
await markAsRead(mail.id);      }

    }
catch (err) {
  console.error("❌ FULL ERROR:");
  console.error(err);

  console.error("Message:", err.message);
  console.error("Stack:", err.stack);

  if (err.response) {
    console.error("Response:");
    console.error(err.response.data);
  }

  if (err.cause) {
    console.error("Cause:");
    console.error(err.cause);
  }
}

}, 60000);}

runBot();
