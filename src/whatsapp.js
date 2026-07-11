import P from "pino";
import QRCode from "qrcode";
import makeWASocket, { DisconnectReason, fetchLatestBaileysVersion } from "@whiskeysockets/baileys";
import { useFirestoreAuthState, clearSession } from "./firestoreAuthState.js";

// receivedMessages is in-memory only (fine — it's a rolling recent-activity
// log, not the source of truth). The WhatsApp session itself (creds.json +
// keys) lives in Firestore via useFirestoreAuthState, so it survives a host
// restart/redeploy with no local disk involved at all.
export const state = {
  sock: null,
  status: "disconnected", // "disconnected" | "qr" | "connected"
  qrDataUrl: null,
  phone: null, // e.g. "919978581685" once connected
  receivedMessages: [],
};

function phoneFromJid(jid) {
  if (!jid) return null;
  return jid.split("@")[0].split(":")[0];
}

// Set while our own disconnect() is driving a logout, so the
// connection.update handler below doesn't ALSO race to clear the session
// and restart — disconnect() already does both, in order.
let manualDisconnectInFlight = false;

export function toJid(phone) {
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

export async function start() {
  const { state: authState, saveCreds } = await useFirestoreAuthState();
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    auth: authState,
    version,
    logger: P({ level: "silent" }),
  });
  state.sock = sock;

  sock.ev.on("creds.update", () => {
    saveCreds().catch((err) => console.error("[whatsapp] saveCreds failed:", err));
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      state.qrDataUrl = await QRCode.toDataURL(qr);
      state.status = "qr";
    }

    if (connection === "open") {
      state.status = "connected";
      state.qrDataUrl = null;
      state.phone = phoneFromJid(sock.user?.id);
      console.log("[whatsapp] connected:", state.phone);
    }

    if (connection === "close") {
      state.status = "disconnected";
      state.phone = null;
      const loggedOut =
        lastDisconnect?.error?.output?.statusCode === DisconnectReason.loggedOut;
      console.log("[whatsapp] connection closed — logged out:", loggedOut);
      // Any other close reason (network blip, server restart) is expected to
      // reconnect using the saved session, same as WhatsApp Web reconnecting
      // in a browser tab. Logged-out is the only case needing a fresh QR —
      // manualDisconnect already handles that case itself (see below), so
      // this only needs to cover the *unexpected* logged-out event (e.g. the
      // shop owner removes the linked device from their phone directly).
      if (manualDisconnectInFlight) {
        // disconnect() below already owns clearSession + restart for this case.
      } else if (!loggedOut) {
        start();
      } else {
        // The phone's own "Linked Devices > Remove" was used, bypassing our
        // /disconnect route — stale creds are now invalid, so wipe them and
        // reconnect fresh so the Settings page has a new QR ready to go.
        clearSession()
          .catch((err) => console.error("[whatsapp] clearSession failed:", err))
          .finally(() => start());
      }
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

/** Owner-initiated disconnect from the AIM Settings page — a real WhatsApp
 * logout (removes this device from the phone's own Linked Devices list),
 * not just forgetting the local session, so it can't silently keep
 * receiving/sending after the owner thinks it's off. */
export async function disconnect() {
  manualDisconnectInFlight = true;
  const sock = state.sock;
  state.sock = null;
  state.status = "disconnected";
  state.phone = null;
  state.qrDataUrl = null;
  try {
    if (sock) {
      try {
        await sock.logout();
      } catch (err) {
        console.error("[whatsapp] logout failed (clearing session anyway):", err);
      }
    }
    await clearSession();
    await start();
  } finally {
    manualDisconnectInFlight = false;
  }
}

export async function sendMessage({ phone, message, pdfBase64, fileName }) {
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
