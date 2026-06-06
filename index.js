require("dotenv").config();

const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("memory.db");

const { GoogleGenAI } = require("@google/genai");
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

const {
  default: makeWASocket,
  useMultiFileAuthState,
} = require("@whiskeysockets/baileys");

const qrcode = require("qrcode-terminal");

// =========================
// DATABASE
// =========================

db.run(`
CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT,
    role TEXT,
    message TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
)
`);
db.run(`
CREATE TABLE IF NOT EXISTS user_profiles (
    user_id TEXT PRIMARY KEY,
    name TEXT,
    favorite_team TEXT,
    interests TEXT
)
`);

function saveMessage(userId, role, message) {
  db.run(
    `INSERT INTO conversations (user_id, role, message)
     VALUES (?, ?, ?)`,
    [userId, role, message]
  );
}

function getHistory(userId) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT role, message
       FROM conversations
       WHERE user_id = ?
       ORDER BY id DESC
       LIMIT 10`,
      [userId],
      (err, rows) => {
        if (err) reject(err);
        else resolve(rows.reverse());
      }
    );
  });
}

function saveProfile(userId, field, value) {
  db.run(
    `INSERT INTO user_profiles (user_id, ${field})
     VALUES (?, ?)
     ON CONFLICT(user_id)
     DO UPDATE SET ${field} = excluded.${field}`,
    [userId, value]
  );
}

function getProfile(userId) {
  return new Promise((resolve, reject) => {
    db.get(
      `SELECT * FROM user_profiles WHERE user_id = ?`,
      [userId],
      (err, row) => {
        if (err) reject(err);
        else resolve(row || {});
      }
    );
  });
}

// =========================
// GEMINI
// =========================

async function getAIResponse(prompt) {
  const models = [
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
  ];

  for (const model of models) {
    try {
      console.log(`Trying model: ${model}`);

      const response = await ai.models.generateContent({
        model,
        contents: prompt,
      });

      if (response.text) {
        console.log(`Success with ${model}`);
        return response.text;
      }
    } catch (error) {
      console.log(`Failed: ${model}`);
      console.error(error);

      if (error.status === 503) {
        continue;
      }
 
      console.error(error);
    }
  }

  throw new Error("All Gemini models unavailable");
}

// =========================
// BOT
// =========================

async function startBot() {
  const { state, saveCreds } =
    await useMultiFileAuthState("./auth_info");

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, qr } = update;

    if (qr) {
      qrcode.generate(qr, {
        small: true,
      });
    }

    if (connection === "open") {
      console.log("✅ Haffy AI Connected!");
    }
  });

sock.ev.on("messages.upsert", async ({ messages }) => {
  try {
    const msg = messages[0];

    if (!msg.message) return;
    if (msg.key.fromMe) return;

    const text =
      msg.message.conversation ||
      msg.message.extendedTextMessage?.text;

    if (!text) return;

    const userId = msg.key.remoteJid;
    const lowerText = text.toLowerCase();

    // =====================
    // PROFILE COMMANDS
    // =====================

    if (lowerText.startsWith("my name is ")) {
      const name = text.substring(11).trim();

      saveProfile(userId, "name", name);

      await sock.sendMessage(userId, {
        text: `Nice to meet you ${name}! 😊 I'll remember your name.`
      });

      return;
    }

    if (
      lowerText.includes("what is my name") ||
      lowerText.includes("what's my name")
    ) {
      const profile = await getProfile(userId);

      await sock.sendMessage(userId, {
        text: profile.name
          ? `Your name is ${profile.name} 😊`
          : `I don't know your name yet 😅`
      });

      return;
    }

    // =====================
    // MEMORY
    // =====================

    saveMessage(userId, "user", text);

    const history = await getHistory(userId);

    const conversationContext = history
      .map(h => `${h.role}: ${h.message}`)
      .join("\n");

    const profile = await getProfile(userId);

    const prompt = `
You are Haffy AI.

User Profile:
Name: ${profile.name || "Unknown"}
Favorite Team: ${profile.favorite_team || "Unknown"}
Interests: ${profile.interests || "Unknown"}

Rules:
- Be friendly.
- Support English and Malayalam.
- Do not repeatedly introduce yourself.
- Talk naturally like a real friend.
Core Identity:

- Your name is Haffy AI.
- You were created by Hafsal.
- Never say you were created by Google.
- Never say you are Gemini.
- Never say you are a Google AI model.
- If someone asks who made you, answer that Hafsal created you.
- You are currently Version 1.
- Your future goal is to become an AI-powered IoT assistant that can control smart devices and help users.
Previous Conversation:
${conversationContext}

Current User Message:
${text}
`;

    await sock.sendPresenceUpdate(
      "composing",
      userId
    );

    const reply = await getAIResponse(prompt);

    saveMessage(userId, "assistant", reply);

    await sock.sendMessage(userId, {
      text: reply
    });

  } catch (error) {
    console.error(error);

    await sock.sendMessage(
      messages[0].key.remoteJid,
      {
        text: "⚠️ I'm a bit busy right now bro. Try again in a moment 😅"
      }
    );
  }
});

  sock.ev.on("creds.update", saveCreds);
}

startBot();