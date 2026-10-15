// Pure OTA update logic. No KV, no fetch, no email delivery.
// The worker wires this to licenses, the Notion sync, and Resend.

export const MEMBERSHIP_REQUIRED_NOTE = "Available with a Fleetly membership";

export const MEMBERSHIP_WINDOW_DAYS = 182;

export const UPDATE_BEGIN = "=== BEGIN FLEETLY UPDATE v1 ===";
export const UPDATE_END = "=== END FLEETLY UPDATE v1 ===";

export const UPDATES_FROM = "Fleetly Updates <updates@fleetlybots.com>";

// Seeded skills are stored under API slugs. Emails must use the template
// trigger the buyer actually types. The registry Trigger field wins when
// the sync has stored it; this map covers rows that only have a slug.
export const TRIGGER_TEMPLATE = {
  "agent": "agent:",
  "deactivate": "deactivate:",
  "fleet": "fleet:",
  "help": "help:",
  "load": "load:",
  "my-tasks": "my tasks:",
  "my-usage-resets": "my usage:",
  "note-is": "note:",
  "onboard": "onboard:",
  "quota-board": "quota board:",
  "rebalance": "rebalance:",
  "automatic": "automatic:",
  "results-for-me": "results for me",
  "save": "save:",
  "health-check": "health check:",
  "onboarding": "onboard:",
  "update-fleet": "update fleet:",
  "support": "support",
  "clean": "clean:",
};

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

export function asIsoDate(value, fallback) {
  const m = String(value == null ? "" : value).match(ISO_DATE);
  if (m) return m[1] + "-" + m[2] + "-" + m[3];
  return fallback == null ? "" : fallback;
}

export function addDays(isoDate, days) {
  const m = String(isoDate || "").match(ISO_DATE);
  if (!m) return "";
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

export function entitlementCutoff(purchased) {
  const day = asIsoDate(purchased, "");
  if (!day) return "";
  return addDays(day, MEMBERSHIP_WINDOW_DAYS);
}

export function licenseEnding(key) {
  return String(key || "").slice(-4);
}

export function membershipStatus(plan) {
  return plan === "membership" ? "active" : "none";
}

export function licenseIsActive(lic) {
  return !!(lic && lic.status === "active");
}

// Brand-new skills gate. A skill the buyer already received does not,
// and an active membership never gates. A missing or unparseable Added
// date is treated as new, so it gates.
export function isMembershipGated(input) {
  const type = input.type || "skill";
  if (type !== "skill") return false;
  if (input.action === "deprecate") return false;
  if (input.action === "update" || input.previouslyDelivered) return false;
  if (input.plan === "membership") return false;
  const added = asIsoDate(input.added, "");
  if (!added) return true;
  const purchased = asIsoDate(input.purchased || input.created, "2026-10-09");
  return added > entitlementCutoff(purchased);
}

export function triggerToSlug(raw) {
  return String(raw || "").trim().replace(/:$/, "").replace(/\s+/g, "-").toLowerCase();
}

export function templateTriggerFor(slug, rawTrigger) {
  const raw = String(rawTrigger || "").trim();
  if (raw) return raw;
  if (TRIGGER_TEMPLATE[slug]) return TRIGGER_TEMPLATE[slug];
  return String(slug || "").replace(/-/g, " ");
}

export function notionPlainText(prop) {
  if (prop == null) return "";
  if (typeof prop === "string") return prop;
  if (typeof prop === "number") return String(prop);
  if (Array.isArray(prop.title)) return prop.title.map(partText).join("");
  if (Array.isArray(prop.rich_text)) return prop.rich_text.map(partText).join("");
  if (prop.select && prop.select.name) return prop.select.name;
  if (prop.status && prop.status.name) return prop.status.name;
  if (Array.isArray(prop.multi_select)) return prop.multi_select.map(x => x.name || "").join(", ");
  if (prop.number != null) return String(prop.number);
  if (prop.date && prop.date.start) return String(prop.date.start);
  if (prop.formula) {
    if (prop.formula.string != null) return String(prop.formula.string);
    if (prop.formula.number != null) return String(prop.formula.number);
    if (prop.formula.date && prop.formula.date.start) return String(prop.formula.date.start);
  }
  return "";
}

function partText(part) {
  return (part && (part.plain_text || (part.text && part.text.content))) || "";
}

export function notionDate(prop) {
  if (!prop) return "";
  if (prop.date && prop.date.start) return asIsoDate(prop.date.start, "");
  if (prop.formula && prop.formula.date && prop.formula.date.start) {
    return asIsoDate(prop.formula.date.start, "");
  }
  return asIsoDate(notionPlainText(prop), "");
}

export function contentVersion(explicit, text) {
  const v = String(explicit || "").trim();
  if (v) return v;
  let h = 0x811c9dc5;
  const s = String(text || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return "h" + (h >>> 0).toString(16).padStart(8, "0");
}

export function isDraftSkill(skillName, draftCheckbox) {
  if (draftCheckbox === true) return true;
  return /\bdraft\b/i.test(skillName || "");
}

// Status = Published stays in force when that property exists. A Draft
// checkbox excludes the row either way, including on databases that have
// no Status property (the template Knowledge Base).
export function isKbRowIncluded(props) {
  if (!props) return false;
  const draft = props.Draft;
  if (draft && draft.checkbox === true) return false;
  if (Object.prototype.hasOwnProperty.call(props, "Status")) {
    return statusName(props.Status) === "Published";
  }
  return true;
}

function statusName(prop) {
  if (!prop) return "";
  if (prop.select && prop.select.name) return prop.select.name;
  if (prop.status && prop.status.name) return prop.status.name;
  return "";
}

export function skillFromRegistryPage(props) {
  const properties = props || {};
  const skillName = notionPlainText(properties.Skill).trim();
  const rawTrigger = notionPlainText(properties.Trigger).trim();
  const instructions = notionPlainText(properties.Instructions).trim();
  const appliesTo = notionPlainText(properties["Applies to"]).trim().toLowerCase();
  const draftBox = properties.Draft && properties.Draft.checkbox === true;
  if (isDraftSkill(skillName, draftBox)) return { skip: true, reason: "draft" };
  const slug = triggerToSlug(rawTrigger);
  if (!slug || !instructions || instructions.length < 20) return { skip: true, reason: "incomplete" };
  if (appliesTo && !appliesTo.includes("user") && !appliesTo.includes("all")) {
    return { skip: true, reason: "audience" };
  }
  const text = instructions.replace(/\bMike's\b/g, "the user's").replace(/\bMike\b/g, "the user");
  const explicitVersion = notionPlainText(properties.Version).trim();
  return {
    skip: false,
    slug: slug,
    match: templateTriggerFor(slug, rawTrigger),
    version: contentVersion(explicitVersion, text),
    explicitVersion: explicitVersion,
    added: notionDate(properties.Added),
    updated: notionDate(properties.Updated) || notionPlainText(properties.Updated).trim(),
    text: text,
  };
}

export function kbFromContentPage(page) {
  const props = (page && page.properties) || {};
  if (!isKbRowIncluded(props)) return { skip: true, reason: "draft_or_unpublished" };
  const title = notionPlainText(props.Title).trim();
  const body = notionPlainText(props.Body).trim();
  if (!title || !body) return { skip: true, reason: "incomplete" };
  const explicitVersion = notionPlainText(props.Version).trim();
  return {
    skip: false,
    id: String(page.id || "").replace(/-/g, "").slice(0, 8),
    title: title,
    type: statusName(props.Type) || notionPlainText(props.Type).trim(),
    body: body,
    keywords: notionPlainText(props.Keywords).trim().toLowerCase(),
    version: contentVersion(explicitVersion, body),
  };
}

function wasDelivered(prev) {
  return typeof prev === "string" && prev.length > 0 && prev !== "deprecated" && !prev.startsWith("gated:");
}

function compareItems(a, b) {
  if (a.type !== b.type) return a.type === "skill" ? -1 : 1;
  return String(a.match).localeCompare(String(b.match));
}

// catalog rows: { storageKey, type, match, version, added, text, deprecated }
// lastVersions: { "skill:<slug>": "<version>" | "gated:<version>" | "deprecated" }
export function diffForLicense(catalog, lastVersions, license) {
  const versions = lastVersions || {};
  const lic = license || {};
  const items = [];
  const seen = new Set();

  for (const row of catalog || []) {
    if (!row || !row.storageKey) continue;
    seen.add(row.storageKey);
    const prev = versions[row.storageKey];
    const delivered = wasDelivered(prev);

    if (row.deprecated) {
      if (delivered) {
        items.push(itemFrom(row, "deprecate", prev, null, false, null));
      }
      continue;
    }

    if (!delivered) {
      const gated = isMembershipGated({
        type: row.type,
        action: "add",
        added: row.added,
        plan: lic.plan,
        previouslyDelivered: false,
        purchased: lic.purchased,
        created: lic.created,
      });
      if (gated && prev === "gated:" + row.version) continue;
      items.push(itemFrom(row, "add", null, row.version, gated, gated ? null : row.text));
      continue;
    }

    if (prev !== row.version) {
      items.push(itemFrom(row, "update", prev, row.version, false, row.text));
    }
  }

  for (const key of Object.keys(versions)) {
    if (seen.has(key)) continue;
    const prev = versions[key];
    if (!wasDelivered(prev)) continue;
    const type = key.startsWith("kb:") ? "kb" : "skill";
    const idPart = key.slice(key.indexOf(":") + 1);
    const match = type === "skill" ? templateTriggerFor(idPart, "") : idPart;
    items.push({
      storageKey: key,
      type: type,
      match: match,
      action: "deprecate",
      old_version: prev,
      new_version: null,
      text: null,
      membership_required: false,
    });
  }

  items.sort(compareItems);
  return items;
}

function itemFrom(row, action, oldVersion, newVersion, gated, text) {
  return {
    storageKey: row.storageKey,
    type: row.type,
    match: row.match,
    action: action,
    old_version: oldVersion,
    new_version: newVersion,
    text: text,
    membership_required: gated,
  };
}

export function nextVersionMap(previous, items) {
  const map = Object.assign({}, previous || {});
  for (const item of items || []) {
    if (!item.storageKey) continue;
    if (item.action === "deprecate") map[item.storageKey] = "deprecated";
    else if (item.membership_required) map[item.storageKey] = "gated:" + item.new_version;
    else map[item.storageKey] = item.new_version;
  }
  return map;
}

export function subjectLine(updateId, items) {
  const list = items || [];
  const n = list.length;
  const m = list.filter(item => item.membership_required).length;
  return "[Fleetly Update] " + updateId + " · " + n + " changes, " + m + " membership-required";
}

export function formatUpdateId(date, seq) {
  const ymd = String(date || "").replace(/-/g, "");
  return "FU-" + ymd + "-" + String(seq).padStart(2, "0");
}

function publicItem(item) {
  const out = {
    type: item.type,
    match: item.match,
    action: item.action,
    old_version: item.old_version,
    new_version: item.new_version,
    membership_required: !!item.membership_required,
  };
  if (item.membership_required) {
    out.note = MEMBERSHIP_REQUIRED_NOTE;
  } else if (item.action !== "deprecate") {
    out.text = item.text == null ? "" : item.text;
  }
  return out;
}

function humanLine(item) {
  const kind = item.type === "kb" ? "kb" : "skill";
  const name = JSON.stringify(String(item.match));
  if (item.membership_required) {
    return "- add " + kind + " " + name + " → " + item.new_version + " — " + MEMBERSHIP_REQUIRED_NOTE;
  }
  if (item.action === "deprecate") {
    return "- deprecate " + kind + " " + name + " " + item.old_version + " → retired";
  }
  if (item.action === "update") {
    return "- update " + kind + " " + name + " " + item.old_version + " → " + item.new_version;
  }
  return "- add " + kind + " " + name + " → " + item.new_version;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export class LicenseKeyLeakError extends Error {
  constructor() {
    super("refusing to render an update email that contains a full license key");
    this.name = "LicenseKeyLeakError";
    this.code = "license_key_leak";
  }
}

export function renderUpdateEmail(opts) {
  const items = opts.items || [];
  const ending = licenseEnding(opts.licenseKey);
  const membership = membershipStatus(opts.plan);
  const n = items.length;
  const m = items.filter(item => item.membership_required).length;
  const header = [
    "Product: Fleetly",
    "Update: " + opts.updateId,
    "Date: " + opts.date,
    "License ending: " + ending,
    "Membership: " + membership,
    "Changes: " + n,
    "Membership-required: " + m,
  ].join("\n");
  const summary = items.length ? items.map(humanLine).join("\n") : "No changes.";
  const machine = JSON.stringify({
    v: 1,
    update_id: opts.updateId,
    date: opts.date,
    product: "Fleetly",
    license_ending: ending,
    membership: membership,
    changes: n,
    membership_required: m,
    items: items.map(publicItem),
  }, null, 2);
  const unsub = opts.unsubscribeUrl
    ? "To stop these Fleetly update emails, open " + opts.unsubscribeUrl
    : "To stop these Fleetly update emails, use the unsubscribe link from Fleetly.";
  const text = [
    header,
    "",
    summary,
    "",
    "Unedited rows apply on their own. Customized rows stay as you left them.",
    "",
    UPDATE_BEGIN,
    machine,
    UPDATE_END,
    "",
    unsub,
    "",
  ].join("\n");
  const html = "<pre style=\"font-family:ui-monospace,monospace;white-space:pre-wrap\">"
    + escapeHtml(text) + "</pre>";
  const key = String(opts.licenseKey || "");
  if (key.length > 4 && (text.includes(key) || html.includes(key))) {
    throw new LicenseKeyLeakError();
  }
  return {
    subject: subjectLine(opts.updateId, items),
    text: text,
    html: html,
    license_ending: ending,
  };
}

export function parseMachineBlock(text) {
  // Markers are whole lines. Item text is JSON, so a copy of either marker
  // inside an instruction stays on the JSON line and does not close the block.
  const lines = String(text || "").split("\n");
  const start = lines.indexOf(UPDATE_BEGIN);
  let end = -1;
  for (let i = lines.length - 1; i > start; i--) {
    if (lines[i] === UPDATE_END) { end = i; break; }
  }
  if (start < 0 || end < 0) return null;
  return JSON.parse(lines.slice(start + 1, end).join("\n"));
}

export function makeUnsubToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}
