import assert from "node:assert/strict";
import { describe, it } from "node:test";
import worker, { REGISTRY_DB_MISMATCH, REGISTRY_QUERY_DB } from "../worker.js";
import {
  MEMBERSHIP_REQUIRED_NOTE,
  UPDATE_BEGIN,
  UPDATE_END,
  contentVersion,
  diffForLicense,
  entitlementCutoff,
  isKbRowIncluded,
  isMembershipGated,
  kbFromContentPage,
  licenseEnding,
  nextVersionMap,
  parseMachineBlock,
  renderUpdateEmail,
  skillFromRegistryPage,
  templateTriggerFor,
  triggerToSlug,
} from "../updates.js";

const KEY = "FL-HELLO-WXYZ";
const OTHER = "FL-OTHER-ABCD";

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
    async list({ prefix } = {}) {
      const keys = [...store.keys()]
        .filter(name => name.startsWith(prefix || ""))
        .sort()
        .map(name => ({ name }));
      return { keys, list_complete: true };
    },
  };
}

function testEnv(kv, extra = {}) {
  return Object.assign({
    LICENSES: kv,
    ADMIN_SECRET: "s3cret",
    RESEND_API_KEY: "re_test",
    NOTION_TOKEN: "ntn_test",
  }, extra);
}

function title(text) {
  return { title: [{ plain_text: text }] };
}
function rich(text) {
  return { rich_text: [{ plain_text: text }] };
}

async function post(env, path, body, headers) {
  return worker.fetch(new Request("https://api.fleetlybots.com" + path, {
    method: "POST",
    headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
    body: JSON.stringify(body == null ? {} : body),
  }), env);
}

function license(overrides) {
  return Object.assign({
    email: "buyer@example.com",
    status: "active",
    plan: "template",
    purchased: "2026-10-08",
    created: "2026-10-08",
  }, overrides || {});
}

function skillRow(overrides) {
  return Object.assign({
    storageKey: "skill:my-tasks",
    type: "skill",
    match: "my tasks:",
    version: "1.2",
    added: "2026-10-08",
    text: "When the user says my tasks: list the open work.",
    deprecated: false,
  }, overrides || {});
}

describe("membership gating", () => {
  it("treats a missing Added date as new", () => {
    assert.equal(isMembershipGated({
      type: "skill", action: "add", added: "", plan: "template", purchased: "2026-10-08",
    }), true);
    assert.equal(isMembershipGated({
      type: "skill", action: "add", added: "not-a-date", plan: "template", purchased: "2026-10-08",
    }), true);
  });

  it("gates a skill added after purchase plus 182 days", () => {
    assert.equal(entitlementCutoff("2026-10-08"), "2027-04-08");
    assert.equal(isMembershipGated({
      type: "skill", action: "add", added: "2027-04-08", plan: "template", purchased: "2026-10-08",
    }), false);
    assert.equal(isMembershipGated({
      type: "skill", action: "add", added: "2027-04-09", plan: "template", purchased: "2026-10-08",
    }), true);
  });

  it("does not gate an active membership", () => {
    assert.equal(isMembershipGated({
      type: "skill", action: "add", added: "", plan: "membership", purchased: "2026-10-08",
    }), false);
    assert.equal(isMembershipGated({
      type: "skill", action: "add", added: "2030-01-01", plan: "membership", purchased: "2026-10-08",
    }), false);
  });

  it("does not gate an update to a skill the buyer already has", () => {
    assert.equal(isMembershipGated({
      type: "skill", action: "update", added: "2030-01-01", plan: "template",
      previouslyDelivered: true, purchased: "2026-10-08",
    }), false);
    assert.equal(isMembershipGated({
      type: "skill", action: "add", added: "2030-01-01", plan: "template",
      previouslyDelivered: true, purchased: "2026-10-08",
    }), false);
  });

  it("does not gate knowledge-base rows or deprecations", () => {
    assert.equal(isMembershipGated({
      type: "kb", action: "add", added: "", plan: "template", purchased: "2026-10-08",
    }), false);
    assert.equal(isMembershipGated({
      type: "skill", action: "deprecate", added: "", plan: "template", purchased: "2026-10-08",
    }), false);
  });

  it("reads a timestamp purchase date as a calendar day", () => {
    assert.equal(isMembershipGated({
      type: "skill", action: "add", added: "2027-04-08", plan: "template",
      created: "2026-10-08T15:04:00.000Z",
    }), false);
  });
});

describe("draft exclusion", () => {
  const instructions = "When the user says my tasks: list every open task in the queue.";

  it("skips a skill with the Draft checkbox or the word draft in the name", () => {
    const drafted = skillFromRegistryPage({
      Skill: title("My Tasks"),
      Trigger: rich("my tasks:"),
      Instructions: rich(instructions),
      Draft: { checkbox: true },
    });
    assert.equal(drafted.skip, true);
    assert.equal(drafted.reason, "draft");

    const named = skillFromRegistryPage({
      Skill: title("Draft helper"),
      Trigger: rich("draft helper:"),
      Instructions: rich(instructions),
      Draft: { checkbox: false },
    });
    assert.equal(named.reason, "draft");
  });

  it("keeps a published skill and remembers the template trigger and Added date", () => {
    const row = skillFromRegistryPage({
      Skill: title("My Tasks"),
      Trigger: rich("my tasks:"),
      Instructions: rich("When Mike says my tasks: list every open task today."),
      Added: { date: { start: "2026-10-08" } },
      Version: rich("1.4"),
    });
    assert.equal(row.skip, false);
    assert.equal(row.slug, "my-tasks");
    assert.equal(row.match, "my tasks:");
    assert.equal(row.added, "2026-10-08");
    assert.equal(row.version, "1.4");
    assert.equal(row.text.includes("Mike"), false);
    assert.match(row.text, /the user/);
  });

  it("records a blank Added date instead of inventing one", () => {
    const row = skillFromRegistryPage({
      Skill: title("Clean"),
      Trigger: rich("clean:"),
      Instructions: rich("When the user says clean: remove every sample row."),
    });
    assert.equal(row.skip, false);
    assert.equal(row.added, "");
  });

  it("excludes Draft-checked KB rows and still honors Status", () => {
    assert.equal(isKbRowIncluded({
      Status: { select: { name: "Published" } },
      Draft: { checkbox: false },
    }), true);
    assert.equal(isKbRowIncluded({
      Status: { select: { name: "Published" } },
      Draft: { checkbox: true },
    }), false);
    assert.equal(isKbRowIncluded({
      Status: { select: { name: "Draft" } },
      Draft: { checkbox: false },
    }), false);
    assert.equal(isKbRowIncluded({
      Status: { status: { name: "Published" } },
    }), true);
    assert.equal(isKbRowIncluded({
      Draft: { checkbox: false },
    }), true);
    assert.equal(isKbRowIncluded({
      Draft: { checkbox: true },
    }), false);

    const published = kbFromContentPage({
      id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      properties: {
        Title: title("Reset a license"),
        Body: rich("Ask the buyer for the last four characters only."),
        Status: { select: { name: "Published" } },
        Draft: { checkbox: false },
        Version: rich("3"),
      },
    });
    assert.equal(published.skip, false);
    assert.equal(published.title, "Reset a license");
    assert.equal(published.version, "3");

    const drafted = kbFromContentPage({
      id: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee",
      properties: {
        Title: title("Secret draft"),
        Body: rich("This draft must never be mailed or searched."),
        Status: { select: { name: "Published" } },
        Draft: { checkbox: true },
      },
    });
    assert.equal(drafted.reason, "draft_or_unpublished");
  });
});

describe("trigger form", () => {
  it("maps API slugs to the template phrase and prefers the registry trigger", () => {
    assert.equal(triggerToSlug("my tasks:"), "my-tasks");
    assert.equal(triggerToSlug("complete my setup"), "complete-my-setup");
    assert.equal(templateTriggerFor("my-tasks", ""), "my tasks:");
    assert.equal(templateTriggerFor("my-tasks", "my tasks:"), "my tasks:");
    assert.equal(templateTriggerFor("complete-my-setup", "complete my setup"), "complete my setup");
    assert.equal(templateTriggerFor("results-for-me", ""), "results for me");
  });
});

describe("last-sent diffing", () => {
  const buyer = license();

  it("treats a first run as adds", () => {
    const items = diffForLicense([
      skillRow(),
      skillRow({
        storageKey: "skill:clean",
        match: "clean:",
        version: "1.0",
        added: "2030-01-01",
        text: "GATED_SECRET_INSTRUCTIONS for clean.",
      }),
    ], {}, buyer);
    assert.equal(items.length, 2);
    const open = items.find(item => item.match === "my tasks:");
    const gated = items.find(item => item.match === "clean:");
    assert.equal(open.action, "add");
    assert.equal(open.membership_required, false);
    assert.match(open.text, /open work/);
    assert.equal(gated.action, "add");
    assert.equal(gated.membership_required, true);
    assert.equal(gated.text, null);
  });

  it("sends only version changes after the map that was sent", () => {
    const catalog = [skillRow({ version: "1.3", text: "Updated my tasks instructions." })];
    const same = diffForLicense(catalog, { "skill:my-tasks": "1.3" }, buyer);
    assert.deepEqual(same, []);
    const changed = diffForLicense(catalog, { "skill:my-tasks": "1.2" }, buyer);
    assert.equal(changed.length, 1);
    assert.equal(changed[0].action, "update");
    assert.equal(changed[0].old_version, "1.2");
    assert.equal(changed[0].new_version, "1.3");
    assert.equal(changed[0].membership_required, false);
    assert.equal(changed[0].text, "Updated my tasks instructions.");
  });

  it("does not gate an update the buyer already received, even after the window", () => {
    const items = diffForLicense([
      skillRow({ added: "2030-06-01", version: "2.0", text: "Full update text." }),
    ], { "skill:my-tasks": "1.9" }, buyer);
    assert.equal(items.length, 1);
    assert.equal(items[0].action, "update");
    assert.equal(items[0].membership_required, false);
    assert.equal(items[0].text, "Full update text.");
  });

  it("deprecates a row the buyer had and does not repeat a gated notice", () => {
    const retired = diffForLicense([
      skillRow({ deprecated: true, version: "1.2" }),
    ], { "skill:my-tasks": "1.2" }, buyer);
    assert.equal(retired.length, 1);
    assert.equal(retired[0].action, "deprecate");
    assert.equal(retired[0].text, null);
    assert.equal(retired[0].match, "my tasks:");

    const quiet = diffForLicense([
      skillRow({
        storageKey: "skill:clean",
        match: "clean:",
        version: "1.0",
        added: "2030-01-01",
        text: "GATED_SECRET_INSTRUCTIONS",
      }),
    ], { "skill:clean": "gated:1.0" }, buyer);
    assert.deepEqual(quiet, []);

    const unlocked = diffForLicense([
      skillRow({
        storageKey: "skill:clean",
        match: "clean:",
        version: "1.0",
        added: "2030-01-01",
        text: "Now included.",
      }),
    ], { "skill:clean": "gated:1.0" }, license({ plan: "membership" }));
    assert.equal(unlocked[0].action, "add");
    assert.equal(unlocked[0].text, "Now included.");
  });

  it("stores the map that was sent, including gated markers", () => {
    const items = diffForLicense([
      skillRow({ version: "1.3" }),
      skillRow({
        storageKey: "skill:clean", match: "clean:", version: "1.0",
        added: "2030-01-01", text: "hidden",
      }),
    ], { "skill:my-tasks": "1.2" }, buyer);
    const map = nextVersionMap({ "skill:my-tasks": "1.2" }, items);
    assert.equal(map["skill:my-tasks"], "1.3");
    assert.equal(map["skill:clean"], "gated:1.0");
    assert.deepEqual(diffForLicense([
      skillRow({ version: "1.3" }),
      skillRow({
        storageKey: "skill:clean", match: "clean:", version: "1.0",
        added: "2030-01-01", text: "hidden",
      }),
    ], map, buyer), []);
  });

  it("uses the template trigger when a sent skill disappears from the catalog", () => {
    const items = diffForLicense([], { "skill:my-tasks": "1.2" }, buyer);
    assert.equal(items[0].action, "deprecate");
    assert.equal(items[0].match, "my tasks:");
  });
});

describe("email rendering", () => {
  const rendered = renderUpdateEmail({
    updateId: "FU-20261015-01",
    date: "2026-10-15",
    licenseKey: KEY,
    plan: "template",
    unsubscribeUrl: "https://api.fleetlybots.com/api/updates/unsubscribe?token=abc123",
    items: [
      {
        storageKey: "skill:my-tasks",
        type: "skill",
        match: "my tasks:",
        action: "update",
        old_version: "1.2",
        new_version: "1.3",
        text: "When the user says my tasks: list the open work. <b>phone</b>",
        membership_required: false,
      },
      {
        storageKey: "skill:clean",
        type: "skill",
        match: "clean:",
        action: "add",
        old_version: null,
        new_version: "1.0",
        text: null,
        membership_required: true,
      },
      {
        storageKey: "kb:aaaabbbb",
        type: "kb",
        match: "Reset a license",
        action: "add",
        old_version: null,
        new_version: "3",
        text: "Ask for the last four characters only.",
        membership_required: false,
      },
    ],
  });

  it("uses the spec subject, header, and machine block", () => {
    assert.equal(rendered.subject, "[Fleetly Update] FU-20261015-01 · 3 changes, 1 membership-required");
    assert.match(rendered.text, /Product: Fleetly/);
    assert.match(rendered.text, /Update: FU-20261015-01/);
    assert.match(rendered.text, /Date: 2026-10-15/);
    assert.match(rendered.text, /License ending: WXYZ/);
    assert.match(rendered.text, /Membership: none/);
    assert.match(rendered.text, /Changes: 3/);
    assert.match(rendered.text, /Membership-required: 1/);
    assert.ok(rendered.text.includes(UPDATE_BEGIN));
    assert.ok(rendered.text.includes(UPDATE_END));
    assert.match(rendered.text, /To stop these Fleetly update emails, open https:\/\/api.fleetlybots.com\/api\/updates\/unsubscribe\?token=abc123/);
  });

  it("never includes the full license key", () => {
    assert.equal(licenseEnding(KEY), "WXYZ");
    const blob = rendered.subject + "\n" + rendered.text + "\n" + rendered.html;
    assert.equal(blob.includes(KEY), false);
    assert.equal(blob.includes("FL-HELLO"), false);
    assert.equal(blob.includes("HELLO-WXYZ"), false);
    assert.ok(blob.includes("WXYZ"));
  });

  it("puts the template trigger and the full new text in the machine block", () => {
    const machine = parseMachineBlock(rendered.text);
    assert.equal(machine.license_ending, "WXYZ");
    assert.equal(machine.membership_required, 1);
    const skill = machine.items.find(item => item.match === "my tasks:");
    assert.equal(skill.action, "update");
    assert.equal(skill.old_version, "1.2");
    assert.equal(skill.new_version, "1.3");
    assert.match(skill.text, /list the open work/);
    assert.equal(JSON.stringify(machine).includes("my-tasks"), false);
    const gated = machine.items.find(item => item.match === "clean:");
    assert.equal(gated.membership_required, true);
    assert.equal(gated.note, MEMBERSHIP_REQUIRED_NOTE);
    assert.equal(Object.prototype.hasOwnProperty.call(gated, "text"), false);
    assert.equal(rendered.text.includes("GATED_SECRET_INSTRUCTIONS"), false);
    const article = machine.items.find(item => item.type === "kb");
    assert.equal(article.match, "Reset a license");
    assert.equal(article.text, "Ask for the last four characters only.");
  });

  it("keeps the machine block intact when the new text contains the markers", () => {
    const noisy = "line one\n" + UPDATE_BEGIN + "\n" + UPDATE_END + "\nstill the instruction";
    const mail = renderUpdateEmail({
      updateId: "FU-20261015-01",
      date: "2026-10-15",
      licenseKey: KEY,
      plan: "template",
      items: [{
        type: "skill", match: "my tasks:", action: "update",
        old_version: "1", new_version: "2", membership_required: false,
        text: noisy,
      }],
    });
    const machine = parseMachineBlock(mail.text);
    assert.equal(machine.items[0].text, noisy);
  });

  it("escapes HTML and refuses to render a body that contains the full key", () => {
    assert.match(rendered.html, /&lt;b&gt;phone&lt;\/b&gt;/);
    assert.equal(rendered.html.includes("<b>"), false);
    assert.throws(() => renderUpdateEmail({
      updateId: "FU-20261015-01",
      date: "2026-10-15",
      licenseKey: KEY,
      plan: "template",
      items: [{
        type: "skill", match: "my tasks:", action: "update",
        old_version: "1", new_version: "2", membership_required: false,
        text: "The key is " + KEY,
      }],
    }));
  });

  it("labels an active membership", () => {
    const mail = renderUpdateEmail({
      updateId: "FU-20261015-02",
      date: "2026-10-15",
      licenseKey: KEY,
      plan: "membership",
      items: [],
    });
    assert.match(mail.text, /Membership: active/);
    assert.equal(mail.text.includes(KEY), false);
  });
});

describe("endpoints", () => {
  it("registers a coordinator idempotently and rejects a bad license", async () => {
    const kv = memoryKv();
    await kv.put("license:" + KEY, JSON.stringify(license()));
    const env = testEnv(kv);
    const bad = await post(env, "/api/coordinator", { key: "FL-NOPE-XXXX", email: "c@example.com" });
    assert.equal(bad.status, 403);

    const first = await post(env, "/api/coordinator", { key: KEY, email: "coord@example.com" });
    assert.equal(first.status, 200);
    const body = await first.json();
    assert.deepEqual(body, { ok: true });
    assert.equal(JSON.stringify(body).includes(KEY), false);
    let stored = await kv.get("license:" + KEY, "json");
    assert.equal(stored.coordinator_email, "coord@example.com");
    assert.equal(stored.plan, "template");
    const token = stored.updates_unsub_token;
    assert.ok(token);
    assert.equal(token.includes(KEY), false);

    const second = await post(env, "/api/coordinator", { key: KEY, email: "new-coord@example.com" });
    assert.equal(second.status, 200);
    stored = await kv.get("license:" + KEY, "json");
    assert.equal(stored.coordinator_email, "new-coord@example.com");
    assert.equal(stored.updates_unsub_token, token);

    const refunded = await post(testEnv(kv), "/api/coordinator", {
      key: OTHER, email: "c@example.com",
    });
    await kv.put("license:" + OTHER, JSON.stringify(license({ status: "refunded" })));
    const denied = await post(env, "/api/coordinator", { key: OTHER, email: "c@example.com" });
    assert.equal(denied.status, 403);
    assert.equal(refunded.status, 403);
  });

  it("gates /api/skills from the registry Added date", async () => {
    const kv = memoryKv();
    await kv.put("license:" + KEY, JSON.stringify(license()));
    const env = testEnv(kv);
    const missing = await worker.fetch(new Request(
      "https://api.fleetlybots.com/api/skills/my-tasks?key=" + encodeURIComponent(KEY)), env);
    assert.equal(missing.status, 403);
    assert.equal((await missing.json()).error, "membership_required");

    await kv.put("skill-added:my-tasks", "2026-10-08");
    const allowed = await worker.fetch(new Request(
      "https://api.fleetlybots.com/api/skills/my-tasks?key=" + encodeURIComponent(KEY)), env);
    assert.equal(allowed.status, 200);

    await kv.put("skill-added:my-tasks", "2027-04-09");
    const later = await worker.fetch(new Request(
      "https://api.fleetlybots.com/api/skills/my-tasks?key=" + encodeURIComponent(KEY)), env);
    assert.equal(later.status, 403);

    await kv.put("license:" + KEY, JSON.stringify(license({ plan: "membership" })));
    const member = await worker.fetch(new Request(
      "https://api.fleetlybots.com/api/skills/my-tasks?key=" + encodeURIComponent(KEY)), env);
    assert.equal(member.status, 200);

    await kv.put("license:" + KEY, JSON.stringify(license()));
    await kv.put("skill-added:clean", "");
    const blank = await worker.fetch(new Request(
      "https://api.fleetlybots.com/api/skills/clean?key=" + encodeURIComponent(KEY)), env);
    assert.equal(blank.status, 403);
  });

  it("dry-run is the default and returns the rendered email without sending", async () => {
    const kv = memoryKv();
    await seedCatalog(kv);
    await kv.put("license:" + KEY, JSON.stringify(license({
      coordinator_email: "coord@example.com",
      updates_unsub_token: "tok-1",
    })));
    await kv.put("updates-unsub:tok-1", KEY);
    let fetches = 0;
    const env = testEnv(kv, { fetch: async () => { fetches += 1; throw new Error("should not send"); } });
    const denied = await post(env, "/api/admin/send-updates", {});
    assert.equal(denied.status, 401);

    const preview = await post(env, "/api/admin/send-updates", { date: "2026-10-15" }, {
      "x-admin-secret": "s3cret",
    });
    assert.equal(preview.status, 200);
    const body = await preview.json();
    assert.equal(body.dry_run, true);
    assert.equal(body.update_id, "FU-20261015-01");
    assert.equal(body.sent, 0);
    assert.equal(fetches, 0);
    assert.equal(await kv.get("updates-seq:20261015"), null);
    assert.equal(await kv.get("updates-sent:" + KEY), null);
    assert.equal(body.emails.length, 1);
    assert.equal(body.emails[0].to, "coord@example.com");
    assert.equal(body.emails[0].subject, "[Fleetly Update] FU-20261015-01 · 2 changes, 1 membership-required");
    const blob = JSON.stringify(body);
    assert.equal(blob.includes(KEY), false);
    assert.equal(blob.includes("FL-HELLO"), false);
    assert.match(body.emails[0].text, /License ending: WXYZ/);
    assert.match(body.emails[0].text, /my tasks:/);
    assert.equal(body.emails[0].text.includes("my-tasks"), false);
    assert.equal(body.emails[0].text.includes("GATED_SECRET_INSTRUCTIONS"), false);
    assert.match(body.emails[0].text, new RegExp(MEMBERSHIP_REQUIRED_NOTE));
    const machine = parseMachineBlock(body.emails[0].text);
    assert.equal(machine.items.find(item => item.match === "my tasks:").text.includes("open work"), true);

    const asString = await post(env, "/api/admin/send-updates", { dry_run: "false", date: "2026-10-15" }, {
      "x-admin-secret": "s3cret",
    });
    assert.equal((await asString.json()).dry_run, true);
    assert.equal(fetches, 0);
  });

  it("sends from updates@ and records the version map", async () => {
    const kv = memoryKv();
    await seedCatalog(kv);
    await kv.put("license:" + KEY, JSON.stringify(license({
      coordinator_email: "coord@example.com",
      updates_unsub_token: "tok-1",
    })));
    await kv.put("license:" + OTHER, JSON.stringify(license({
      coordinator_email: "other@example.com",
      updates_unsub_token: "tok-2",
    })));
    const calls = [];
    const env = testEnv(kv, {
      fetch: async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(init.body) });
        return new Response("{}", { status: 200 });
      },
    });
    const sent = await post(env, "/api/admin/send-updates", {
      dry_run: false,
      date: "2026-10-15",
      key: KEY,
    }, { "x-admin-secret": "s3cret" });
    const body = await sent.json();
    assert.equal(body.ok, true);
    assert.equal(body.dry_run, false);
    assert.equal(body.sent, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.resend.com/emails");
    assert.equal(calls[0].body.from, "Fleetly Updates <updates@fleetlybots.com>");
    assert.deepEqual(calls[0].body.to, ["coord@example.com"]);
    assert.equal(calls[0].body.text.includes(KEY), false);
    assert.equal(calls[0].body.html.includes(KEY), false);
    assert.match(calls[0].body.headers["List-Unsubscribe"], /token=tok-1/);
    const stored = JSON.parse(await kv.get("updates-sent:" + KEY));
    assert.equal(stored.update_id, "FU-20261015-01");
    assert.equal(stored.versions["skill:my-tasks"], "1.3");
    assert.equal(stored.versions["skill:clean"], "gated:1.0");
    assert.equal(await kv.get("updates-sent:" + OTHER), null);

    calls.length = 0;
    const again = await post(env, "/api/admin/send-updates", {
      dry_run: false,
      date: "2026-10-15",
      key: KEY,
    }, { "x-admin-secret": "s3cret" });
    const second = await again.json();
    assert.equal(second.sent, 0);
    assert.equal(calls.length, 0);
    assert.equal(second.skipped.some(row => row.reason === "no_changes" && row.license_ending === "WXYZ"), true);
    assert.equal(JSON.stringify(second).includes(KEY), false);
  });

  it("skips opt-out and turns the flag on from the unsubscribe link", async () => {
    const kv = memoryKv();
    await seedCatalog(kv);
    await kv.put("license:" + KEY, JSON.stringify(license({
      coordinator_email: "coord@example.com",
      updates_unsub_token: "tok-1",
      updates_opt_out: true,
    })));
    let fetches = 0;
    const env = testEnv(kv, { fetch: async () => { fetches += 1; return new Response("{}", { status: 200 }); } });
    const skipped = await post(env, "/api/admin/send-updates", { dry_run: false, date: "2026-10-15" }, {
      "x-admin-secret": "s3cret",
    });
    const body = await skipped.json();
    assert.equal(body.sent, 0);
    assert.equal(body.skipped[0].reason, "opt_out");
    assert.equal(fetches, 0);

    await kv.put("license:" + KEY, JSON.stringify(license({
      coordinator_email: "coord@example.com",
      updates_unsub_token: "tok-1",
    })));
    await kv.put("updates-unsub:tok-1", KEY);
    const page = await worker.fetch(new Request(
      "https://api.fleetlybots.com/api/updates/unsubscribe?token=tok-1"), env);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /turned off/);
    assert.equal(html.includes(KEY), false);
    assert.equal((await kv.get("license:" + KEY, "json")).updates_opt_out, true);
  });

  it("blocks a preview that would contain the full key", async () => {
    const kv = memoryKv();
    await kv.put("skill-index", JSON.stringify(["my-tasks"]));
    await kv.put("skill-record:my-tasks", JSON.stringify({
      slug: "my-tasks",
      match: "my tasks:",
      version: "9",
      added: "2026-10-08",
      text: "Do not mail " + KEY,
      deprecated: false,
    }));
    await kv.put("license:" + KEY, JSON.stringify(license({
      coordinator_email: "coord@example.com",
    })));
    const env = testEnv(kv, { fetch: async () => { throw new Error("should not send"); } });
    const res = await post(env, "/api/admin/send-updates", { date: "2026-10-15" }, {
      "x-admin-secret": "s3cret",
    });
    const body = await res.json();
    assert.equal(body.emails.length, 0);
    assert.equal(body.skipped[0].reason, "render_blocked");
    assert.equal(JSON.stringify(body).includes(KEY), false);
  });

  it("queries the live registry id and drops draft rows", async () => {
    assert.notEqual(REGISTRY_QUERY_DB, REGISTRY_DB_MISMATCH);
    const kv = memoryKv();
    const urls = [];
    const env = testEnv(kv, {
      fetch: async (url, init) => {
        const u = String(url);
        urls.push(u);
        if (u.includes(REGISTRY_DB_MISMATCH)) throw new Error("queried the unused registry id");
        const body = JSON.parse(init.body);
        if (!body.start_cursor) {
          return new Response(JSON.stringify({
            results: [{
              properties: {
                Skill: title("Draft helper"),
                Trigger: rich("draft helper:"),
                Instructions: rich("When the user says draft helper: this is not ready to ship."),
                Draft: { checkbox: true },
                Added: { date: { start: "2026-01-01" } },
              },
            }],
            has_more: true,
            next_cursor: "page-2",
          }), { status: 200 });
        }
        return new Response(JSON.stringify({
          results: [
            {
              properties: {
                Skill: title("My Tasks"),
                Trigger: rich("my tasks:"),
                Instructions: rich("When Mike says my tasks: list every open task for the user today."),
                Added: { date: { start: "2026-10-08" } },
                Version: rich("1.3"),
                "Applies to": rich("user"),
              },
            },
            {
              properties: {
                Skill: title("Clean"),
                Trigger: rich("clean:"),
                Instructions: rich("When the user says clean: remove the sample rows from the queue."),
                Version: rich("1.0"),
              },
            },
          ],
          has_more: false,
        }), { status: 200 });
      },
    });
    const res = await post(env, "/api/admin/sync-skills", {}, { "x-admin-secret": "s3cret" });
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.synced, 2);
    assert.ok(urls.every(url => url.includes(REGISTRY_QUERY_DB)));
    assert.equal(urls.some(url => url.includes(REGISTRY_DB_MISMATCH)), false);
    const index = JSON.parse(await kv.get("skill-index"));
    assert.deepEqual(index, ["my-tasks", "clean"]);
    assert.equal(await kv.get("skill-added:my-tasks"), "2026-10-08");
    assert.equal(await kv.get("skill-added:clean"), "");
    const record = JSON.parse(await kv.get("skill-record:my-tasks"));
    assert.equal(record.match, "my tasks:");
    assert.equal(record.version, "1.3");
    assert.equal(record.text.includes("Mike"), false);
    assert.equal(await kv.get("skill:draft-helper"), null);
  });

  it("syncs published KB rows and excludes drafts", async () => {
    const kv = memoryKv();
    const env = testEnv(kv, {
      fetch: async () => new Response(JSON.stringify({
        results: [
          page("11111111-1111-1111-1111-111111111111", {
            Title: title("Reset a license"),
            Body: rich("Published body for the license article."),
            Status: { select: { name: "Published" } },
            Draft: { checkbox: false },
            Version: rich("3"),
            Keywords: rich("license"),
          }),
          page("22222222-2222-2222-2222-222222222222", {
            Title: title("Still a draft"),
            Body: rich("Draft body that must stay out of search and mail."),
            Status: { select: { name: "Published" } },
            Draft: { checkbox: true },
          }),
          page("33333333-3333-3333-3333-333333333333", {
            Title: title("Unpublished"),
            Body: rich("Status is not published so this stays out."),
            Status: { select: { name: "Draft" } },
          }),
          page("44444444-4444-4444-4444-444444444444", {
            Title: title("Template article"),
            Body: rich("No Status property, Draft unchecked, so it ships."),
            Draft: { checkbox: false },
          }),
        ],
        has_more: false,
      }), { status: 200 }),
    });
    const res = await post(env, "/api/admin/sync-kb", {}, { "x-admin-secret": "s3cret" });
    const body = await res.json();
    assert.equal(body.synced, 2);
    const index = JSON.parse(await kv.get("kb:index"));
    assert.deepEqual(index.map(row => row.title), ["Reset a license", "Template article"]);
    const article = JSON.parse(await kv.get("kb:11111111"));
    assert.equal(article.version, "3");
    assert.equal(await kv.get("kb:22222222"), null);
    assert.equal(await kv.get("kb:33333333"), null);
    assert.equal(contentVersion("", "x").startsWith("h"), true);
  });

  it("requires an active license for the coordinator and keeps test sends in the test namespace", async () => {
    const kv = memoryKv();
    const revokedKey = "FL-REVOK-ED99";
    const testKey = "FL-TESTK-EY99";
    await kv.put("license:" + revokedKey, JSON.stringify(license({
      status: "revoked",
      coordinator_email: "r@example.com",
    })));
    await kv.put("test:license:" + testKey, JSON.stringify(license({ test: true })));
    await kv.put("skill-index", JSON.stringify(["my-tasks"]));
    await kv.put("skill-record:my-tasks", JSON.stringify({
      slug: "my-tasks",
      match: "my tasks:",
      version: "1.0",
      added: "2026-10-08",
      text: "When the user says my tasks: list the open work.",
      deprecated: false,
    }));
    const calls = [];
    const env = testEnv(kv, {
      fetch: async (url, init) => {
        calls.push(JSON.parse(init.body));
        return new Response("{}", { status: 200 });
      },
    });

    const revoked = await post(env, "/api/coordinator", { key: revokedKey, email: "r@example.com" });
    assert.equal(revoked.status, 403);

    const registered = await post(env, "/api/coordinator", { key: testKey, email: "t@example.com" });
    assert.equal(registered.status, 200);
    const registeredBody = await registered.json();
    assert.deepEqual(registeredBody, { ok: true, test: true });
    assert.equal(JSON.stringify(registeredBody).includes(testKey), false);
    const stored = await kv.get("test:license:" + testKey, "json");
    assert.equal(stored.coordinator_email, "t@example.com");
    assert.equal(await kv.get("license:" + testKey), null);
    assert.equal(await kv.get("test:updates-unsub:" + stored.updates_unsub_token), testKey);
    assert.equal(await kv.get("updates-unsub:" + stored.updates_unsub_token), null);

    const broadcast = await post(env, "/api/admin/send-updates", { dry_run: false, date: "2026-10-15" }, {
      "x-admin-secret": "s3cret",
    });
    const broadcastBody = await broadcast.json();
    assert.equal(broadcastBody.sent, 0);
    assert.equal(broadcastBody.skipped.some(row => row.license_ending === "ED99" && row.reason === "inactive"), true);
    assert.equal(calls.length, 0);

    const targeted = await post(env, "/api/admin/send-updates", {
      dry_run: false,
      date: "2026-10-15",
      key: testKey,
    }, { "x-admin-secret": "s3cret" });
    const targetedBody = await targeted.json();
    assert.equal(targetedBody.sent, 1);
    assert.equal(targetedBody.emails[0].to, "t@example.com");
    assert.equal(JSON.stringify(targetedBody).includes(testKey), false);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].text.includes(testKey), false);
    assert.equal(await kv.get("updates-sent:" + testKey), null);
    assert.ok(await kv.get("test:updates-sent:" + testKey));
  });
});

function page(id, properties) {
  return { id, properties };
}

async function seedCatalog(kv) {
  await kv.put("skill-index", JSON.stringify(["my-tasks", "clean"]));
  await kv.put("skill-record:my-tasks", JSON.stringify({
    slug: "my-tasks",
    match: "my tasks:",
    version: "1.3",
    added: "2026-10-08",
    text: "When the user says my tasks: list the open work.",
    deprecated: false,
  }));
  await kv.put("skill-record:clean", JSON.stringify({
    slug: "clean",
    match: "clean:",
    version: "1.0",
    added: "2030-01-01",
    text: "GATED_SECRET_INSTRUCTIONS for the clean skill.",
    deprecated: false,
  }));
}
