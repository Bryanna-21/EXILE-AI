import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { handleWhatsAppIncoming } from "./whatsapp-automation.mjs";

const AUTH_DIR =
  process.env.EXILE_WHATSAPP_AUTH_DIR ||
  path.join(os.homedir(), ".exile-ai", "whatsapp-auth");

let socket = null;
let starting = null;
let reconnectTimer = null;
let manualDisconnect = false;
let qrDataUrl = null;
let lastError = null;
let connectionStatus = "disconnected";
let messages = [];
let connectedUser = null;

const MESSAGE_STORE = path.join(
  os.homedir(),
  ".exile-ai",
  "whatsapp-messages.json"
);

try {
  const saved = JSON.parse(fs.readFileSync(MESSAGE_STORE, "utf8"));
  if (Array.isArray(saved)) {
    messages = saved
      .filter((item) =>
        item &&
        typeof item.id === "string" &&
        typeof item.jid === "string" &&
        typeof item.text === "string"
      )
      .slice(-5000);
  }
} catch {
  // A missing or unreadable store starts with an empty message list.
}

function persistMessages() {
  const temporary = `${MESSAGE_STORE}.tmp`;
  try {
    fs.mkdirSync(path.dirname(MESSAGE_STORE), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(messages), "utf8");
    fs.renameSync(temporary, MESSAGE_STORE);
  } catch (error) {
    console.error("[WhatsApp] Could not persist messages:", error);
    try {
      fs.rmSync(temporary, { force: true });
    } catch {}
  }
}

function status() {
  return {
    status: connectionStatus,
    connected: connectionStatus === "connected",
    qrDataUrl,
    user: connectedUser,
    lastError,
  };
}

function unwrapMessage(message) {
  let current = message;
  while (current) {
    const wrapped =
      current.ephemeralMessage?.message ||
      current.viewOnceMessage?.message ||
      current.viewOnceMessageV2?.message;
    if (!wrapped) break;
    current = wrapped;
  }
  return current || {};
}

function messageText(message) {
  const m = unwrapMessage(message);
  const text =
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.listResponseMessage?.title;

  if (text) return String(text);

  const type = Object.keys(m).find((key) => key.endsWith("Message"));
  return type ? `[${type.replace("Message", "")}]` : "";
}

function rememberMessage(item) {
  if (!item.text) return;
  if (messages.some((m) => m.id === item.id && m.jid === item.jid)) return;
  messages.push(item);
  if (messages.length > 5000) messages = messages.slice(-5000);
  persistMessages();
}

let baileysVersion = null;

export async function connectWhatsApp() {
  manualDisconnect = false;
  if (socket) return status();
  if (starting) return starting;

  starting = (async () => {
    fs.mkdirSync(AUTH_DIR, { recursive: true });

    if (!baileysVersion) {
      const latest = await fetchLatestBaileysVersion();
      baileysVersion = latest.version;
      console.info(
        "[WhatsApp] Using WhatsApp Web version",
        baileysVersion.join(".")
      );
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const ws = makeWASocket({
      auth: state,
      version: baileysVersion,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      browser: ["EXILE AI", "Chrome", "1.0.0"],
    });

    socket = ws;
    connectionStatus = "connecting";
    qrDataUrl = null;
    lastError = null;

    ws.ev.on("creds.update", saveCreds);

    ws.ev.on("connection.update", async (update) => {
      if (update.qr) {
        try {
          qrDataUrl = await QRCode.toDataURL(update.qr);
          connectionStatus = "qr";
        } catch {
          lastError = "Could not generate the WhatsApp QR code.";
        }
      }

      if (update.connection === "open") {
        connectionStatus = "connected";
        qrDataUrl = null;
        lastError = null;
        connectedUser = ws.user?.id || null;
      }

      if (update.connection === "close") {
        const code = update.lastDisconnect?.error?.output?.statusCode;
        if (socket === ws) socket = null;

        connectionStatus = "disconnected";
        qrDataUrl = null;
        connectedUser = null;

        const loggedOut = code === DisconnectReason.loggedOut;
        lastError = loggedOut
          ? "WhatsApp logged out this device. Connect again and scan a new QR code."
          : "WhatsApp connection closed.";

        if (!manualDisconnect && !loggedOut) {
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => {
            connectWhatsApp().catch(() => {});
          }, 2000);
        }
      }
    });

    ws.ev.on("messages.upsert", ({ messages: incoming, type }) => {
      for (const msg of incoming || []) {
        const jid = msg.key?.remoteJid;
        if (!jid || jid === "status@broadcast" || jid.endsWith("@newsletter")) {
          continue;
        }

        const item = {
          id: msg.key?.id || `${jid}-${Date.now()}`,
          jid,
          fromMe: Boolean(msg.key?.fromMe),
          name: msg.pushName || jid,
          text: messageText(msg.message),
          timestamp: Number(msg.messageTimestamp || Math.floor(Date.now() / 1000)) * 1000,
        };
        rememberMessage(item);

        // Do not automate history sync, own messages, groups, or non-text placeholders.
        if (
          type === "notify" &&
          !item.fromMe &&
          jid.endsWith("@s.whatsapp.net") &&
          item.text &&
          !/^\[[^\]]+\]$/.test(item.text) &&
          msg.key?.id
        ) {
          void handleWhatsAppIncoming(item).catch((error) => {
            console.error("[WhatsApp automation] Incoming-message handler failed:", error.message);
          });
        }
      }
    });

    return status();
  })();

  try {
    return await starting;
  } catch (error) {
    socket = null;
    connectionStatus = "disconnected";
    lastError = error instanceof Error ? error.message : "WhatsApp failed to start.";
    throw error;
  } finally {
    starting = null;
  }
}

export function getWhatsAppStatus() {
  return status();
}

export function getWhatsAppMessages(jid = "") {
  const filtered = jid ? messages.filter((m) => m.jid === jid) : messages;
  return filtered.slice(-200);
}

export async function sendWhatsAppMessage(to, text) {
  if (!socket || connectionStatus !== "connected") {
    throw new Error("Connect WhatsApp before sending messages.");
  }

  const content = String(text || "").trim();
  if (!content) throw new Error("Message cannot be empty.");

  const raw = String(to || "").trim();
  const jid = raw.includes("@")
    ? raw
    : `${raw.replace(/\D/g, "")}@s.whatsapp.net`;

  if (!jid.includes("@") || jid.startsWith("@")) {
    throw new Error("Enter a valid WhatsApp number or chat ID.");
  }

  const result = await socket.sendMessage(jid, { text: content });

  rememberMessage({
    id: result?.key?.id || `sent-${Date.now()}`,
    jid,
    fromMe: true,
    name: jid,
    text: content,
    timestamp: Date.now(),
  });

  return { sent: true, jid };
}

export async function disconnectWhatsApp() {
  manualDisconnect = true;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;

  const ws = socket;
  socket = null;
  qrDataUrl = null;
  connectedUser = null;
  connectionStatus = "disconnected";

  if (ws) {
    try {
      await ws.logout();
    } catch {
      try {
        ws.end(undefined);
      } catch {}
    }
  }

  try {
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  } catch {
    lastError = "Disconnected, but the saved authentication files could not be removed.";
  }

  if (!lastError?.startsWith("Disconnected,")) lastError = null;
  return status();
}
