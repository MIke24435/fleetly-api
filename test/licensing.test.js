import assert from "node:assert/strict";
import { describe, it } from "node:test";
import worker from "../worker.js";
import {
  cancellationHtml,
  classifyRefund,
  nextPurchaseDate,
  planForSubscriptionStatus,
  publicLicenseView,
  secretsMatch,
} from "../licensing.js";

const LIVE_SECRET = "whsec_live";
const TEST_SECRET = "whsec_test";
const ADMIN = "a-much-longer-admin-secret";

function memoryKv() {
  const store = new Map();
  return {
    store,
    async get(key, type) {
      if (!store.has(key)) return null;
      const value = store.get(key);
      if (type === "json") return JSON.parse(value);
      return value;
    },
    async put(key, value) {
      store.set(key, String(value));
    },
  };
}

function testEnv(kv, extra) {
  return Object.assign({
    LICENSES: kv,
    ADMIN_SECRET: ADMIN,
    RESEND_API_KEY: "re_test",
    NOTION_TOKEN: "ntn_test",
    STRIPE_WEBHOOK_SECRET: LIVE_SECRET,
    STRIPE_WEBHOOK_SECRET_TEST: TEST_SECRET,
    fetch: async () => new Response("{}", { status: 200 }),
  }, extra || {});
}

async function signStripe(raw, secret) {
  const t = Math.floor(Date.now() / 1000);
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(t + "." + raw));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, "0")).join("");
  return "t=" + t + ",v1=" + hex;
}

async function postJson(env, path, body, headers) {
  return worker.fetch(new Request("https://api.fleetlybots.com" + path, {
    method: "POST",
    headers: Object.assign({ "content-type": "application/json" }, headers || {}),
    body: JSON.stringify(body == null ? {} : body),
  }), env);
}

async function postWebhook(env, event, secret) {
  const raw = JSON.stringify(event);
  const sig = await signStripe(raw, secret);
  return worker.fetch(new Request("https://api.fleetlybots.com/api/stripe-webhook", {
    method: "POST",
    headers: { "stripe-signature": sig, "content-type": "application/json" },
    body: raw,
  }), env);
}

function checkoutEvent(overrides) {
  return Object.assign({
    id: "evt_checkout",
    livemode: true,
    type: "checkout.session.completed",
    data: { object: Object.assign({
      id: "cs_live_1",
      mode: "payment",
      payment_intent: "pi_template_1",
      customer: "cus_live",
      customer_details: { email: "buyer@example.com", name: "Buyer" },
      amount_total: 4900,
    }, overrides || {}) },
  }, overrides && overrides.event || {});
}

function activeRecord(overrides) {
  return Object.assign({
    email: "buyer@example.com",
    name: "Buyer",
    status: "active",
    plan: "template",
    purchased: "2026-10-01",
    created: "2026-10-01",
    owns_template: true,
  }, overrides || {});
}

describe("licensing hardening", { concurrency: false }, () => {
  it("compares admin secrets by digest, including different lengths", async () => {
    assert.equal(await secretsMatch(ADMIN, ADMIN), true);
    assert.equal(await secretsMatch("short", ADMIN), false);
    assert.equal(await secretsMatch("", ADMIN), false);
    assert.equal(await secretsMatch(ADMIN + " ", ADMIN), false);
  });

  it("keeps an existing purchase date and resets it only after the key was inactive", () => {
    const active = { status: "active", purchased: "2026-01-15", plan: "template" };
    assert.equal(nextPurchaseDate(active, "payment", "2026-10-15", false), "2026-01-15");
    assert.equal(nextPurchaseDate(active, "subscription", "2026-10-15", false), "2026-01-15");
    assert.equal(nextPurchaseDate({ status: "revoked", purchased: "2026-01-15" }, "payment", "2026-10-15", false), "2026-10-15");
    assert.equal(nextPurchaseDate(null, "payment", "2026-10-15", true), "2026-10-15");
  });

  it("classifies template and membership refunds without an email", () => {
    assert.deepEqual(classifyRefund(
      { amount: 4900, amount_refunded: 4900, refunded: true },
      { product: "template" }), { action: "revoke", product: "template" });
    assert.equal(classifyRefund(
      { amount: 4900, amount_refunded: 500, refunded: false },
      { product: "template" }).action, "ignore");
    assert.equal(classifyRefund(
      { amount: 600, amount_refunded: 600, refunded: true, invoice: "in_1" },
      { product: "membership" }).action, "drop_membership");
    assert.equal(classifyRefund(
      { amount: 600, amount_refunded: 600, refunded: true, invoice: "in_1" },
      null).action, "drop_membership");
    assert.equal(planForSubscriptionStatus("past_due"), "template");
    assert.equal(planForSubscriptionStatus("unpaid"), "template");
    assert.equal(planForSubscriptionStatus("active"), "membership");
  });

  it("redacts the full key from lookups and cancellation mail", () => {
    const key = "FL-HELLO-WXYZ";
    const view = publicLicenseView({
      email: "buyer@example.com",
      status: "revoked",
      plan: "template",
      note: "copied " + key + " into the note",
      revoke_reason: "lost",
    }, key, false);
    assert.equal(view.license_ending, "WXYZ");
    assert.equal(JSON.stringify(view).includes(key), false);
    assert.equal(view.note.includes("WXYZ"), true);
    const html = cancellationHtml(key, ["Your Fleetly membership is cancelled — you won't be charged again."]);
    assert.equal(html.includes(key), false);
    assert.match(html, /License ending <strong>WXYZ<\/strong>/);
  });

  it("rejects every non-active status on skills, tickets, and KB search", async () => {
    const kv = memoryKv();
    const key = "FL-LIVEK-EY11";
    await kv.put("license:" + key, JSON.stringify(activeRecord()));
    await kv.put("skill-added:my-tasks", "2026-10-01");
    const env = testEnv(kv);
    assert.equal((await skills(env, key)).status, 200);
    assert.equal((await kb(env, key)).status, 200);
    assert.equal((await ticket(env, key)).status, 200);

    for (const status of ["revoked", "refunded", "disputed", "deactivated"]) {
      await kv.put("license:" + key, JSON.stringify(activeRecord({ status: status })));
      assert.equal((await skills(env, key)).status, 403, status);
      assert.equal((await kb(env, key)).status, 403, status);
      const ticketRes = await ticket(env, key);
      assert.equal(ticketRes.status, 403, status);
      assert.equal((await ticketRes.json()).error, "license");
    }
  });

  it("creates keys with crypto randomness, collisions avoided, and email lookup", async () => {
    const kv = memoryKv();
    const env = testEnv(kv);
    const originalRandom = Math.random;
    const originalBytes = crypto.getRandomValues;
    let n = 0;
    Math.random = () => { throw new Error("Math.random used"); };
    crypto.getRandomValues = (arr) => {
      arr.fill(n);
      n += 1;
      return arr;
    };
    try {
      await kv.put("license:FL-AAAAA-AAAAA", "{}");
      const res = await postJson(env, "/api/admin/create-key", {
        email: "Ada@Example.com",
        name: "Ada",
        note: "comped for the beta",
        plan: "membership",
      }, { "x-admin-secret": ADMIN });
      const body = await res.json();
      assert.equal(res.status, 200);
      assert.equal(body.key, "FL-BBBBB-BBBBB");
      assert.equal(await kv.get("license-email:ada@example.com"), "FL-BBBBB-BBBBB");
      const stored = await kv.get("license:FL-BBBBB-BBBBB", "json");
      assert.equal(stored.name, "Ada");
      assert.equal(stored.note, "comped for the beta");
      assert.equal(stored.plan, "membership");
      assert.equal(stored.owns_template, false);
      assert.equal(stored.status, "active");
    } finally {
      Math.random = originalRandom;
      crypto.getRandomValues = originalBytes;
    }
  });

  it("lookups show only the last 4 and revoke records a date and reason", async () => {
    const kv = memoryKv();
    const key = "FL-ADMIN-KEY9";
    await kv.put("license:" + key, JSON.stringify(activeRecord({ note: "keep " + key })));
    const env = testEnv(kv);
    const denied = await postJson(env, "/api/admin/lookup", { key: key }, { "x-admin-secret": "nope" });
    assert.equal(denied.status, 401);
    const short = await postJson(env, "/api/admin/revoke", { key: key, reason: "chargeback" }, { "x-admin-secret": "x" });
    assert.equal(short.status, 401);

    const look = await postJson(env, "/api/admin/lookup", { key: key }, { "x-admin-secret": ADMIN });
    const view = await look.json();
    assert.equal(view.license_ending, "KEY9");
    assert.equal(view.status, "active");
    assert.equal(JSON.stringify(view).includes(key), false);

    const missing = await postJson(env, "/api/admin/revoke", { key: key }, { "x-admin-secret": ADMIN });
    assert.equal(missing.status, 400);
    const revoked = await postJson(env, "/api/admin/revoke", { key: key, reason: "lost laptop" }, { "x-admin-secret": ADMIN });
    const body = await revoked.json();
    assert.equal(body.status, "revoked");
    assert.match(body.revoked_at, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(body.revoke_reason, "lost laptop");
    assert.equal(JSON.stringify(body).includes(key), false);
    const again = await postJson(env, "/api/admin/revoke", { key: key }, { "x-admin-secret": ADMIN });
    assert.equal(again.status, 200);
    assert.equal((await kv.get("license:" + key, "json")).status, "revoked");
    assert.equal((await skills(env, key)).status, 403);
  });

  it("rotates a key, carries the purchase forward, and emails only the new key", async () => {
    const kv = memoryKv();
    const oldKey = "FL-OLDKY-ABCD";
    await kv.put("license:" + oldKey, JSON.stringify(activeRecord({
      plan: "membership",
      purchased: "2026-02-02",
      stripe_customer: "cus_rotate",
      owns_template: true,
    })));
    await kv.put("license-customer:cus_rotate", oldKey);
    const emails = [];
    const env = testEnv(kv, {
      fetch: async (url, init) => {
        emails.push(JSON.parse(init.body));
        return new Response("{}", { status: 200 });
      },
    });
    const res = await postJson(env, "/api/admin/rotate-key", { key: oldKey }, { "x-admin-secret": ADMIN });
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(body.previous_ending, "ABCD");
    assert.equal(body.email_sent, true);
    assert.notEqual(body.key, oldKey);
    const fresh = await kv.get("license:" + body.key, "json");
    assert.equal(fresh.plan, "membership");
    assert.equal(fresh.purchased, "2026-02-02");
    assert.equal(fresh.stripe_customer, "cus_rotate");
    assert.equal(fresh.status, "active");
    assert.equal((await kv.get("license:" + oldKey, "json")).status, "deactivated");
    assert.equal(await kv.get("license-customer:cus_rotate"), body.key);
    assert.equal(emails.length, 1);
    assert.match(emails[0].html, new RegExp(body.key));
    assert.equal(emails[0].html.includes(oldKey), false);
    const looked = await (await postJson(env, "/api/admin/lookup", { key: oldKey }, { "x-admin-secret": ADMIN })).json();
    assert.equal(JSON.stringify(looked).includes(body.key), false);
    assert.equal(looked.rotated_to_ending, body.license_ending);
    assert.equal((await skills(env, oldKey)).status, 403);
    assert.equal((await skills(env, body.key)).status, 200);
  });

  it("does not extend the honeymoon when the template is bought again", async () => {
    const kv = memoryKv();
    const env = testEnv(kv, { fetch: async () => new Response("{}", { status: 200 }) });
    const first = await postWebhook(env, checkoutEvent(), LIVE_SECRET);
    assert.equal(first.status, 200);
    const key = await kv.get("license-email:buyer@example.com");
    const created = await kv.get("license:" + key, "json");
    created.purchased = "2026-01-15";
    created.status = "active";
    await kv.put("license:" + key, JSON.stringify(created));
    const second = await postWebhook(env, checkoutEvent({
      event: { id: "evt_checkout_2" },
      id: "cs_live_2",
      payment_intent: "pi_template_2",
    }), LIVE_SECRET);
    assert.equal((await second.json()).ok, true);
    const after = await kv.get("license:" + key, "json");
    assert.equal(after.purchased, "2026-01-15");
    assert.equal(after.plan, "template");
    assert.equal(await kv.get("stripe-payment:pi_template_1", "json").then(m => m.key), key);
  });

  it("revokes only a full template refund and drops membership on a $6 refund", async () => {
    const kv = memoryKv();
    const env = testEnv(kv, { fetch: async () => new Response("{}", { status: 200 }) });
    await postWebhook(env, checkoutEvent(), LIVE_SECRET);
    const key = await kv.get("license-email:buyer@example.com");
    await kv.put("license:FL-OTHER-ZZZZ", JSON.stringify(activeRecord({ email: "other@example.com" })));
    await kv.put("license-email:other@example.com", "FL-OTHER-ZZZZ");

    const partial = await postWebhook(env, {
      id: "evt_partial",
      livemode: true,
      type: "charge.refunded",
      data: { object: {
        payment_intent: "pi_template_1",
        amount: 4900,
        amount_refunded: 500,
        refunded: false,
        receipt_email: "other@example.com",
      } },
    }, LIVE_SECRET);
    assert.equal((await partial.json()).ignored, "partial_template_refund");
    assert.equal((await kv.get("license:" + key, "json")).status, "active");
    assert.equal((await kv.get("license:FL-OTHER-ZZZZ", "json")).status, "active");

    const full = await postWebhook(env, {
      id: "evt_full",
      livemode: true,
      type: "charge.refunded",
      data: { object: {
        payment_intent: "pi_template_1",
        amount: 4900,
        amount_refunded: 4900,
        refunded: true,
        customer: "cus_someone_else",
      } },
    }, LIVE_SECRET);
    assert.equal((await full.json()).revoked, true);
    const revoked = await kv.get("license:" + key, "json");
    assert.equal(revoked.status, "revoked");
    assert.match(revoked.revoked_at, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal((await kv.get("license:FL-OTHER-ZZZZ", "json")).status, "active");

    await kv.put("license:" + key, JSON.stringify(activeRecord({
      plan: "membership",
      purchased: "2026-03-03",
      stripe_customer: "cus_live",
      owns_template: true,
    })));
    const membership = await postWebhook(env, {
      id: "evt_mem",
      livemode: true,
      type: "charge.refunded",
      data: { object: {
        payment_intent: "pi_membership_9",
        customer: "cus_live",
        invoice: "in_9",
        amount: 600,
        amount_refunded: 600,
        refunded: true,
        receipt_email: "other@example.com",
      } },
    }, LIVE_SECRET);
    assert.equal((await membership.json()).membership_dropped, true);
    const dropped = await kv.get("license:" + key, "json");
    assert.equal(dropped.plan, "template");
    assert.equal(dropped.status, "active");
    assert.equal(dropped.purchased, "2026-03-03");
  });

  it("drops membership on past_due and unpaid, and cancellation mail hides the key", async () => {
    const kv = memoryKv();
    const key = "FL-SUBSC-RIBE";
    await kv.put("license:" + key, JSON.stringify(activeRecord({
      plan: "membership",
      purchased: "2026-04-04",
      stripe_customer: "cus_sub",
      owns_template: false,
    })));
    await kv.put("license-customer:cus_sub", key);
    const emails = [];
    const env = testEnv(kv, {
      fetch: async (url, init) => {
        emails.push(JSON.parse(init.body));
        return new Response("{}", { status: 200 });
      },
    });
    const past = await postWebhook(env, {
      id: "evt_past",
      livemode: true,
      type: "customer.subscription.updated",
      data: { object: { customer: "cus_sub", status: "past_due" } },
    }, LIVE_SECRET);
    assert.equal((await past.json()).membership_dropped, true);
    let rec = await kv.get("license:" + key, "json");
    assert.equal(rec.plan, "template");
    assert.equal(rec.status, "active");
    assert.equal(rec.purchased, "2026-04-04");
    assert.equal(emails[0].html.includes(key), false);
    assert.match(emails[0].html, /RIBE/);

    const back = await postWebhook(env, {
      id: "evt_back",
      livemode: true,
      type: "customer.subscription.updated",
      data: { object: { customer: "cus_sub", status: "active" } },
    }, LIVE_SECRET);
    assert.equal((await back.json()).membership_restored, true);
    assert.equal((await kv.get("license:" + key, "json")).plan, "membership");

    const unpaid = await postWebhook(env, {
      id: "evt_unpaid",
      livemode: true,
      type: "customer.subscription.updated",
      data: { object: { customer: "cus_sub", status: "unpaid" } },
    }, LIVE_SECRET);
    assert.equal((await unpaid.json()).membership_dropped, true);

    await kv.put("license:" + key, JSON.stringify(activeRecord({
      plan: "membership",
      purchased: "2026-04-04",
      stripe_customer: "cus_sub",
    })));
    emails.length = 0;
    const ended = await postWebhook(env, {
      id: "evt_deleted",
      livemode: true,
      type: "customer.subscription.deleted",
      data: { object: { customer: "cus_sub", status: "canceled" } },
    }, LIVE_SECRET);
    assert.equal(ended.status, 200);
    rec = await kv.get("license:" + key, "json");
    assert.equal(rec.plan, "template");
    assert.equal(rec.status, "active");
    assert.equal(emails[0].html.includes(key), false);
    assert.match(emails[0].html, /License ending <strong>RIBE<\/strong>/);

    await kv.put("license:" + key, JSON.stringify(activeRecord({
      plan: "membership",
      stripe_customer: "cus_sub",
    })));
    emails.length = 0;
    await postWebhook(env, {
      id: "evt_sched",
      livemode: true,
      type: "customer.subscription.updated",
      data: { object: { customer: "cus_sub", status: "active", cancel_at_period_end: true, cancel_at: 1790000000 } },
    }, LIVE_SECRET);
    assert.equal((await kv.get("license:" + key, "json")).plan, "membership");
    assert.equal(emails[0].subject, "Your Fleetly membership is cancelled");
    assert.equal(emails[0].html.includes(key), false);
    assert.match(emails[0].html, /RIBE/);
  });

  it("keeps test licenses in their own namespace and requires the test signing secret", async () => {
    const kv = memoryKv();
    await kv.put("license:FL-LIVE0-LIVE", JSON.stringify(activeRecord({ email: "buyer@example.com" })));
    await kv.put("license-email:buyer@example.com", "FL-LIVE0-LIVE");
    await kv.put("skill-added:my-tasks", "2026-10-01");
    const env = testEnv(kv, { fetch: async () => new Response("{}", { status: 200 }) });
    const testEvent = checkoutEvent({
      event: { id: "evt_test_1", livemode: false },
      id: "cs_test_1",
      payment_intent: "pi_test_1",
      customer: "cus_test",
    });
    testEvent.livemode = false;
    testEvent.id = "evt_test_1";
    const wrong = await postWebhook(env, testEvent, LIVE_SECRET);
    assert.equal(wrong.status, 400);
    assert.equal(await kv.get("test:license-email:buyer@example.com"), null);

    const missing = await postWebhook(testEnv(kv, {
      STRIPE_WEBHOOK_SECRET_TEST: "",
      fetch: async () => new Response("{}", { status: 200 }),
    }), testEvent, TEST_SECRET);
    assert.equal((await missing.json()).error, "test_mode_not_configured");

    const ok = await postWebhook(env, testEvent, TEST_SECRET);
    assert.equal((await ok.json()).test, true);
    const testKey = await kv.get("test:license-email:buyer@example.com");
    assert.ok(testKey);
    assert.equal(await kv.get("license-email:buyer@example.com"), "FL-LIVE0-LIVE");
    assert.equal(await kv.get("license:" + testKey), null);
    const stored = await kv.get("test:license:" + testKey, "json");
    assert.equal(stored.test, true);
    const skill = await skills(env, testKey);
    const skillBody = await skill.json();
    assert.equal(skill.status, 200);
    assert.equal(skillBody.test, true);
    const look = await (await postJson(env, "/api/admin/lookup", { key: testKey }, { "x-admin-secret": ADMIN })).json();
    assert.equal(look.test, true);
    assert.equal(JSON.stringify(look).includes(testKey), false);
  });

  it("marks an event processing before the email so a retry cannot send a second one", async () => {
    const kv = memoryKv();
    let during = null;
    let calls = 0;
    const env = testEnv(kv, {
      fetch: async () => {
        calls += 1;
        during = await kv.get("stripe-event:evt_once");
        return new Response("{}", { status: 200 });
      },
    });
    const event = checkoutEvent({ event: { id: "evt_once" } });
    event.id = "evt_once";
    const first = await postWebhook(env, event, LIVE_SECRET);
    const firstBody = await first.json();
    assert.equal(firstBody.issued, true);
    assert.equal(JSON.stringify(firstBody).includes("FL-"), false);
    assert.equal(during, "processing");
    assert.equal(await kv.get("stripe-event:evt_once"), "done");
    const second = await postWebhook(env, event, LIVE_SECRET);
    assert.equal((await second.json()).deduped, true);
    assert.equal(calls, 1);
  });
});

function skills(env, key) {
  return worker.fetch(new Request(
    "https://api.fleetlybots.com/api/skills/my-tasks?key=" + encodeURIComponent(key)), env);
}

function kb(env, key) {
  return worker.fetch(new Request(
    "https://api.fleetlybots.com/api/kb/search?key=" + encodeURIComponent(key) + "&q=fleetly+template"), env);
}

function ticket(env, key) {
  return postJson(env, "/api/tickets", { key: key, problem: "The license field will not save." });
}
