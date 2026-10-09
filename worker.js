// Fleetly License API — serves skill instructions to licensed installs.
// KV namespace "LICENSES" must be bound. Keys: "license:<KEY>" -> {"email","status","created"}

const SKILL_ADDED = {
  // added-date per trigger; skills added after a buyer's entitlement cutoff
  // require an active membership. Update this when shipping a new skill.
  "agent": "2026-10-08", "deactivate": "2026-10-08", "fleet": "2026-10-08",
  "help": "2026-10-08", "load": "2026-10-08", "my-tasks": "2026-10-08",
  "my-usage-resets": "2026-10-08", "note-is": "2026-10-08", "onboard": "2026-10-08",
  "quota-board": "2026-10-08", "rebalance": "2026-10-08", "automatic": "2026-10-08",
  "results-for-me": "2026-10-08", "save": "2026-10-08", "health-check": "2026-10-08",
  "onboarding": "2026-10-08", "update-fleet": "2026-10-08",
  "support": "2026-10-08",
};

const SKILLS = {
 "agent": "Dispatch a task. When Mike says 'Agent <name>: <prompt>' (e.g. 'Agent muse: draft the memo', 'Agent Grok Bot: summarize this'): create a row in the AI Task Queue with Task=<about five words from the prompt>, Status=Routed, Assigned AI=<named AI>, Assigned by=<your own name, or Mike if Mike said it>, Priority=Medium (High/Low if he says so), Prompt=<the prompt verbatim>; confirm in one line: 'Sent to <AI>.' Any fleet member can be named, including Grok Bot \u2014 upward delegation works exactly like downward delegation. When he says 'Agent: <prompt>' (no name): recommend the best agent yourself \u2014 strength match from the AI Fleet roster first, then quota headroom vs reset from the Usage Log, then least recently used; never invent quota figures (if stale or missing, decide on strength alone and say so) \u2014 then present your recommendation PLUS the other suitable AIs as tappable choices (only AIs suitable for this task: strength match and quota headroom, no unsuitable options); dispatch to Mike's pick and confirm 'Sent to <AI> \u2014 your pick.' or 'Sent to <AI> \u2014 my recommendation.' Efficiency: prefer free-tier AIs for suitable tasks; reserve Grok for what only it does well (real-time X/news, heavy research, Finance connector). If the request looks wasteful for the remaining quota (oversized job, re-run of settled work), say so briefly and suggest the cheaper path before dispatching.",
 "deactivate": "When Mike says 'deactivate: <AI>' (removing an AI from active fleet use): 1) Rename its AI Fleet roster row to '<AI> (inactive)' and record why in its notes. 2) From then on, exclude it from 'Agent:' suggestions, rebalance moves, the quota board, and the 'fleet:' active list. 3) Keep its task history and usage log rows intact \u2014 nothing is deleted. 4) Confirm in one line what was deactivated and why.",
 "fleet": "When Mike says 'fleet:', read the AI Fleet roster and return a table of fleet members and their properties: AI | Role | Strengths | Access | Quota state | Cost notes. List active members first; inactive members in a separate short section at the end (or omit if none). Keep strengths to one line each.",
 "help": "When Mike says 'help:', fetch the static help page https://app.notion.com/p/3f15be5f19568174ae0df0752fe41e95 with the fetch tool (never a database query) and show ONLY its 'Trigger index' section, exactly as written: no reformatting, no commentary. When he says 'help: <trigger>' (e.g. 'help: agent:'), show ONLY that trigger's section from 'Trigger details', exactly as written. End with the How-It-Works link from the page footer.",
 "load": "When Mike says 'load: <name>', run that saved report from Fleet Reports (data source ). 1) Fetch the row whose Name matches <name> (case-insensitive). If none, say so and list the saved names. 2) Follow Spec exactly. Never use a remembered copy. Where it says [AI], use your own name. 3) Write a one-line outcome to Last result and set Updated to today YYYY-MM-DD. 4) Reply in the layout the spec requires. 5) Do not trade, send, or move money.",
 "my-tasks": "When the user says 'my tasks:', they are asking as one of the fleet's field agents: what has the coordinator assigned me? 1) Query the AI Task Queue for rows where Assigned AI is [AI] (your own name) and Status is not Done \u2014 select the row id too, you need it for updates. 2) Number the pending tasks 1..N, High priority first, and report in columns, phone-narrow: Task | Status | Priority, with the full Prompt under each. Offer one 'Process: <task>' button per task plus a 'Process all' button (2+ tasks), and note they can also reply with numbers (e.g. '1, 3') or 'all'. 3) If the user names another AI ('my tasks: for grok'), report that AI's pending instead. 4) Selection: a tapped 'Process: <task>' runs that one; 'Process all' or 'all' runs every pending task in listed order; numbers run just those. For each, complete the contract in order: (a) write the FULL formatted answer into the task's Notion page body, (b) write a one-line summary into the Result column, (c) set 'Date Completed' to today's date (YYYY-MM-DD), (d) set Status=Done \u2014 all in a single update call using the row id from step 1 (never re-query to find the row). Never set Status=Done unless the page body holds the complete answer. If 'Date Assigned' is blank when you pick up a task, fill it with today's date too. 5) If the Notion query fails on usage limits, say so plainly and do not retry in a loop.",
 "my-usage-resets": "When Mike says 'my usage: 40%, resets Oct 9', he is an agent reporting his quota to the coordinator. Append a row to the AI Usage Log: Date=today as YYYY-MM-DD, AI=[AI] (your own name), Usage %=the number, Resets=the 'resets <when>' text. Confirm in one line. Also accept the explicit form 'log usage <AI> <%> resets <when>' to log another AI's figures \u2014 any AI (or Mike) can report for a dry one, e.g. 'log usage grok 100%, resets Thursday'. A 100% row means that AI is exhausted: its outstanding tasks are 'waiting on quota' and eligible for rescue by rebalance.",
 "note-is": "When Mike says 'note: claude is excellent at editing long documents' (recording an observed AI strength for future routing): 1) Find that AI's row in the AI Fleet database. 2) Append a dated line to its Strengths field: 'YYYY-MM-DD: <observation>' \u2014 keep all existing content, add on a new line. 3) Confirm in one line what was noted. Strengths begin as draft assessments; dated observations accumulate beneath them, and 'Agent' dispatch and 'triage' read the live field \u2014 so a noted strength immediately changes future picks. He can also file an operational note with a topic: 'note: <AI> <topic>: <observation>' \u2014 topics are formatting, preferences, setup, quota (e.g. 'note: chatgpt formatting: keep tables narrow for phone'). Topic notes go to the AI Field Guide database (columns AI / Topic / Note / Updated): if a row already exists for that AI x topic, append the dated observation to its Note on a new line and set Updated to today; otherwise create the row. Strengths always stay on the AI Fleet roster \u2014 never move a strengths note into the Guide. 'strengths' as a topic, or no topic at all, means the roster.",
 "onboard": "When Mike says 'onboard: <AI>' (adding a new free AI to the fleet): 1) Create its row in the AI Fleet roster with strengths pre-seeded from current web reviews of that AI, plus its access paths, quota state, and cost notes (ask Mike for anything you cannot verify). 2) Generate the one-time paste for its settings \u2014 one universal paste, identical for every AI, no per-AI customization: 1) find your onboarding page in Notion (Fleetly > Fleet Onboarding \u2014 the page with your name on it) and follow it going forward (the AI resolves its own name; the user never types a page path); 2) where the Fleet Skills database lives (Notion, under his Fleetly page), fetch the row matching his trigger phrase fresh each time, follow its Instructions exactly, substitute your own name for [AI]. Keep it short. 3) Give Mike the 3-command smoke test: 'my tasks:', 'my usage:', then one trial task end to end. 4) Have the new AI self-verify it can read and write the fleet databases (registry, Task Queue, Usage Log) \u2014 an AI without a working Notion connector cannot be a field agent.",
 "quota-board": "When Mike says 'quota board:', read the AI Usage Log and report the latest row per AI as a compact table: AI | Usage % | Resets. Cover all active fleet members (Grok Bot, Grok, Muse, ChatGPT, Claude). Then add one burn-rate line per AI: usage % consumed vs time elapsed since reset \u2014 flag it when an AI is burning faster than the sustainable pace that lasts the cycle (e.g. 'Grok 60%, 4 days left \u2014 2x sustainable pace'). Keep it to the table plus the burn lines.",
 "rebalance": "Grok Bot's rebalancing audit \u2014 assignment management for the queue. When Mike says 'rebalance:' (also accept 'triage:' as an alias): read the AI Task Queue for outstanding work \u2014 Status Inbox, Routed, or Working (anything not Done). For each, check the assigned AI's quota vs reset from the Usage Log and strengths from the roster. Move tasks off exhausted or overloaded AIs to ones with headroom and matching strengths; respect the Assigned by chain \u2014 do not pull a task another agent deliberately handed off without flagging it. Treat a 100% usage row with outstanding tasks as a rescue trigger: those tasks are 'waiting on quota' \u2014 offer to move them. Report each move in one line: what moved, from whom, to whom, why. Confirm 'Nothing to move.' if the queue is already balanced.",
 "automatic": "Style standard for every saved or loaded fleet report, so output looks the same no matter which AI runs it: compact and chat-native; tables over prose; no intro paragraphs; phone-readable; values in the units the spec names. Every saved report spec (see save-report) must include a format contract: the exact columns in order, units, sort order, and one verbatim example of the expected output \u2014 imitate the example instead of inventing a layout.",
 "results-for-me": "Retrieve completed AI Task Queue answers. 'results for me' (bare 'results:' or 'full:' work the same): your own loop \u2014 tasks you assigned plus tasks assigned to you, most recent Done first; one-line Result each, tappable for the full answer from the task page. 'results for <AI>': that AI's completed tasks newest-first, capped at 20, each tappable for the full answer. 'results: <words>': keyword-search task titles for older items; the Notion database itself is the full archive. Agents only pull their own assigned work by default; naming another AI's completed tasks is allowed when needed for your own assigned work.",
 "save": "When Mike says 'save: <name>', store the current report spec in Fleet Reports (data source ) so any fleet AI can run it. 1) If he includes a spec ('save: <name>: <spec>'), use that text. Otherwise use the report just specified in this chat. 2) Find the row whose Name matches <name> (case-insensitive). Update it, or create it if missing. Name=<name>, Spec=the runnable spec (holdings, layout, rules, do-nots), Updated=today YYYY-MM-DD, Saved by=[AI]. Do not clear Last result unless this save includes a fresh run. 3) Confirm in one line: Saved <name>.",
 "health-check": "[NEEDS SYNC from registry \u2014 query throttled on 2026-10-08]",
 "onboarding": "[NEEDS SYNC from registry \u2014 query throttled on 2026-10-08]",
 "update-fleet": "When the user says 'update fleet: <change>' (changing how the fleet works): 1) Work out which pages the change touches: the Fleet Onboarding pages (the shared core on all six pages, or one AI's role section), Fleet Skills rows, the Fleet Skills \u2014 How It Works page, the public AI setup page (artifact slug fleetly-ai-setup) if the one-time setup text changes, and the AI Fleet \u2014 Help page if triggers change. 2) Classify it: quirks and formatting go straight in; any shared-core rule change needs the user's OK first \u2014 show the exact before/after and wait. 3) Fetch each page fresh and make targeted edits (never from a remembered copy); keep the shared core identical on every onboarding page. 4) Bump each touched page's version (minor bump) and date; for a Fleet Skills row, bump Version and set Updated to today (YYYY-MM-DD). If the one-time setup text changed, update the local setup page (~/workspace/fleetly-site/setup/index.html) with the new text and re-deploy it to setup.fleetlybots.com via the Cloudflare dashboard direct-upload flow, so the public page stays current. 5) Log one row in Fleet Changes: Date, Type, Scope, Pages affected, New version, Requested by, Approval. 6) Confirm in two or three short bullets: what changed, new versions, logged. Batch edits instead of re-reading between them; if a Notion usage limit blocks a step, say which part was skipped and do not retry in a loop.",
 "support": "When the user says 'support:' (needing help with Fleetly): 1) Try to solve it from the skill instructions and KB first. 2) If you cannot solve it, or the user says your answer did not help, offer: 'Want me to open a support ticket with the Fleetly team?' 3) Only on their yes: POST to https://api.fleetlybots.com/api/tickets with JSON body {key: <the user's Fleetly license key>, problem: <their problem in their own words>}. 4) Confirm in one line: 'Ticket filed (number from the response) \u2014 the Fleetly team will reply by email.' Never file a ticket without the user's explicit yes.",
};

const LICENSE_MSG = "This Fleetly install needs a valid license key. Your key goes in the 'Fleetly license key' field on your Fleetly home page in Notion. No key yet? Get Fleetly at https://fleetlybots.com";

// ---- Support tickets: buyer files a ticket, row lands in the
// administrator's Notion "Support Tickets" database ----
const TICKETS_DB = "488a9ed1-a9a3-48df-bd4f-7101d9786690";

async function handleTicket(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: "bad_json" }, 400); }
  const key = (body.key || "").trim();
  const problem = (body.problem || "").trim();
  if (!key || !problem) return json({ ok: false, error: "key_and_problem_required" }, 400);
  if (problem.length > 2000) return json({ ok: false, error: "problem_too_long" }, 400);

  // Validate the license key (any active or honeymoon-expired key may file).
  let lic = null;
  if (env.LICENSES) {
    try { lic = await env.LICENSES.get("license:" + key, "json"); } catch (e) { lic = null; }
  }
  if (!lic) return json({ ok: false, error: "license", message: LICENSE_MSG }, 403);

  const today = new Date().toISOString().split("T")[0];
  const title = problem.length > 60 ? problem.slice(0, 57) + "..." : problem;

  // Sequential ticket number (FLT-0001, FLT-0002, ...), prefixed to the title.
  let ticketNo = "";
  if (env.LICENSES) {
    const n = parseInt(await env.LICENSES.get("ticket-counter") || "0", 10) + 1;
    await env.LICENSES.put("ticket-counter", String(n));
    ticketNo = "FLT-" + String(n).padStart(4, "0");
  }
  const fullTitle = ticketNo ? ticketNo + " — " + title : title;

  // Write the ticket into the administrator's Notion database.
  if (!env.NOTION_TOKEN) return json({ ok: false, error: "tickets_unavailable" }, 503);
  try {
    const r = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + env.NOTION_TOKEN,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        parent: { type: "data_source_id", data_source_id: TICKETS_DB },
        properties: {
          "Ticket": { title: [{ text: { content: fullTitle } }] },
          "Status": { select: { name: "Inbox" } },
          "Buyer": { rich_text: [{ text: { content: (lic.email || "") + (lic.name ? " (" + lic.name + ")" : "") } }] },
          "License key": { rich_text: [{ text: { content: key } }] },
          "Problem": { rich_text: [{ text: { content: problem } }] },
          "Date opened": { date: { start: today } },
        },
      }),
    });
    if (!r.ok) return json({ ok: false, error: "notion_write_failed" }, 502);
  } catch (e) {
    return json({ ok: false, error: "notion_write_failed" }, 502);
  }

  // Notify the administrator by email.
  if (env.RESEND_API_KEY) {
    try {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + env.RESEND_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: "Fleetly <hello@fleetlybots.com>",
          to: ["fleetlybots@gmail.com"],
          subject: "New Fleetly support ticket" + (ticketNo ? " (" + ticketNo + ")" : ""),
          html: "<p><strong>Buyer:</strong> " + (lic.email || key) + "</p>"
            + "<p><strong>Problem:</strong></p><p>" + problem.replace(/</g, "&lt;") + "</p>",
        }),
      });
    } catch (e) { /* ticket is filed; the email is a courtesy */ }
  }

  return json({ ok: true, filed: true, ticket: ticketNo });
}

// ---- Ticket resolution email: notify the buyer when their ticket is closed ----
async function handleTicketNotify(request, env) {
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: "bad_json" }, 400); }
  const ticketNo = (body.ticket || "").trim().toUpperCase();
  if (!ticketNo) return json({ ok: false, error: "ticket_required" }, 400);
  if (!env.NOTION_TOKEN || !env.RESEND_API_KEY) return json({ ok: false, error: "not_configured" }, 503);

  // Find the ticket in Notion by number.
  let page = null;
  try {
    const q = await fetch("https://api.notion.com/v1/databases/a9b6f458-a3e5-4664-8780-c85d3cc6a237/query", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + env.NOTION_TOKEN,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: { property: "Ticket", title: { contains: ticketNo } },
        page_size: 1,
      }),
    });
    if (!q.ok) return json({ ok: false, error: "notion_query_failed" }, 502);
    const qj = await q.json();
    page = (qj.results && qj.results[0]) || null;
  } catch (e) { return json({ ok: false, error: "notion_query_failed" }, 502); }
  if (!page) return json({ ok: false, error: "ticket_not_found" }, 404);

  const props = page.properties || {};
  const rich = (p) => (props[p] && props[p].rich_text || []).map(x => x.plain_text).join("");
  const title = (props.Ticket && props.Ticket.title || []).map(x => x.plain_text).join("");
  const buyerField = rich("Buyer");
  const buyerEmail = (buyerField.match(/[^\s()]+@[^\s()]+/) || [""])[0];
  const resolution = rich("Resolution");
  const customMessage = (body.message || "").trim().slice(0, 2000);
  if (!buyerEmail) return json({ ok: false, error: "missing_email" }, 400);
  if (!resolution && !customMessage) return json({ ok: false, error: "missing_resolution_or_message" }, 400);

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + env.RESEND_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Fleetly <hello@fleetlybots.com>",
        to: [buyerEmail],
        subject: customMessage ? "Update on your Fleetly support ticket " + ticketNo : "Your Fleetly support ticket " + ticketNo + " is resolved",
        html: customMessage
          ? "<p>An update on your support ticket <strong>" + ticketNo + "</strong> (" + title.replace(/</g, "&lt;") + "):</p>"
            + "<p>" + customMessage.replace(/</g, "&lt;").replace(/\n/g, "<br>") + "</p>"
            + "<p>— The Fleetly team</p>"
          : "<p>Good news — your support ticket <strong>" + ticketNo + "</strong> (" + title.replace(/</g, "&lt;") + ") is resolved.</p>"
            + "<p><strong>Resolution:</strong></p><p>" + resolution.replace(/</g, "&lt;").replace(/\n/g, "<br>") + "</p>"
            + "<p>If this doesn't solve it, just reply to this email.</p>"
            + "<p>— The Fleetly team</p>",
      }),
    });
    if (!r.ok) return json({ ok: false, error: "email_failed" }, 502);
  } catch (e) { return json({ ok: false, error: "email_failed" }, 502); }

  // Log the message on the ticket page as administrator-feedback history.
  try {
    const now = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
    const logText = customMessage
      ? "[" + now + "] Administrator update sent: " + customMessage
      : "[" + now + "] Resolution email sent: " + resolution;
    await fetch("https://api.notion.com/v1/blocks/" + page.id + "/children", {
      method: "PATCH",
      headers: {
        "Authorization": "Bearer " + env.NOTION_TOKEN,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        children: [{ object: "block", type: "paragraph",
          paragraph: { rich_text: [{ type: "text", text: { content: logText.slice(0, 2000) } }] } }],
      }),
    });
  } catch (e) { /* history is a courtesy */ }

  return json({ ok: true, notified: buyerEmail, ticket: ticketNo });
}

// ---- Stripe webhook: automatic license issuance ----
function makeLicenseKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no confusing chars
  let s = "";
  for (const b of bytes) s += alphabet[b % alphabet.length];
  return "FL-" + s.slice(0, 5) + "-" + s.slice(5);
}

async function verifyStripeSig(rawBody, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const parts = {};
  for (const p of sigHeader.split(",")) {
    const i = p.indexOf("=");
    if (i > 0) parts[p.slice(0, i).trim()] = p.slice(i + 1).trim();
  }
  if (!parts.t || !parts.v1) return false;
  // Reject events older than 5 minutes (replay protection)
  if (Math.abs(Date.now() / 1000 - parseInt(parts.t, 10)) > 300) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign(
    "HMAC", key, new TextEncoder().encode(parts.t + "." + rawBody));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, "0")).join("");
  return timedEqual(hex, parts.v1);
}
function timedEqual(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function sendKeyEmail(env, email, key, plan, isNew) {
  if (!env.RESEND_API_KEY || !email) return { sent: false, reason: "no_api_key_or_email" };
  const isMembershipRenewal = plan === "membership" && !isNew;
  const productLine = plan === "membership"
    ? "Fleetly membership — ongoing updates ($6/month)"
    : "Fleetly custom Notion template ($49, includes 6 months of updates)";
  const html = isMembershipRenewal ? `
    <p>Your Fleetly membership is active — your license now stays current as long as you're subscribed. No new key needed; keep using <strong>${key}</strong>.</p>
    <p>— The Fleetly team</p>` : `
    <p>Your Fleetly license key is ready:</p>
    <p style="font-size:20px;font-weight:bold;letter-spacing:2px;">${key}</p>
    <p><strong>What you bought:</strong> ${productLine}</p>
    <p><strong>Setup (3 steps):</strong></p>
    <ol>
      <li>Duplicate the Fleetly template into your Notion (link below).</li>
      <li>Paste your key into the "Fleetly license key" field on your Fleetly home page.</li>
      <li>Tell your AI assistant to fetch its instructions — it will use your key automatically.</li>
    </ol>
    <p>Template: https://fleetlybots.com/setup</p>
    <p>Questions? Reply to this email.</p>
    <p>— The Fleetly team</p>`;
  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + env.RESEND_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Fleetly <hello@fleetlybots.com>",
        to: [email],
        subject: isMembershipRenewal ? "Your Fleetly membership is active" : "Your Fleetly license key",
        html: html,
      }),
    });
    if (!r.ok) return { sent: false, reason: "resend_" + r.status };
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: "fetch_error" };
  }
}

async function handleStripeWebhook(request, env) {
  const sig = request.headers.get("stripe-signature");
  const rawBody = await request.text();
  if (!await verifyStripeSig(rawBody, sig, env.STRIPE_WEBHOOK_SECRET)) {
    return json({ ok: false, error: "bad_signature" }, 400);
  }
  let event;
  try { event = JSON.parse(rawBody); } catch (e) { return json({ ok: false }, 400); }

  // Idempotency: Stripe retries deliveries; never issue twice for one event.
  if (env.LICENSES) {
    const seen = await env.LICENSES.get("stripe-event:" + event.id);
    if (seen) return json({ ok: true, deduped: true });
  }

  const type = event.type;
  const obj = event.data && event.data.object ? event.data.object : {};

  if (type === "checkout.session.completed") {
    const email = (obj.customer_details && obj.customer_details.email) || obj.customer_email || "";
    const name = (obj.customer_details && obj.customer_details.name) || "";
    const mode = obj.mode; // "payment" ($49 template) or "subscription" ($6/mo)
    const today = new Date().toISOString().split("T")[0];
    // One key per buyer: look up any existing license by email first.
    let key = "";
    let record = null;
    let isNew = false;
    if (env.LICENSES && email) {
      key = await env.LICENSES.get("license-email:" + email.toLowerCase());
      if (key) record = await env.LICENSES.get("license:" + key, "json");
    }
    if (!record) {
      key = makeLicenseKey();
      record = { email: email, name: name, status: "active", created: today,
        purchased: today, stripe_customer: obj.customer || "" };
      isNew = true;
    }
    record.email = email || record.email;
    if (name) record.name = name;
    if (obj.customer) record.stripe_customer = obj.customer;
    record.status = "active";
    if (mode === "subscription") {
      // Membership: unlocks all skills while subscribed.
      record.plan = "membership";
    } else {
      // Template: new skills free for 6 months from purchase; core skills forever.
      record.plan = "template";
      record.purchased = today;
    }
    record.stripe_session = obj.id;
    if (env.LICENSES) {
      await env.LICENSES.put("license:" + key, JSON.stringify(record));
      await env.LICENSES.put("stripe-event:" + event.id, "1", { expirationTtl: 86400 * 30 });
      if (email) await env.LICENSES.put("license-email:" + email.toLowerCase(), key);
      if (record.stripe_customer) await env.LICENSES.put("license-customer:" + record.stripe_customer, key);
    }
    // Deliver the key by email (automatic). Key issuance above already
    // succeeded, so a mail failure never blocks the license itself.
    const mail = await sendKeyEmail(env, email, key, record.plan, isNew);
    if (env.LICENSES && !mail.sent) {
      await env.LICENSES.put("license-email-pending:" + key,
        JSON.stringify({ email: email, reason: mail.reason }));
    }
    return json({ ok: true, issued: true, email_sent: mail.sent });
  }

  if (type === "customer.subscription.deleted") {
    // $6/mo cancelled: find the license by customer and deactivate it.
    const customer = obj.customer || "";
    let key = "";
    let email = "";
    if (env.LICENSES && customer) {
      key = await env.LICENSES.get("license-customer:" + customer);
      if (key) {
        const rec = await env.LICENSES.get("license:" + key, "json");
        if (rec) {
          email = rec.email || "";
          // Back to the template plan: core skills keep working, new skills
          // gate on the original 6-month window from purchase.
          rec.plan = "template";
          rec.status = "active";
          await env.LICENSES.put("license:" + key, JSON.stringify(rec));
        }
      }
    }
    if (env.LICENSES) await env.LICENSES.put("stripe-event:" + event.id, "1", { expirationTtl: 86400 * 30 });
    // Confirm the cancellation by email so the buyer isn't left wondering.
    if (email && env.RESEND_API_KEY) {
      try {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + env.RESEND_API_KEY,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: "Fleetly <hello@fleetlybots.com>",
            to: [email],
            subject: "Your Fleetly membership is cancelled",
            html: `<p>Your Fleetly membership is cancelled — you won't be charged again.</p>`
              + (key ? `<p>Your license key <strong>${key}</strong> has been deactivated.</p>` : "")
              + `<p>Thanks for trying Fleetly. If you ever want back in, you know where to find us.</p>`
              + `<p>— The Fleetly team</p>`,
          }),
        });
      } catch (e) { /* cancellation stands even if the email fails */ }
    }
    return json({ ok: true });
  }

  return json({ ok: true, ignored: type });
}

function json(data, status) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return json(null, 204);
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (path === "/api/health" || path === "/") {
      return json({ ok: true, service: "fleetly-api" });
    }

    if (path === "/api/tickets") {
      if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);
      return handleTicket(request, env);
    }

    if (path === "/api/tickets/notify") {
      if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);
      return handleTicketNotify(request, env);
    }

    if (path === "/api/stripe-webhook") {
      if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);
      return handleStripeWebhook(request, env);
    }

    const m = path.match(/^\/api\/skills\/([a-z0-9-]+)$/);
    if (m) {
      const key = (url.searchParams.get("key") || "").trim();
      let lic = null;
      if (key && env.LICENSES) {
        try { lic = await env.LICENSES.get("license:" + key, "json"); } catch (e) { lic = null; }
      }
      if (!lic || lic.status !== "active") {
        return json({ ok: false, error: "license", message: LICENSE_MSG }, 403);
      }
      // New-skill gate: the template includes every skill added in the first
      // 6 months; skills added later need an active membership. Core skills
      // never stop working — no brick.
      const trigger = m[1];
      const added = SKILL_ADDED[trigger] || "2026-10-08";
      if (lic.plan !== "membership" && lic.status === "active") {
        const purchased = lic.purchased || lic.created || "2026-10-09";
        const cutoff = new Date(new Date(purchased).getTime() + 182 * 86400 * 1000)
          .toISOString().split("T")[0];
        if (added > cutoff) {
          return json({ ok: false, error: "membership_required",
            message: "This skill was added after your included update period. Add the Fleetly membership at https://fleetlybots.com/#pricing to unlock it." }, 403);
        }
      }
      const skill = SKILLS[trigger];
      if (!skill) return json({ ok: false, error: "not_found" }, 404);
      return json({ ok: true, trigger: trigger, instructions: skill });
    }

    return json({ ok: false, error: "not_found" }, 404);
  },
};
