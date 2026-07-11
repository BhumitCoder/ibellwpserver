const express = require("express");
const wa = require("./whatsapp");

const PORT = process.env.PORT || 3000;
const app = express();
app.use(express.json({ limit: "20mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, status: wa.state.status }));

// Poll this from the AIM Settings > "Link WhatsApp" screen while status is
// "qr", then stop once it flips to "connected".
app.get("/qr", (_req, res) => {
  if (wa.state.status === "connected") return res.json({ status: "connected" });
  if (!wa.state.qrDataUrl) return res.json({ status: "waiting" });
  res.json({ status: "qr", qr: wa.state.qrDataUrl });
});

// Plain browser page for manually linking during setup/testing — open this
// URL directly and scan with the shop's WhatsApp > Linked Devices.
app.get("/", (_req, res) => {
  res.send(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Link WhatsApp</title></head>
<body style="font-family: system-ui; text-align:center; padding-top:60px;">
  <h2 id="title">Loading…</h2>
  <img id="qr" style="display:none; width:280px; height:280px;" />
  <script>
    async function poll() {
      const r = await fetch('/qr');
      const data = await r.json();
      const title = document.getElementById('title');
      const img = document.getElementById('qr');
      if (data.status === 'connected') {
        title.textContent = 'Connected ✅';
        img.style.display = 'none';
      } else if (data.status === 'qr') {
        title.textContent = 'Scan with WhatsApp > Linked Devices';
        img.src = data.qr;
        img.style.display = 'inline-block';
      } else {
        title.textContent = 'Starting…';
        img.style.display = 'none';
      }
    }
    poll();
    setInterval(poll, 3000);
  </script>
</body>
</html>`);
});

app.post("/send", async (req, res) => {
  try {
    const { phone, message, pdfBase64, fileName } = req.body || {};
    if (!phone) return res.status(400).json({ error: "phone is required" });
    await wa.sendMessage({ phone, message, pdfBase64, fileName });
    res.json({ ok: true });
  } catch (err) {
    const status = err.code === "NOT_CONNECTED" ? 409 : err.code === "BAD_REQUEST" ? 400 : 500;
    console.error("[send] failed:", err.message);
    res.status(status).json({ error: err.message });
  }
});

// Starting point for the receive side — returns everything received so far,
// optionally filtered to one phone number. Refine once the real requirement
// (store per-party? push to AIM live? auto-reply?) is decided.
app.get("/messages", (req, res) => {
  const { phone } = req.query;
  if (phone) {
    const jid = wa.toJid(phone);
    return res.json(wa.state.receivedMessages.filter((m) => m.from === jid));
  }
  res.json(wa.state.receivedMessages);
});

wa.start();
app.listen(PORT, () => console.log(`WhatsApp server listening on http://localhost:${PORT}`));
