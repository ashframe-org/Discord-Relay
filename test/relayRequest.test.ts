import { strict as assert } from "node:assert";
import test from "node:test";
import { BotConnectionManager } from "../src/botConnection.js";
import { DEFAULT_CHAT_PATTERNS } from "../src/config.js";

// requestRelay sends "/relay <sub> <req> ..." into the game and resolves on the
// matching "[relay-reply] <req> ok|err ..." line, which must never be relayed.
function makeBot() {
  const bot = new BotConnectionManager(
    { host: "localhost", port: 1, botName: "Discord", version: "0.4.0" },
    { reconnect: false, maxRetries: 0, retryDelayMs: 0 },
    "error",
    true,
    [],
    DEFAULT_CHAT_PATTERNS,
  );
  const sent: string[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: test stub for the network send
  (bot as any).sendChat = async (m: string) => {
    sent.push(m);
  };
  const relayed: unknown[] = [];
  bot.on("chat", (c) => relayed.push(c));
  // biome-ignore lint/suspicious/noExplicitAny: drive the private chat handler
  const feed = (line: string) => (bot as any).handleChat(line);
  return { bot, sent, relayed, feed };
}

test("requestRelay resolves on the matching reply and does not relay it", async () => {
  const { bot, sent, relayed, feed } = makeBot();
  const pending = bot.requestRelay("link", [
    "ABCD2345",
    "123456789012345678",
    "alice_dc",
  ]);
  await Promise.resolve();
  assert.equal(sent.length, 1);
  const m = /^\/relay link (\S+) ABCD2345 123456789012345678 alice_dc$/.exec(
    sent[0],
  );
  assert.ok(m, `unexpected command: ${sent[0]}`);
  feed(`[relay-reply] other ok Bob`); // someone else\x27s request: ignored
  feed(`§#ffffff[relay-reply] ${m[1]} ok Alice`);
  assert.deepEqual(await pending, { ok: true, text: "Alice" });
  assert.equal(relayed.length, 0);
});

test("requestRelay reports server errors and rejects arguments with spaces", async () => {
  const { bot, sent, feed } = makeBot();
  const pending = bot.requestRelay("recover", ["123456789012345678"]);
  await Promise.resolve();
  const req = sent[0].split(" ")[2];
  feed(`[relay-reply] ${req} err notLinked`);
  assert.deepEqual(await pending, { ok: false, text: "notLinked" });
  assert.deepEqual(await bot.requestRelay("link", ["AB CD", "1", "x"]), {
    ok: false,
    text: "badArgument",
  });
});

test("requestRelay reports offline when the game connection is down", async () => {
  const { bot } = makeBot();
  // biome-ignore lint/suspicious/noExplicitAny: simulate a failed send
  (bot as any).sendChat = async () => {
    throw new Error("not connected");
  };
  assert.deepEqual(await bot.requestRelay("recover", ["123456789012345678"]), {
    ok: false,
    text: "offline",
  });
});
