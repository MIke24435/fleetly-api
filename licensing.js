// License decisions that do not touch KV or Stripe. The worker applies them.

export const TEMPLATE_AMOUNT_CENTS = 4900;
export const MEMBERSHIP_AMOUNT_CENTS = 600;

const KEY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function licenseEnding(key) {
  return String(key || "").slice(-4);
}

export function makeLicenseKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let s = "";
  for (const b of bytes) s += KEY_ALPHABET[b % KEY_ALPHABET.length];
  return "FL-" + s.slice(0, 5) + "-" + s.slice(5);
}

export function isActiveLicense(record) {
  return !!(record && record.status === "active");
}

export function stripeId(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  return value.id || "";
}

// A second template purchase while the key is already active must not move
// the purchase date forward. A revoked key that is bought again starts a
// new window. Subscriptions never move the date.
export function nextPurchaseDate(record, mode, today, isNew) {
  if (mode === "subscription") {
    return (record && record.purchased) || today;
  }
  if (!isNew && record && record.status === "active" && record.purchased) {
    return record.purchased;
  }
  return today;
}

export function ownsTemplateAfterCheckout(record, mode) {
  if (mode !== "subscription") return true;
  if (!record) return false;
  if (record.owns_template === true) return true;
  // Records written before owns_template existed still own the template
  // when that is the plan on file.
  if (record.plan === "template") return true;
  return false;
}

// Full refund of the template purchase revokes the key. Any refund of a
// membership charge only drops the plan. Receipt email is not an input.
export function classifyRefund(charge, mapping) {
  const amount = Number(charge && charge.amount) || 0;
  const refundedAmount = Number(charge && charge.amount_refunded) || 0;
  const full = !!(charge && (charge.refunded === true || (amount > 0 && refundedAmount >= amount)));
  const product = (mapping && mapping.product) || inferRefundProduct(charge);
  if (product === "template") {
    if (full) return { action: "revoke", product: "template" };
    return { action: "ignore", reason: "partial_template_refund", product: "template" };
  }
  if (product === "membership") {
    if (refundedAmount > 0 || full) return { action: "drop_membership", product: "membership" };
    return { action: "ignore", reason: "no_refund_amount", product: "membership" };
  }
  return { action: "ignore", reason: "unknown_charge", product: "" };
}

function inferRefundProduct(charge) {
  if (!charge) return "";
  if (charge.invoice) return "membership";
  if (Number(charge.amount) === TEMPLATE_AMOUNT_CENTS) return "template";
  if (Number(charge.amount) === MEMBERSHIP_AMOUNT_CENTS) return "membership";
  return "";
}

// past_due and unpaid match cancellation: the key stays active on the
// template plan. Restoring "active" puts the membership back.
export function planForSubscriptionStatus(status) {
  if (status === "past_due" || status === "unpaid" || status === "canceled" || status === "cancelled") {
    return "template";
  }
  if (status === "active" || status === "trialing") return "membership";
  return null;
}

export function redactLicenseKey(value, key) {
  const text = value == null ? "" : String(value);
  if (!key || key.length <= 4 || !text.includes(key)) return text;
  return text.split(key).join(licenseEnding(key));
}

export function publicLicenseView(record, key, test) {
  const rec = record || {};
  const view = {
    ok: true,
    license_ending: licenseEnding(key),
    test: !!(test || rec.test),
    email: redactLicenseKey(rec.email || "", key),
    name: redactLicenseKey(rec.name || "", key),
    status: rec.status || "",
    plan: rec.plan || "",
    purchased: rec.purchased || "",
    created: redactLicenseKey(rec.created || "", key),
    stripe_customer: redactLicenseKey(rec.stripe_customer || "", key),
    revoked_at: rec.revoked_at || "",
    revoke_reason: redactLicenseKey(rec.revoke_reason || "", key),
    note: redactLicenseKey(rec.note || "", key),
    owns_template: rec.owns_template === true,
    rotated_to_ending: rec.rotated_to_ending || "",
  };
  const blob = JSON.stringify(view);
  if (key && key.length > 4 && blob.includes(key)) {
    throw new Error("lookup leaked a full license key");
  }
  return view;
}

export function cancellationHtml(key, lines) {
  const ending = licenseEnding(key);
  const body = (lines || []).map(line => "<p>" + line + "</p>").join("");
  const html = body
    + "<p>License ending <strong>" + ending + "</strong>.</p>"
    + "<p>— The Fleetly team</p>";
  if (key && key.length > 4 && html.includes(key)) {
    throw new Error("email leaked a full license key");
  }
  return html;
}

export async function secretsMatch(provided, secret) {
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(String(provided || ""))),
    crypto.subtle.digest("SHA-256", enc.encode(String(secret || ""))),
  ]);
  const hex = (buf) => [...new Uint8Array(buf)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  return timedEqual(hex(a), hex(b));
}

export function timedEqual(a, b) {
  const left = String(a);
  const right = String(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i++) diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return diff === 0;
}

export async function adminAuthorized(provided, secret) {
  if (!secret) return false;
  return secretsMatch(provided || "", secret);
}
