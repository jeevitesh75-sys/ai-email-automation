require("dotenv").config();
const { google } = require("googleapis");
const { Groq } = require("groq-sdk"); // Switched to Groq

// Initialize Groq client
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

// Load client credentials to fix the "Could not determine client ID" error
const credentials = require("./credentials.json").web || require("./credentials.json").installed;

const auth = new google.auth.OAuth2(
  credentials.client_id,
  credentials.client_secret,
  credentials.redirect_uris[0]
);

auth.setCredentials(require("./token.json"));

const gmail = google.gmail({ version: "v1", auth });

// Global variable to hold your own email address
let myEmailAddress = "";

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
  return match ? match[1].toLowerCase().trim() : str.toLowerCase().trim();
}

// Get the authenticated user's profile email address
async function getMyProfileEmail() {
  try {
    const profile = await gmail.users.getProfile({ userId: "me" });
    myEmailAddress = profile.data.emailAddress.toLowerCase().trim();
    console.log(`👤 Operating as account: ${myEmailAddress}`);
  } catch (err) {
    console.error("❌ Failed to fetch profile email:", err.message);
  }
}

// Fetch only UNREAD emails
async function getUnreadEmails() {
  const res = await gmail.users.messages.list({
    userId: "me",
    q: "is:unread",
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

// Generate response using Groq Cloud API
async function generateReply(emailText) {
  const chatCompletion = await groq.chat.completions.create({
    messages: [
      {
        role: "system",
        content: `You are a professional assistant writing a response on behalf of B.Jeevitesh. 
Review the incoming email and draft a short, polite, and helpful response. 
Sign off the email formally as:
Best regards,
B.Jeevitesh`
      },
      {
        role: "user",
        content: `Email received:\n"${emailText}"`
      }
    ],
    model: "llama-3.3-70b-specdec", // High-quality, fast Llama 3 model on Groq
  });

  return chatCompletion.choices[0].message.content;
}

// Main execution loop
async function runBot() {
  // First, fetch your own email address to enable the self-reply filter
  await getMyProfileEmail();

  console.log("🤖 Professional Groq AI Email Bot Active & Monitoring...");

  setInterval(async () => {
    try {
      const emails = await getUnreadEmails();
      
      if (emails.length === 0) {
        return;
      }

      for (const mail of emails) {
        const full = await readEmail(mail.id);
        const sender = extractEmail(full.from);

        if (!full.body || !sender) {
          await markAsRead(mail.id);
          continue;
        }

        // Anti-Loop Filter: Skip if you sent this email to yourself
        if (sender === myEmailAddress) {
          console.log(`⏭️ Skipped self-sent email from: ${sender}`);
          await markAsRead(mail.id);
          continue;
        }

        console.log(`Processing email from: ${sender}`);

        // 1. Generate response via Groq
        const reply = await generateReply(full.body);

        // 2. Send the reply
        await sendReply(sender, full.subject, reply);
        console.log(`✅ Replied to: ${sender}`);

        // 3. Mark as read
        await markAsRead(mail.id);
      }
    } catch (err) {
      console.error("❌ FULL ERROR:");
      console.error(err);
    }
  }, 60000); // 60-second polling interval
}

runBot();

