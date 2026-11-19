import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Isolate the module's persisted conversation state from the real user profile.
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;
const temporaryHome = await fs.mkdtemp(path.join(os.tmpdir(), "exile-wa-test-"));

process.env.HOME = temporaryHome;
process.env.USERPROFILE = temporaryHome;

const {
  configureWhatsAppConversationAI,
  updateWhatsAppConversationAIConfig,
  handleWhatsAppConversationIncoming,
} = await import("../local/whatsapp-conversation.mjs");

let nextId = 0;

function attachmentReply(hooks = {}) {
  return {
    text: "I've created your PDF.",
    attachment: {
      dataUrl: "data:application/pdf;base64,JVBERi0xLjQK",
      filename: "report.pdf",
      caption: "Your report",
      ...hooks,
    },
  };
}

async function runIncoming({ reply, sendMedia, send } = {}) {
  const sentMessages = [];
  const mediaCalls = [];

  configureWhatsAppConversationAI({
    generate: async () => reply,
    send: async (jid, message) => {
      sentMessages.push({ jid, message });
      if (send) return send(jid, message);
      return { sent: true };
    },
    sendMedia: async (...args) => {
      mediaCalls.push(args);
      if (sendMedia) return sendMedia(...args);
      return { sent: true };
    },
  });

  updateWhatsAppConversationAIConfig({ enabled: true });

  const result = await handleWhatsAppConversationIncoming({
    id: `delivery-regression-${++nextId}`,
    jid: "254700000001@s.whatsapp.net",
    name: "Test contact",
    text: "Please create a report and send it to me.",
  });

  return { result, sentMessages, mediaCalls };
}

after(async () => {
  try {
    updateWhatsAppConversationAIConfig({ enabled: false });
  } catch {}
  await fs.rm(temporaryHome, { recursive: true, force: true });

  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  if (originalUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = originalUserProfile;
});

test("queued-record failure prevents the WhatsApp attachment send", async () => {
  let queuedAttempts = 0;

  const { result, sentMessages, mediaCalls } = await runIncoming({
    reply: attachmentReply({
      onQueued: async () => {
        queuedAttempts++;
        throw new Error("metadata disk write failed");
      },
    }),
  });

  assert.equal(queuedAttempts, 1);
  assert.equal(mediaCalls.length, 0);
  assert.equal(result.sent, false);
  assert.equal(result.reason, "delivery-record-failed");
  assert.equal(result.artifactRetained, true);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].message, /did not send/i);
});

test("confirmed WhatsApp send remains successful when onSent bookkeeping fails", async () => {
  let finalizationAttempts = 0;

  const { result, sentMessages, mediaCalls } = await runIncoming({
    reply: attachmentReply({
      onQueued: async () => {},
      onSent: async () => {
        finalizationAttempts++;
        throw new Error("delivery metadata update failed");
      },
    }),
    sendMedia: async () => ({ sent: true }),
  });

  assert.equal(mediaCalls.length, 1);
  assert.equal(finalizationAttempts, 1);
  assert.equal(result.sent, true);
  assert.equal(result.attachment, "report.pdf");
  assert.equal(sentMessages.length, 0, "must not send a false failure notice");
});

test("media-send failure remains truthful when onFailed bookkeeping also fails", async () => {
  let failureHookAttempts = 0;

  const { result, sentMessages, mediaCalls } = await runIncoming({
    reply: attachmentReply({
      onQueued: async () => {},
      onFailed: async () => {
        failureHookAttempts++;
        throw new Error("failure metadata update failed");
      },
    }),
    sendMedia: async () => {
      throw new Error("WhatsApp transport unavailable");
    },
  });

  assert.equal(mediaCalls.length, 1);
  assert.equal(failureHookAttempts, 1);
  assert.equal(result.sent, false);
  assert.equal(result.reason, "send-failed");
  assert.equal(result.artifactRetained, true);
  assert.equal(sentMessages.length, 1);
  assert.match(sentMessages[0].message, /couldn't deliver/i);
});

test("normal confirmed attachment delivery finalizes and reports success", async () => {
  let queued = 0;
  let finalized = 0;

  const { result, sentMessages, mediaCalls } = await runIncoming({
    reply: attachmentReply({
      onQueued: async () => { queued++; },
      onSent: async () => { finalized++; },
    }),
  });

  assert.equal(queued, 1);
  assert.equal(finalized, 1);
  assert.equal(mediaCalls.length, 1);
  assert.equal(sentMessages.length, 0);
  assert.equal(result.sent, true);
  assert.equal(result.attachment, "report.pdf");
});

test("ordinary text replies retain their existing send behavior", async () => {
  const { result, sentMessages, mediaCalls } = await runIncoming({
    reply: "Your report is ready.",
  });

  assert.equal(result.sent, true);
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].message, "Your report is ready.");
  assert.equal(mediaCalls.length, 0);
});
