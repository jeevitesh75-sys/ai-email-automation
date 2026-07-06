require("dotenv").config();

const express = require("express");
const nodemailer = require("nodemailer");
const { GoogleGenAI } = require("@google/genai");

const app = express();

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

app.use(express.json());
app.use(express.static("public"));

const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

app.post("/send-email", async (req, res) => {
  const { to, subject, message } = req.body;

  try {
    // Ask Gemini to write the email
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: `
You are a professional email writer.

Write a professional email.

Subject: ${subject}

Instructions:
${message}

Return only the email body. Do not include markdown or explanations.
`,
    });

    const aiEmail = response.text;

    // Send the AI-generated email
    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to,
      subject,
      text: aiEmail,
    });

    res.json({
      success: true,
      message: "AI email generated and sent successfully!",
      generatedEmail: aiEmail,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.listen(3000, () => {
  console.log("🚀 Server running at http://127.0.0.1:3000");
});
