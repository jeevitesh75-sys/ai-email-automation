require("dotenv").config();
const { google } = require("googleapis");
const { Groq } = require("groq-sdk");

// Initialize Groq client
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY,
});

let gmail;
let myEmailAddress = "";

// DIAGNOSTIC CHECK: Logs exactly what the environment sees at runtime
console.log("🔍 === RAILWAY RUNTIME ENVIRONMENT CHECK ===");
console.log("GMAIL_CREDENTIALS detected?", !!process.env.GMAIL_CREDENTIALS);
console.log("GMAIL_TOKEN detected?", !!process.env.GMAIL_TOKEN);
console.log("GROQ_API_KEY detected?", !!process.env.GROQ_API_KEY);
console.log("============================================");

try {
  if (!process.env.GMAIL_CREDENTIALS || !process.env.GMAIL_TOKEN) {
    throw new Error(`Missing vars. Status -> CREDENTIALS: ${!!process.env.GMAIL_CREDENTIALS}, TOKEN: ${!!process.env.GMAIL_TOKEN}`);
  }

  // Safely decode the Base64 strings back into raw JSON text
  const decodedCreds = Buffer.from(process.env.GMAIL_CREDENTIALS, "base64").toString("utf-8");
  const decodedToken = Buffer.from(process.env.GMAIL_TOKEN, "base64").toString("utf-8");

  const parsedCreds = JSON.parse(decodedCreds);
  const credentials = parsedCreds.web || parsedCreds.installed;
  const token = JSON.parse(decodedToken);

  const auth = new google.auth.OAuth2(
    credentials.client_id,
    credentials.client_secret,
    credentials.redirect_uris ? credentials.redirect_uris[0] : "http://localhost"
  );

  auth.setCredentials(token);
  gmail = google.gmail({ version: "v1", auth });
  
} catch (err) {
  console.error("❌ Initialization Error:", err.message);
  process.exit(1); 
}

// Safely decode base64 email bodies from incoming mail
function decodeBase64(data = "") {
  try {
    return Buffer.from(data, "base64").toString("utf-8");
  } catch {
    return "";
  }
}

// Extract clean email address from "Name <email@gmail.com>" headers
function extractEmail(str) {
  if (!str) return "";
  const match = str.match(/<(.+?)>/);
  return match ? match[1].toLowerCase().trim() : str.toLowerCase().trim();
}

// Fetch profile's email address
async function getMyProfileEmail() {
  try {
    const profile = await gmail.users.getProfile({ userId: "me" });
    myEmailAddress = profile.data.emailAddress.toLowerCase().trim();
    console.log(`👤 Operating as account: ${myEmailAddress}`);
  } catch (err) {
    console.error("❌ Failed to fetch profile email:", err.message);
  }
}

// Fetch up to 5 unread emails
async function getUnreadEmails() {
  const res = await gmail.users.messages.list({
    userId: "me",
    q: "is:unread",
    maxResults: 5,
  });

  return res.data.messages || [];
}

// Read and parse incoming email structures
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

// Construct and transmit the raw email string back
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

// Remove the unread flag
async function markAsRead(id) {
  await gmail.users.messages.batchModify({
    userId: "me",
    requestBody: {
      ids: [id],
      removeLabelIds: ["UNREAD"],
    },
  });
}

// Query Groq safely with built-in fallback to stop application crashes
async function generateReply(emailText) {
  try {
    const chatCompletion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile", 
      messages: [
        {
          role: "system",
          content: "You are a professional assistant writing a response on behalf of B.Jeevitesh. Review the incoming email and draft a short, polite, and helpful response. Sign off the email formally as:\nBest regards,\nB.Jeevitesh"
        },
        {
          role: "user",
          content: `Email received:\n"${emailText}"`
        }
      ],
      temperature: 0.5,
      max_tokens: 1024
    });

    if (chatCompletion && chatCompletion.choices && chatCompletion.choices[0].message) {
      return chatCompletion.choices[0].message.content;
    }
    throw new Error("Unexpected empty completion response payload from Groq.");
  } catch (groqError) {
    console.error("⚠️ Groq API Generation error:", groqError.message);
    return "Thank you for reaching out. I have received your email and will review the details carefully to get back to you as soon as possible.\n\nBest regards,\nB.Jeevitesh";
  }
}

// Core execution loop
async function runBot() {
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

        // Anti-Spam / Anti-Loop Self Check
        if (sender === myEmailAddress) {
          console.log(`\u23ed\ufe0f Skipped self-sent email from: ${sender}`);
          await markAsRead(mail.id);
          continue;
        }

        console.log(`Processing email from: ${sender}`);

        // 1. Generate text
        const reply = await generateReply(full.body);

        // 2. Dispatch response mail
        await sendReply(sender, full.subject, reply);
        console.log(`\u2705 Replied to: ${sender}`);

        // 3. Flag completed
        await markAsRead(mail.id);
      }
    } catch (err) {
      console.error("\u274c Operational Loop Error:", err.message);
    }
  }, 60000); 
}

runBot();

