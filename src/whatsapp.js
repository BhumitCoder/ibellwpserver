const path = require("path");
const P = require("pino");
const QRCode = require("qrcode");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
} = require("@whiskeysockets/baileys");

const AUTH_DIR = path.join(__dirname, "..", "auth_info");

// In-memory only — fine for one shop/one number. Swap for a Firestore-backed
// store before this runs anywhere the filesystem isn't persistent (Render
// free tier wipes local disk on restart/redeploy).
const state = {
  sock: null,
  status: "disconnected", // "disconnected" | "qr" | "connected"
  qrDataUrl: null,
  receivedMessages: [],
};

function toJid(phone) {
  const digits = String(phone).replace(/\D/g, "");
  return `${digits}@s.whatsapp.net`;
}

function extractText(message) {
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    ""
  );
}

async function start() {
  const { state: authState, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  const sock = makeWASocket({
    auth: authState,
    logger: P({ level: "silent" }),
  });
  state.sock = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      state.qrDataUrl = await QRCode.toDataURL(qr);
      state.status = "qr";
    }

    if (connection === "open") {
      state.status = "connected";
      state.qrDataUrl = null;
      console.log("[whatsapp] connected");
    }

    if (connection === "close") {
      state.status = "disconnected";
      const loggedOut =
        lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
      console.log("[whatsapp] connection closed — logged out:", loggedOut);
      // Any other close reason (network blip, server restart) is expected to
      // reconnect using the saved session, same as WhatsApp Web reconnecting
      // in a browser tab. Logged-out is the only case needing a fresh QR.
      if (!loggedOut) start();
    }
  });

  sock.ev.on("messages.upsert", ({ messages, type }) => {
    if (type !== "notify") return;
    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;
      const entry = {
        from: msg.key.remoteJid,
        text: extractText(msg.message),
        timestamp: Number(msg.messageTimestamp) * 1000,
      };
      state.receivedMessages.push(entry);
      if (state.receivedMessages.length > 500) state.receivedMessages.shift();
      console.log("[whatsapp] incoming:", entry.from, entry.text);
    }
  });
}

async function sendMessage({ phone, message, pdfBase64, fileName }) {
  if (state.status !== "connected") {
    const err = new Error("WhatsApp not connected — scan the QR code first");
    err.code = "NOT_CONNECTED";
    throw err;
  }
  const jid = toJid(phone);

  if (pdfBase64) {
    await state.sock.sendMessage(jid, {
      document: Buffer.from(pdfBase64, "base64"),
      mimetype: "application/pdf",
      fileName: fileName || "document.pdf",
      caption: message || "",
    });
    return;
  }
  if (message) {
    await state.sock.sendMessage(jid, { text: message });
    return;
  }
  const err = new Error("Provide `message` and/or `pdfBase64`");
  err.code = "BAD_REQUEST";
  throw err;
}

module.exports = { start, sendMessage, toJid, state };
