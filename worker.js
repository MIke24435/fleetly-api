// Fleetly License API — serves skill instructions to licensed installs.
// KV namespace "LICENSES" must be bound. Keys: "license:<KEY>" -> {"email","status","created"}
// Test-mode Stripe licenses live under "test:license:<KEY>" and never share
// email, customer, or payment indexes with live keys.

import {
  adminAuthorized,
  cancellationHtml,
  classifyRefund,
  isActiveLicense,
  licenseEnding,
  makeLicenseKey,
  nextPurchaseDate,
  ownsTemplateAfterCheckout,
  publicLicenseView,
  stripeId,
  timedEqual,
} from "./licensing.js";

import {
  MEMBERSHIP_REQUIRED_NOTE,
  UPDATES_FROM,
  UPDATE_BEGIN,
  diffForLicense,
  formatUpdateId,
  isMembershipGated,
  contentVersion,
  kbFromContentPage,
  makeUnsubToken,
  nextVersionMap,
  renderUpdateEmail,
  skillFromRegistryPage,
  validEmail,
} from "./updates.js";

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
 "health-check": "The coordinator's system health check. Runs when the user says 'health check:' and automatically on the weekly schedule set up during coordinator onboarding. Notion queries are metered: prefer reading through a saved view or search/fetch over metered SQL/row queries, and batch edits instead of re-reading between them. CHECK: 1) AI Task Queue \u2014 tasks stuck in Working or Routed for more than a day; blank or untitled rows; Done tasks missing a Result or Date Completed. 2) Fleet Onboarding pages \u2014 the shared core matches across every role's page; version markers are consistent; note any stale 'To confirm' items. 3) Fleet Skills \u2014 How It Works page \u2014 every active trigger appears in the help and skills tables; retired triggers appear only as retired. FIX SILENTLY (safe fixes only): close out clearly finished stuck tasks (one-line Result, Date Completed = today, Status = Done); clear blank rows if possible; add missing triggers to help; fix version mismatches. Never change shared-core rules \u2014 flag them instead. FLAG to the user: a stuck task with no finished page body, conflicts between pages, shared-core differences, stale 'To confirm' items, and anything else ambiguous. LOG: add one row to the Fleet Changes database \u2014 Type = Health Check, Requested by = Health Check, Date = today, Approval = Auto (safe fix) (or Needs approval if anything was flagged), and a short summary in Change and Details. REPLY (always, never silent): bold 'Health Check Completed', then short bullets \u2014 Checked: what was reviewed; Fixed: each fix with its Task #; Flagged: each item needing the user's decision. If nothing needed attention, say 'All clean'. If a Notion usage limit blocked any part, say which part was skipped and do not retry in a loop.",
 "onboarding": "When the user says 'onboard: <AI>' (adding a new AI to the fleet): 1) Create its row in the AI Fleet roster with strengths pre-seeded from current web reviews of that AI, plus its access paths, quota state, and cost notes (ask the user for anything you cannot verify). 2) Generate the one-time paste for its settings \u2014 one universal paste, identical for every AI, no per-AI customization: find the onboarding page in Notion (under the Fleetly page, the page with the AI's name on it) and follow it going forward (the AI resolves its own name; the user never types a page path); where the Fleet Skills database lives (Notion, under the Fleetly page), fetch the row matching the trigger phrase fresh each time, follow its Instructions exactly, substitute the AI's own name for [AI]. Keep it short. 3) Give the user the 3-command smoke test: 'my tasks:', 'my usage:', then one trial task end to end. 4) Have the new AI self-verify it can read and write the fleet databases (registry, Task Queue, Usage Log) \u2014 an AI without a working Notion connector cannot be a field agent.",
 "update-fleet": "When the user says 'update fleet: <change>' (changing how the fleet works): 1) Work out which pages the change touches: the Fleet Onboarding pages (the shared core on all six pages, or one AI's role section), Fleet Skills rows, the Fleet Skills \u2014 How It Works page, the public AI setup page (artifact slug fleetly-ai-setup) if the one-time setup text changes, and the AI Fleet \u2014 Help page if triggers change. 2) Classify it: quirks and formatting go straight in; any shared-core rule change needs the user's OK first \u2014 show the exact before/after and wait. 3) Fetch each page fresh and make targeted edits (never from a remembered copy); keep the shared core identical on every onboarding page. 4) Bump each touched page's version (minor bump) and date; for a Fleet Skills row, bump Version and set Updated to today (YYYY-MM-DD). If the one-time setup text changed, update the local setup page (~/workspace/fleetly-site/setup/index.html) with the new text and re-deploy it to setup.fleetlybots.com via the Cloudflare dashboard direct-upload flow, so the public page stays current. 5) Log one row in Fleet Changes: Date, Type, Scope, Pages affected, New version, Requested by, Approval. 6) Confirm in two or three short bullets: what changed, new versions, logged. Batch edits instead of re-reading between them; if a Notion usage limit blocks a step, say which part was skipped and do not retry in a loop.",
 "support": "When the user asks something that could be about Fleetly \u2014 billing, license key, setup, template, skills, membership, or anything in this workspace \u2014 search the Fleetly knowledge base first: GET https://api.fleetlybots.com/api/kb/search?key=<license-key>&q=<their question>. HOW TO DECIDE: if the question mentions Fleetly, or is about the things Fleetly manages (their subscription, key, template, AI fleet), it is a Fleetly question \u2014 search. If it is clearly about something else (their personal life, general knowledge, another product), answer normally without searching. When in doubt, search first: if the KB returns nothing relevant, fall back to your general knowledge and say so. If the KB answers it, answer from the article. If nothing in the KB helps, or the user says your answer did not help, offer: 'Want me to open a support ticket with the Fleetly team?' Only on their yes: POST to https://api.fleetlybots.com/api/tickets with JSON body {key: <the user's Fleetly license key>, problem: <their problem in their own words>}. Confirm in one line: 'Ticket filed (number from the response) \u2014 the Fleetly team will reply by email.' Never file a ticket without the user's explicit yes.",
 "clean": "When the user says 'clean:' (done playing with the sample data): 1) In each Fleetly database (Task Queue, AI Fleet, Work Log), find rows where the Sample checkbox is checked. 2) Delete those rows. 3) Confirm in one line: 'Sample data cleared \u2014 your databases are empty and ready.' Never delete rows that are not marked as samples. If there are no sample rows, say 'Already clean \u2014 nothing to remove.'",
};

const LICENSE_MSG = "This Fleetly install needs a valid license key. Paste your key in the Settings database \u2192 License key field in Notion. No key yet? Get Fleetly at https://fleetlybots.com";

function http(env) {
  return (env && typeof env.fetch === "function") ? env.fetch : fetch;
}

function nsPrefix(testMode) {
  return testMode ? "test:" : "";
}

function licenseStorageKey(key, testMode) {
  return nsPrefix(testMode) + "license:" + key;
}

function parseJson(raw, fallback) {
  if (raw == null || raw === "") return fallback;
  try { return JSON.parse(raw); } catch (e) { return fallback; }
}

async function loadLicense(env, key) {
  if (!env || !env.LICENSES || !key) return null;
  try {
    const live = await env.LICENSES.get("license:" + key, "json");
    if (live) return { record: live, test: false, storageKey: "license:" + key };
    const testRec = await env.LICENSES.get("test:license:" + key, "json");
    if (testRec) return { record: testRec, test: true, storageKey: "test:license:" + key };
  } catch (e) { return null; }
  return null;
}

// One gate for every buyer endpoint: the record must exist and be active.
// Revoked, refunded, disputed, and deactivated keys all fail it.
async function requireActiveLicense(env, key) {
  const found = await loadLicense(env, key);
  if (!isActiveLicense(found && found.record)) {
    return { ok: false, response: json({ ok: false, error: "license", message: LICENSE_MSG }, 403) };
  }
  return { ok: true, record: found.record, test: found.test, storageKey: found.storageKey };
}

async function requireAdmin(request, env) {
  const provided = request.headers.get("x-admin-secret") || "";
  if (!await adminAuthorized(provided, env && env.ADMIN_SECRET)) {
    return json({ ok: false, error: "unauthorized" }, 401);
  }
  return null;
}

async function issueUniqueLicenseKey(env, testMode) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const key = makeLicenseKey();
    if (!env || !env.LICENSES) return key;
    const existing = await env.LICENSES.get(licenseStorageKey(key, testMode));
    if (!existing) return key;
  }
  return null;
}

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

  const gate = await requireActiveLicense(env, key);
  if (!gate.ok) return gate.response;
  const lic = gate.record;

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
    const r = await http(env)("https://api.notion.com/v1/pages", {
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
      await http(env)("https://api.resend.com/emails", {
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

// ---- Waitlist: form signup -> Beta Testers database ----
const BETA_TESTERS_DS = "31671ff6-96d4-4345-bd59-f9478b3d9233";
const BETA_TESTERS_PAGE = "d0a3c5dba2074278a021f94139b60cc8";
async function handleWaitlist(request, env) {
  if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);
  let b;
  try { b = await request.json(); } catch (e) { return json({ ok: false, error: "bad_json" }, 400); }
  const name = (b.name || "").trim();
  const email = (b.email || "").trim();
  if (!email) return json({ ok: false, error: "email_required" }, 400);
  if (!env.NOTION_TOKEN) return json({ ok: false, error: "not_configured" }, 500);

  // Dedupe: skip if this email already exists.
  try {
    const q = await fetch("https://api.notion.com/v1/databases/" + BETA_TESTERS_PAGE + "/query", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + env.NOTION_TOKEN,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: { property: "Email", email: { equals: email } },
        page_size: 1,
      }),
    });
    const jq = await q.json();
    if (jq.results && jq.results.length > 0)
      return json({ ok: true, duplicate: true });
  } catch (e) {}

  const props = {
    "Name": { title: [{ text: { content: name || email } }] },
    "Email": { email: email },
    "Status": { select: { name: "Spotted" } },
    "Source": { select: { name: "Waitlist form" } },
    "Date found": { date: { start: new Date().toISOString().split("T")[0] } },
  };
  if (b.notes) props["Notes"] = { rich_text: [{ text: { content: String(b.notes).slice(0, 1000) } }] };
  if (b.x_handle) props["X handle"] = { rich_text: [{ text: { content: String(b.x_handle).slice(0, 100) } }] };

  const r = await fetch("https://api.notion.com/v1/pages", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + env.NOTION_TOKEN,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent: { type: "data_source_id", data_source_id: BETA_TESTERS_DS },
      properties: props,
    }),
  });
  if (!r.ok) {
    const errText = await r.text().catch(() => "");
    return json({ ok: false, error: "notion_write_failed", detail: errText.slice(0, 200) }, 500);
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
          subject: "New waitlist signup: " + (name || email),
          html: "<p><strong>" + (name || "(no name)") + "</strong> just joined the waitlist.</p><p>Email: " + email + "</p>" + (b.x_handle ? "<p>X: " + b.x_handle + "</p>" : ""),
        }),
      });
    } catch (e) {}
  }
  return json({ ok: true, added: true });
}

// ---- KB search: query published knowledge base articles ----
const CONTENT_DB = "00942471-34fa-49fe-af64-ea9356313b7f";
const CONTENT_PAGE = "9ac7f508a8144300b7a967946fd7b41f";
async function syncKBFromNotion(env) {
  if (!env.NOTION_TOKEN || !env.LICENSES) return { ok: false, error: "not_configured" };
  // No server-side Status filter: the operator KB uses Status = Published,
  // and the template Knowledge Base uses a Draft checkbox. Both are applied
  // per row so a Draft-only database still syncs.
  const fetched = await queryAllDatabase(env, CONTENT_PAGE);
  if (!fetched.ok) return fetched;
  const prevCatalog = parseJson(await env.LICENSES.get("kb-catalog"), []);
  let synced = 0;
  const index = [];
  const seen = [];
  for (const page of fetched.pages) {
    const article = kbFromContentPage(page);
    if (article.skip) continue;
    const stored = {
      id: article.id, title: article.title, type: article.type,
      body: article.body, keywords: article.keywords, version: article.version,
    };
    await env.LICENSES.put("kb:" + article.id, JSON.stringify(stored));
    index.push({
      id: article.id,
      title: article.title,
      keywords: article.keywords + " " + article.title.toLowerCase(),
    });
    if (!seen.includes(article.id)) seen.push(article.id);
    synced++;
  }
  const deprecated = prevCatalog.filter(id => !seen.includes(id));
  await env.LICENSES.put("kb:index", JSON.stringify(index));
  await env.LICENSES.put("kb-catalog", JSON.stringify(seen));
  await env.LICENSES.put("kb-deprecated", JSON.stringify(deprecated));
  await env.LICENSES.put("kb-sync:last", new Date().toISOString());
  return { ok: true, synced: synced, deprecated: deprecated.length };
}

async function handleKBSearch(request, env) {
  const url = new URL(request.url);
  const key = (url.searchParams.get("key") || "").trim();
  const query = (url.searchParams.get("q") || "").replace(/\+/g, " ").trim().toLowerCase();
  if (!query) return json({ ok: false, error: "query_required" }, 400);
  const gate = await requireActiveLicense(env, key);
  if (!gate.ok) return gate.response;

  let index = [];
  try {
    const idxRaw = await env.LICENSES.get("kb:index");
    if (idxRaw) index = JSON.parse(idxRaw);
  } catch (e) {}
  const STOPWORDS = new Set(["what","when","where","which","who","whom","whose","how","why","is","are","was","were","be","been","being","do","does","did","doing","a","an","the","and","or","but","of","at","by","for","with","about","into","through","during","before","after","above","below","to","from","up","down","in","out","on","off","over","under","again","further","then","once","here","there","all","any","both","each","few","more","most","other","some","such","no","nor","not","only","own","same","so","than","too","very","can","will","just","should","now","it","its","this","that","these","those","i","me","my","we","you","your","he","she","they","them","his","her","their"]);
  const terms = query.split(/\s+/).filter(w => w.length > 2 && !STOPWORDS.has(w));
  if (terms.length === 0) {
    const empty = { ok: true, query: query, results: [] };
    if (gate.test) empty.test = true;
    return json(empty);
  }
  const scored = [];
  for (const entry of index) {
    let score = 0;
    let hits = 0;
    for (const term of terms) {
      if (entry.keywords.includes(term)) { score += 2; hits++; }
      if (entry.title.toLowerCase().includes(term)) { score += 3; hits++; }
    }
    if (hits >= 2 || score >= 5) scored.push({ entry: entry, score: score });
  }
  scored.sort((a, b) => b.score - a.score);
  const results = [];
  for (const s of scored.slice(0, 3)) {
    try {
      const raw = await env.LICENSES.get("kb:" + s.entry.id);
      if (raw) {
        const a = JSON.parse(raw);
        results.push({ title: a.title, type: a.type, body: a.body.slice(0, 800) });
      }
    } catch (e) {}
  }
  const payload = { ok: true, query: query, results: results };
  if (gate.test) payload.test = true;
  return json(payload);
}

async function handleKBSync(request, env) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  return json(await syncKBFromNotion(env));
}

// ---- Skill sync: pull from the administrator's Notion registry into KV ----
// The hourly sync has always queried REGISTRY_QUERY_DB. REGISTRY_DB_MISMATCH
// was declared beside it and never passed to Notion. They are not the same
// database. The query stays on the id production already uses.
const REGISTRY_QUERY_DB = "4de82984-9fc8-4ee5-b269-4d5d22398504";
const REGISTRY_DB_MISMATCH = "4d266c58-4d6d-447f-a72b-0a29d80b3a27";

async function queryAllDatabase(env, databaseId) {
  const pages = [];
  let cursor = null;
  const doFetch = http(env);
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const r = await doFetch("https://api.notion.com/v1/databases/" + databaseId + "/query", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + env.NOTION_TOKEN,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { ok: false, error: "notion_query_failed", status: r.status };
    const j = await r.json();
    for (const page of (j.results || [])) pages.push(page);
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return { ok: true, pages: pages };
}

async function syncSkillsFromRegistry(env) {
  if (!env.NOTION_TOKEN || !env.LICENSES) return { ok: false, error: "not_configured" };
  const fetched = await queryAllDatabase(env, REGISTRY_QUERY_DB);
  if (!fetched.ok) return fetched;
  const prevIndex = parseJson(await env.LICENSES.get("skill-index"), []);
  const seen = [];
  let synced = 0;
  for (const page of fetched.pages) {
    const row = skillFromRegistryPage(page.properties || {});
    if (row.skip) continue;
    const prev = await env.LICENSES.get("skill:" + row.slug);
    const prevVer = await env.LICENSES.get("skill-version:" + row.slug);
    if (prev && prev !== row.text) {
      const stamp = new Date().toISOString().split("T")[0];
      await env.LICENSES.put(
        "skill-history:" + row.slug + ":" + stamp + ":" + (prevVer || "unversioned"),
        prev);
    }
    await env.LICENSES.put("skill:" + row.slug, row.text);
    if (row.explicitVersion) await env.LICENSES.put("skill-version:" + row.slug, row.explicitVersion);
    if (row.updated) await env.LICENSES.put("skill-updated:" + row.slug, row.updated);
    // Empty string when the registry row has no Added date. The gate treats
    // that as new. Missing key (never synced) is the same fail-safe.
    await env.LICENSES.put("skill-added:" + row.slug, row.added || "");
    await env.LICENSES.put("skill-record:" + row.slug, JSON.stringify({
      slug: row.slug,
      match: row.match,
      version: row.version,
      added: row.added || "",
      text: row.text,
      deprecated: false,
    }));
    if (!seen.includes(row.slug)) seen.push(row.slug);
    synced++;
  }
  const deprecated = prevIndex.filter(slug => !seen.includes(slug));
  for (const slug of deprecated) {
    const rec = parseJson(await env.LICENSES.get("skill-record:" + slug), null);
    if (!rec) continue;
    rec.deprecated = true;
    await env.LICENSES.put("skill-record:" + slug, JSON.stringify(rec));
  }
  await env.LICENSES.put("skill-index", JSON.stringify(seen));
  await env.LICENSES.put("skill-deprecated", JSON.stringify(deprecated));
  await env.LICENSES.put("skill-sync:last", new Date().toISOString());
  return { ok: true, synced: synced, deprecated: deprecated.length };
}

async function handleSkillSync(request, env) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  return json(await syncSkillsFromRegistry(env));
}

// ---- Stripe webhook: automatic license issuance ----
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

async function sendKeyEmail(env, email, key, plan, isNew, testMode) {
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
    const r = await http(env)("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + env.RESEND_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Fleetly <hello@fleetlybots.com>",
        to: [email],
        subject: (testMode ? "[TEST] " : "") + (isMembershipRenewal ? "Your Fleetly membership is active" : "Your Fleetly license key"),
        html: html,
      }),
    });
    if (!r.ok) return { sent: false, reason: "resend_" + r.status };
    return { sent: true };
  } catch (e) {
    return { sent: false, reason: "fetch_error" };
  }
}

async function claimStripeEvent(env, eventId, testMode) {
  if (!env.LICENSES || !eventId) return { duplicate: false };
  const name = nsPrefix(testMode) + "stripe-event:" + eventId;
  const seen = await env.LICENSES.get(name);
  if (seen) return { duplicate: true };
  // Claim before any license write or email so a fast retry cannot send twice.
  await env.LICENSES.put(name, "processing", { expirationTtl: 86400 * 30 });
  return { duplicate: false };
}

async function finishStripeEvent(env, eventId, testMode) {
  if (!env.LICENSES || !eventId) return;
  const name = nsPrefix(testMode) + "stripe-event:" + eventId;
  await env.LICENSES.put(name, "done", { expirationTtl: 86400 * 30 });
}

async function loadByCustomer(env, customer, testMode) {
  if (!env.LICENSES || !customer) return null;
  const key = await env.LICENSES.get(nsPrefix(testMode) + "license-customer:" + customer);
  if (!key) return null;
  const storageKey = licenseStorageKey(key, testMode);
  const record = await env.LICENSES.get(storageKey, "json");
  if (!record) return null;
  return { key: key, record: record, storageKey: storageKey, test: !!testMode };
}

async function sendMembershipEmail(env, email, key, testMode, subject, html) {
  if (!email || !env.RESEND_API_KEY || !html) return { sent: false };
  try {
    const r = await http(env)("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + env.RESEND_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: "Fleetly <hello@fleetlybots.com>",
        to: [email],
        subject: (testMode ? "[TEST] " : "") + subject,
        html: html,
      }),
    });
    return { sent: !!r.ok };
  } catch (e) {
    return { sent: false };
  }
}

async function handleCheckoutCompleted(obj, env, testMode) {
  const email = ((obj.customer_details && obj.customer_details.email) || obj.customer_email || "").trim();
  const name = (obj.customer_details && obj.customer_details.name) || "";
  const mode = obj.mode === "subscription" ? "subscription" : "payment";
  const today = new Date().toISOString().split("T")[0];
  const prefix = nsPrefix(testMode);
  let key = "";
  let record = null;
  let isNew = false;
  if (env.LICENSES && email) {
    key = await env.LICENSES.get(prefix + "license-email:" + email.toLowerCase());
    if (key) record = await env.LICENSES.get(licenseStorageKey(key, testMode), "json");
  }
  if (!record) {
    key = await issueUniqueLicenseKey(env, testMode);
    if (!key) return json({ ok: false, error: "key_collision" }, 500);
    record = {
      email: email,
      name: name,
      status: "active",
      created: today,
      purchased: today,
      stripe_customer: stripeId(obj.customer),
      test: !!testMode,
    };
    isNew = true;
  }
  record.email = email || record.email;
  if (name) record.name = name;
  if (obj.customer) record.stripe_customer = stripeId(obj.customer);
  record.test = !!testMode;
  record.purchased = nextPurchaseDate(record, mode, today, isNew);
  record.owns_template = ownsTemplateAfterCheckout(record, mode);
  record.status = "active";
  record.plan = mode === "subscription" ? "membership" : "template";
  record.stripe_session = obj.id || "";
  const paymentIntent = stripeId(obj.payment_intent);
  const subscriptionId = stripeId(obj.subscription);
  if (paymentIntent) record.stripe_payment_intent = paymentIntent;
  if (subscriptionId) record.stripe_subscription = subscriptionId;
  if (env.LICENSES) {
    await env.LICENSES.put(licenseStorageKey(key, testMode), JSON.stringify(record));
    if (email) await env.LICENSES.put(prefix + "license-email:" + email.toLowerCase(), key);
    if (record.stripe_customer) {
      await env.LICENSES.put(prefix + "license-customer:" + record.stripe_customer, key);
    }
    const mapping = JSON.stringify({
      key: key,
      product: mode === "subscription" ? "membership" : "template",
    });
    if (obj.id) await env.LICENSES.put(prefix + "stripe-checkout:" + obj.id, mapping);
    if (paymentIntent) await env.LICENSES.put(prefix + "stripe-payment:" + paymentIntent, mapping);
    if (subscriptionId) await env.LICENSES.put(prefix + "stripe-subscription:" + subscriptionId, mapping);
  }
  const mail = await sendKeyEmail(env, email, key, record.plan, isNew, testMode);
  if (env.LICENSES && !mail.sent) {
    await env.LICENSES.put(prefix + "license-email-pending:" + key,
      JSON.stringify({ email: email, reason: mail.reason }));
  }
  return json({ ok: true, issued: true, email_sent: mail.sent, test: !!testMode });
}

async function resolveRefundTarget(obj, env, testMode) {
  const prefix = nsPrefix(testMode);
  const paymentIntent = stripeId(obj.payment_intent);
  let mapping = null;
  if (env.LICENSES && paymentIntent) {
    mapping = parseJson(await env.LICENSES.get(prefix + "stripe-payment:" + paymentIntent), null);
  }
  let key = mapping && mapping.key ? mapping.key : "";
  if (!key && env.LICENSES && obj.customer) {
    key = await env.LICENSES.get(prefix + "license-customer:" + stripeId(obj.customer)) || "";
  }
  return { key: key, mapping: mapping };
}

async function handleChargeRefunded(obj, env, testMode) {
  const target = await resolveRefundTarget(obj, env, testMode);
  if (!target.key || !env.LICENSES) return json({ ok: true, revoked: false, reason: "no_mapping" });
  const storageKey = licenseStorageKey(target.key, testMode);
  const record = await env.LICENSES.get(storageKey, "json");
  if (!record) return json({ ok: true, revoked: false, reason: "no_license" });
  const decision = classifyRefund(obj, target.mapping);
  if (decision.action === "revoke") {
    record.status = "revoked";
    record.revoked_at = new Date().toISOString().split("T")[0];
    record.revoke_reason = "full refund of template purchase";
    await env.LICENSES.put(storageKey, JSON.stringify(record));
    return json({ ok: true, revoked: true, test: !!testMode });
  }
  if (decision.action === "drop_membership") {
    record.plan = "template";
    if (record.status !== "revoked" && record.status !== "disputed") record.status = "active";
    await env.LICENSES.put(storageKey, JSON.stringify(record));
    return json({ ok: true, membership_dropped: true, test: !!testMode });
  }
  return json({ ok: true, ignored: decision.reason || "refund" });
}

async function handleDisputeCreated(obj, env, testMode) {
  const prefix = nsPrefix(testMode);
  let key = "";
  const paymentIntent = stripeId(obj.payment_intent);
  if (env.LICENSES && paymentIntent) {
    const mapping = parseJson(await env.LICENSES.get(prefix + "stripe-payment:" + paymentIntent), null);
    if (mapping && mapping.key) key = mapping.key;
  }
  if (!key && env.LICENSES && obj.customer) {
    key = await env.LICENSES.get(prefix + "license-customer:" + stripeId(obj.customer)) || "";
  }
  if (!key && env.LICENSES) {
    const email = (obj.billing_details && obj.billing_details.email || "").toLowerCase();
    if (email) key = await env.LICENSES.get(prefix + "license-email:" + email) || "";
  }
  if (key && env.LICENSES) {
    const storageKey = licenseStorageKey(key, testMode);
    const record = await env.LICENSES.get(storageKey, "json");
    if (record) {
      record.status = "disputed";
      await env.LICENSES.put(storageKey, JSON.stringify(record));
      return json({ ok: true, revoked: true, test: !!testMode });
    }
  }
  return json({ ok: true, revoked: false });
}

async function handleSubscriptionUpdated(obj, env, testMode) {
  const loaded = await loadByCustomer(env, stripeId(obj.customer), testMode);
  if (obj.cancel_at_period_end && obj.status === "active") {
    const periodEnd = obj.cancel_at
      ? new Date(obj.cancel_at * 1000).toISOString().split("T")[0] : "";
    if (loaded && loaded.record.email) {
      const html = cancellationHtml(loaded.key, [
        "Your Fleetly membership is cancelled — you won't be charged again.",
        periodEnd ? "It stays active through <strong>" + periodEnd + "</strong>." : "",
        "The key keeps working after that: the template and core skills stay, and any refinements to them. Only brand-new skills released after the included period need an active membership.",
        "Thanks for trying Fleetly. If you ever want back in, you know where to find us.",
      ].filter(Boolean));
      await sendMembershipEmail(env, loaded.record.email, loaded.key, testMode,
        "Your Fleetly membership is cancelled", html);
    }
    return json({ ok: true, cancel_scheduled: true });
  }
  if (loaded && (obj.status === "past_due" || obj.status === "unpaid")) {
    // Same plan change as cancellation, including buyers who only ever
    // bought the membership. Whether that honeymoon is right is an owner
    // pricing decision.
    if (loaded.record.plan !== "template") {
      loaded.record.plan = "template";
      loaded.record.status = "active";
      await env.LICENSES.put(loaded.storageKey, JSON.stringify(loaded.record));
      if (loaded.record.email) {
        const html = cancellationHtml(loaded.key, [
          "Your Fleetly membership isn't active while the payment is " + String(obj.status).replace(/_/g, " ") + ".",
          "The template and the skills from your purchase keep working. A membership is only needed for brand-new skills released after the included period.",
        ]);
        await sendMembershipEmail(env, loaded.record.email, loaded.key, testMode,
          "Your Fleetly membership payment needs attention", html);
      }
    }
    return json({ ok: true, membership_dropped: true, status: obj.status });
  }
  if (loaded && (obj.status === "active" || obj.status === "trialing") && loaded.record.plan !== "membership") {
    loaded.record.plan = "membership";
    loaded.record.status = "active";
    await env.LICENSES.put(loaded.storageKey, JSON.stringify(loaded.record));
    return json({ ok: true, membership_restored: true });
  }
  return json({ ok: true, ignored: "subscription.updated" });
}

async function handleSubscriptionDeleted(obj, env, testMode) {
  const loaded = await loadByCustomer(env, stripeId(obj.customer), testMode);
  if (loaded) {
    loaded.record.plan = "template";
    loaded.record.status = "active";
    await env.LICENSES.put(loaded.storageKey, JSON.stringify(loaded.record));
    if (loaded.record.email) {
      const html = cancellationHtml(loaded.key, [
        "Your Fleetly membership is cancelled — you won't be charged again.",
        "The key still works: the template and core skills keep working, and any refinements to them. Only brand-new skills released after the included period need an active membership.",
        "Thanks for trying Fleetly. If you ever want back in, you know where to find us.",
      ]);
      await sendMembershipEmail(env, loaded.record.email, loaded.key, testMode,
        "Your Fleetly membership is cancelled", html);
    }
  }
  return json({ ok: true });
}

async function dispatchStripeEvent(event, env, testMode) {
  const type = event.type;
  const obj = event.data && event.data.object ? event.data.object : {};
  if (type === "checkout.session.completed") return handleCheckoutCompleted(obj, env, testMode);
  if (type === "charge.refunded") return handleChargeRefunded(obj, env, testMode);
  if (type === "charge.dispute.created") return handleDisputeCreated(obj, env, testMode);
  if (type === "customer.subscription.updated") return handleSubscriptionUpdated(obj, env, testMode);
  if (type === "customer.subscription.deleted") return handleSubscriptionDeleted(obj, env, testMode);
  return json({ ok: true, ignored: type });
}

async function handleStripeWebhook(request, env) {
  const sig = request.headers.get("stripe-signature");
  const rawBody = await request.text();
  let event;
  try { event = JSON.parse(rawBody); } catch (e) { return json({ ok: false, error: "bad_json" }, 400); }
  const testMode = event.livemode === false;
  const secret = testMode ? env.STRIPE_WEBHOOK_SECRET_TEST : env.STRIPE_WEBHOOK_SECRET;
  if (testMode && !secret) return json({ ok: false, error: "test_mode_not_configured" }, 400);
  if (!await verifyStripeSig(rawBody, sig, secret)) {
    return json({ ok: false, error: "bad_signature" }, 400);
  }
  if (!event.id) return json({ ok: false, error: "missing_event_id" }, 400);
  const claim = await claimStripeEvent(env, event.id, testMode);
  if (claim.duplicate) return json({ ok: true, deduped: true });
  try {
    return await dispatchStripeEvent(event, env, testMode);
  } finally {
    await finishStripeEvent(env, event.id, testMode);
  }
}

async function handleCreateKey(request, env) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  if (!env.LICENSES) return json({ ok: false, error: "not_configured" }, 503);
  let body = {};
  try { body = await request.json(); } catch (e) { body = {}; }
  const testMode = body.test === true;
  const email = String(body.email || "manual@fleetlybots.com").trim();
  const plan = body.plan === "membership" ? "membership" : "template";
  const key = await issueUniqueLicenseKey(env, testMode);
  if (!key) return json({ ok: false, error: "key_collision" }, 500);
  const today = new Date().toISOString().split("T")[0];
  const rec = {
    email: email,
    name: body.name ? String(body.name).slice(0, 200) : "",
    status: "active",
    plan: plan,
    purchased: today,
    created: new Date().toISOString(),
    note: body.note ? String(body.note).slice(0, 500) : "manual",
    owns_template: plan === "template",
    test: testMode,
  };
  await env.LICENSES.put(licenseStorageKey(key, testMode), JSON.stringify(rec));
  if (email) {
    await env.LICENSES.put(nsPrefix(testMode) + "license-email:" + email.toLowerCase(), key);
  }
  return json({ ok: true, key: key, test: testMode });
}

async function handleLookup(request, env) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  let body = {};
  try { body = await request.json(); } catch (e) { body = {}; }
  const key = String(body.key || "").trim();
  if (!key) return json({ ok: false, error: "key_required" }, 400);
  const found = await loadLicense(env, key);
  if (!found) return json({ ok: false, error: "not_found", license_ending: licenseEnding(key) }, 404);
  try {
    return json(publicLicenseView(found.record, key, found.test));
  } catch (e) {
    return json({ ok: false, error: "redaction_failed", license_ending: licenseEnding(key) }, 500);
  }
}

async function handleRevoke(request, env) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: "bad_json" }, 400); }
  const key = String(body.key || "").trim();
  const reason = String(body.reason || "").trim().slice(0, 500);
  if (!key) return json({ ok: false, error: "key_required" }, 400);
  const found = await loadLicense(env, key);
  if (!found) return json({ ok: false, error: "not_found", license_ending: licenseEnding(key) }, 404);
  if (!reason && found.record.status !== "revoked") {
    return json({ ok: false, error: "reason_required" }, 400);
  }
  const today = new Date().toISOString().split("T")[0];
  if (found.record.status !== "revoked") {
    found.record.status = "revoked";
    found.record.revoked_at = today;
    found.record.revoke_reason = reason;
    await env.LICENSES.put(found.storageKey, JSON.stringify(found.record));
  }
  const payload = {
    ok: true,
    license_ending: licenseEnding(key),
    status: "revoked",
    revoked_at: found.record.revoked_at || "",
    revoke_reason: found.record.revoke_reason || "",
    test: found.test,
  };
  if (key.length > 4 && JSON.stringify(payload).includes(key)) {
    return json({ ok: false, error: "redaction_failed" }, 500);
  }
  return json(payload);
}

async function handleRotate(request, env) {
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  if (!env.LICENSES) return json({ ok: false, error: "not_configured" }, 503);
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: "bad_json" }, 400); }
  const oldKey = String(body.key || "").trim();
  if (!oldKey) return json({ ok: false, error: "key_required" }, 400);
  const found = await loadLicense(env, oldKey);
  if (!found) return json({ ok: false, error: "not_found", license_ending: licenseEnding(oldKey) }, 404);
  if (found.record.status === "revoked") {
    return json({ ok: false, error: "revoked", license_ending: licenseEnding(oldKey) }, 409);
  }
  const testMode = found.test;
  const newKey = await issueUniqueLicenseKey(env, testMode);
  if (!newKey) return json({ ok: false, error: "key_collision" }, 500);
  const today = new Date().toISOString().split("T")[0];
  const fresh = {
    email: found.record.email || "",
    name: found.record.name || "",
    status: "active",
    plan: found.record.plan || "template",
    purchased: found.record.purchased || today,
    created: today,
    stripe_customer: found.record.stripe_customer || "",
    stripe_subscription: found.record.stripe_subscription || "",
    stripe_payment_intent: found.record.stripe_payment_intent || "",
    stripe_session: found.record.stripe_session || "",
    owns_template: found.record.owns_template === true,
    note: found.record.note || "",
    test: testMode,
    rotated_from_ending: licenseEnding(oldKey),
  };
  found.record.status = "deactivated";
  found.record.deactivated_at = today;
  found.record.deactivate_reason = "rotated";
  found.record.rotated_to_ending = licenseEnding(newKey);
  const prefix = nsPrefix(testMode);
  await env.LICENSES.put(licenseStorageKey(newKey, testMode), JSON.stringify(fresh));
  await env.LICENSES.put(found.storageKey, JSON.stringify(found.record));
  if (fresh.email) await env.LICENSES.put(prefix + "license-email:" + fresh.email.toLowerCase(), newKey);
  if (fresh.stripe_customer) await env.LICENSES.put(prefix + "license-customer:" + fresh.stripe_customer, newKey);
  const product = fresh.owns_template ? "template" : "membership";
  if (fresh.stripe_payment_intent) {
    await env.LICENSES.put(prefix + "stripe-payment:" + fresh.stripe_payment_intent,
      JSON.stringify({ key: newKey, product: product }));
  }
  if (fresh.stripe_session) {
    await env.LICENSES.put(prefix + "stripe-checkout:" + fresh.stripe_session,
      JSON.stringify({ key: newKey, product: product }));
  }
  if (fresh.stripe_subscription) {
    await env.LICENSES.put(prefix + "stripe-subscription:" + fresh.stripe_subscription,
      JSON.stringify({ key: newKey, product: "membership" }));
  }
  const mail = await sendKeyEmail(env, fresh.email, newKey, fresh.plan, true, testMode);
  return json({
    ok: true,
    key: newKey,
    license_ending: licenseEnding(newKey),
    previous_ending: licenseEnding(oldKey),
    email_sent: mail.sent,
    test: testMode,
  });
}

// ---- OTA skill/KB update emails ----
// Buyers register a Coordinator inbox. An admin run (dry-run by default)
// emails that inbox the rows that changed since the license's last send.
// The hourly sync does not send mail.

function updatesFrom(env) {
  return (env && env.UPDATES_FROM) || UPDATES_FROM;
}

function updatesBase(env) {
  return ((env && env.UPDATES_PUBLIC_BASE) || "https://api.fleetlybots.com").replace(/\/$/, "");
}

// Broadcast walks live licenses only. A test key is included when the
// admin names it, and loadLicense keeps that record in the test namespace.
async function listLicenseKeys(env) {
  const keys = [];
  let cursor;
  do {
    const page = await env.LICENSES.list({ prefix: "license:", cursor: cursor, limit: 1000 });
    for (const entry of (page.keys || [])) {
      const name = entry.name.startsWith("license:") ? entry.name.slice("license:".length) : "";
      if (name) keys.push(name);
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return keys;
}

async function loadUpdateCatalog(env) {
  const items = [];
  const skillIndex = parseJson(await env.LICENSES.get("skill-index"), []);
  const skillDeprecated = parseJson(await env.LICENSES.get("skill-deprecated"), []);
  for (const slug of skillIndex) {
    const rec = parseJson(await env.LICENSES.get("skill-record:" + slug), null);
    if (!rec || rec.deprecated) continue;
    items.push({
      storageKey: "skill:" + slug,
      type: "skill",
      match: rec.match,
      version: rec.version || contentVersion("", rec.text),
      added: rec.added || "",
      text: rec.text,
      deprecated: false,
    });
  }
  for (const slug of skillDeprecated) {
    if (skillIndex.includes(slug)) continue;
    const rec = parseJson(await env.LICENSES.get("skill-record:" + slug), null);
    if (!rec) continue;
    items.push({
      storageKey: "skill:" + slug,
      type: "skill",
      match: rec.match,
      version: rec.version || contentVersion("", rec.text),
      added: rec.added || "",
      text: rec.text,
      deprecated: true,
    });
  }
  const kbCatalog = parseJson(await env.LICENSES.get("kb-catalog"), []);
  const kbDeprecated = parseJson(await env.LICENSES.get("kb-deprecated"), []);
  for (const id of kbCatalog) {
    const article = parseJson(await env.LICENSES.get("kb:" + id), null);
    if (!article) continue;
    items.push({
      storageKey: "kb:" + id,
      type: "kb",
      match: article.title,
      version: article.version || contentVersion("", article.body),
      added: "",
      text: article.body,
      deprecated: false,
    });
  }
  for (const id of kbDeprecated) {
    if (kbCatalog.includes(id)) continue;
    const article = parseJson(await env.LICENSES.get("kb:" + id), null);
    if (!article) continue;
    items.push({
      storageKey: "kb:" + id,
      type: "kb",
      match: article.title,
      version: article.version || contentVersion("", article.body),
      added: "",
      text: article.body,
      deprecated: true,
    });
  }
  return items;
}

async function peekUpdateId(env, date) {
  const ymd = date.replace(/-/g, "");
  const n = parseInt(await env.LICENSES.get("updates-seq:" + ymd) || "0", 10) + 1;
  return formatUpdateId(date, n);
}

async function reserveUpdateId(env, date) {
  const ymd = date.replace(/-/g, "");
  const n = parseInt(await env.LICENSES.get("updates-seq:" + ymd) || "0", 10) + 1;
  await env.LICENSES.put("updates-seq:" + ymd, String(n));
  return formatUpdateId(date, n);
}

async function ensureUnsubToken(env, key, lic, testMode) {
  if (lic.updates_unsub_token) return lic.updates_unsub_token;
  const token = makeUnsubToken();
  lic.updates_unsub_token = token;
  const prefix = nsPrefix(!!testMode);
  await env.LICENSES.put(prefix + "license:" + key, JSON.stringify(lic));
  await env.LICENSES.put(prefix + "updates-unsub:" + token, key);
  return token;
}

async function sendUpdateEmail(env, to, rendered, unsubscribeUrl) {
  const doFetch = http(env);
  const payload = {
    from: updatesFrom(env),
    to: [to],
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html,
  };
  if (unsubscribeUrl) {
    payload.headers = { "List-Unsubscribe": "<" + unsubscribeUrl + ">" };
  }
  const r = await doFetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + env.RESEND_API_KEY,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return { sent: r.ok, status: r.status };
}

async function handleCoordinator(request, env) {
  if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);
  let body;
  try { body = await request.json(); } catch (e) { return json({ ok: false, error: "bad_json" }, 400); }
  const key = (body.key || "").trim();
  const email = (body.email || "").trim();
  if (!key || !email) return json({ ok: false, error: "key_and_email_required" }, 400);
  if (!validEmail(email)) return json({ ok: false, error: "bad_email" }, 400);
  if (!env.LICENSES) return json({ ok: false, error: "not_configured" }, 503);
  const gate = await requireActiveLicense(env, key);
  if (!gate.ok) return gate.response;
  const lic = gate.record;
  lic.coordinator_email = email;
  await ensureUnsubToken(env, key, lic, gate.test);
  await env.LICENSES.put(gate.storageKey, JSON.stringify(lic));
  const resp = { ok: true };
  if (gate.test) resp.test = true;
  return json(resp);
}

async function handleUnsubscribe(request, env) {
  if (request.method !== "GET" && request.method !== "POST") {
    return json({ ok: false, error: "method" }, 405);
  }
  const url = new URL(request.url);
  let token = (url.searchParams.get("token") || "").trim();
  if (!token && request.method === "POST") {
    try {
      const body = await request.json();
      token = (body.token || "").trim();
    } catch (e) { token = ""; }
  }
  if (!token) return json({ ok: false, error: "token_required" }, 400);
  if (!env.LICENSES) return json({ ok: false, error: "not_configured" }, 503);
  let key = await env.LICENSES.get("updates-unsub:" + token);
  let testMode = false;
  if (!key) {
    key = await env.LICENSES.get("test:updates-unsub:" + token);
    testMode = !!key;
  }
  if (!key) return json({ ok: false, error: "not_found" }, 404);
  const storageKey = licenseStorageKey(key, testMode);
  const lic = await env.LICENSES.get(storageKey, "json");
  if (!lic) return json({ ok: false, error: "not_found" }, 404);
  lic.updates_opt_out = true;
  await env.LICENSES.put(storageKey, JSON.stringify(lic));
  if (request.method === "GET") {
    return new Response(
      "<!doctype html><meta charset=\"utf-8\"><title>Fleetly updates</title>"
      + "<p>Fleetly update emails are turned off for this license. You can keep using Fleetly.</p>",
      { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
  }
  return json({ ok: true, updates_opt_out: true });
}

async function runUpdates(env, options) {
  const dryRun = options.dryRun !== false;
  const date = options.date || new Date().toISOString().slice(0, 10);
  const catalog = await loadUpdateCatalog(env);
  const keys = options.onlyKey ? [options.onlyKey] : await listLicenseKeys(env);
  const pending = [];
  const skipped = [];

  for (const key of keys) {
    const ending = licenseEnding(key);
    const found = await loadLicense(env, key);
    if (!isActiveLicense(found && found.record)) {
      skipped.push({ license_ending: ending, reason: "inactive" });
      continue;
    }
    const lic = found.record;
    if (lic.updates_opt_out) {
      skipped.push({ license_ending: ending, reason: "opt_out" });
      continue;
    }
    const to = (lic.coordinator_email || "").trim();
    if (!to) {
      skipped.push({ license_ending: ending, reason: "no_coordinator" });
      continue;
    }
    const sentKey = nsPrefix(found.test) + "updates-sent:" + key;
    const sent = parseJson(await env.LICENSES.get(sentKey), {});
    const items = diffForLicense(catalog, sent.versions || {}, lic);
    if (items.length === 0) {
      skipped.push({ license_ending: ending, reason: "no_changes" });
      continue;
    }
    pending.push({ key: key, lic: lic, to: to, sent: sent, items: items, test: found.test, sentKey: sentKey });
  }

  if (!dryRun && pending.length && !env.RESEND_API_KEY) {
    return { ok: false, error: "not_configured", dry_run: false, status: 503 };
  }

  let updateId = null;
  if (pending.length) {
    updateId = dryRun ? await peekUpdateId(env, date) : await reserveUpdateId(env, date);
  }

  const emails = [];
  for (const row of pending) {
    const ending = licenseEnding(row.key);
    let token = row.lic.updates_unsub_token || "";
    if (!token && !dryRun) token = await ensureUnsubToken(env, row.key, row.lic, row.test);
    const unsubscribeUrl = token
      ? updatesBase(env) + "/api/updates/unsubscribe?token=" + encodeURIComponent(token)
      : "";
    let rendered;
    try {
      rendered = renderUpdateEmail({
        updateId: updateId,
        date: date,
        licenseKey: row.key,
        plan: row.lic.plan,
        items: row.items,
        unsubscribeUrl: unsubscribeUrl,
      });
    } catch (e) {
      skipped.push({ license_ending: ending, reason: "render_blocked" });
      continue;
    }
    const preview = {
      to: row.to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      license_ending: rendered.license_ending,
      changes: row.items.length,
      membership_required: row.items.filter(item => item.membership_required).length,
    };
    if (dryRun) {
      preview.dry_run = true;
      emails.push(preview);
      continue;
    }
    let result;
    try {
      result = await sendUpdateEmail(env, row.to, rendered, unsubscribeUrl);
    } catch (e) {
      skipped.push({ license_ending: ending, reason: "send_failed" });
      continue;
    }
    if (!result.sent) {
      skipped.push({ license_ending: ending, reason: "send_failed", status: result.status });
      continue;
    }
    await env.LICENSES.put(row.sentKey, JSON.stringify({
      update_id: updateId,
      sent_at: new Date().toISOString(),
      versions: nextVersionMap(row.sent.versions || {}, row.items),
    }));
    preview.dry_run = false;
    preview.sent = true;
    emails.push(preview);
  }

  return {
    ok: true,
    dry_run: dryRun,
    update_id: updateId,
    date: date,
    sent: emails.filter(email => email.sent).length,
    emails: emails,
    skipped: skipped,
    catalog_empty: catalog.length === 0,
  };
}

async function handleSendUpdates(request, env) {
  if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);
  const denied = await requireAdmin(request, env);
  if (denied) return denied;
  if (!env.LICENSES) return json({ ok: false, error: "not_configured" }, 503);
  let body = {};
  if (request.headers.get("content-length") !== "0") {
    try { body = await request.json(); } catch (e) { body = {}; }
  }
  if (!body || typeof body !== "object") body = {};
  const date = /^\d{4}-\d{2}-\d{2}$/.test(body.date || "") ? body.date : "";
  const result = await runUpdates(env, {
    dryRun: body.dry_run !== false,
    date: date || undefined,
    onlyKey: (body.key || "").trim() || undefined,
  });
  const status = result.status || (result.ok ? 200 : 503);
  const payload = Object.assign({}, result);
  delete payload.status;
  return json(payload, status);
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

    if (path === "/api/waitlist") {
      return handleWaitlist(request, env);
    }

    if (path === "/api/kb/search") {
      return handleKBSearch(request, env);
    }

    if (path === "/api/admin/sync-kb") {
      if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);
      return handleKBSync(request, env);
    }

    if (path === "/api/admin/create-key") {
      if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);
      return handleCreateKey(request, env);
    }

    if (path === "/api/admin/lookup") {
      if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);
      return handleLookup(request, env);
    }

    if (path === "/api/admin/revoke") {
      if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);
      return handleRevoke(request, env);
    }

    if (path === "/api/admin/rotate-key") {
      if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);
      return handleRotate(request, env);
    }

    if (path === "/api/admin/sync-skills") {
      if (request.method !== "POST") return json({ ok: false, error: "method" }, 405);
      return handleSkillSync(request, env);
    }

    if (path === "/api/coordinator") {
      return handleCoordinator(request, env);
    }

    if (path === "/api/updates/unsubscribe") {
      return handleUnsubscribe(request, env);
    }

    if (path === "/api/admin/send-updates") {
      return handleSendUpdates(request, env);
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
      const gate = await requireActiveLicense(env, key);
      if (!gate.ok) return gate.response;
      const lic = gate.record;
      // New-skill gate: skills added after purchase + 182 days need an
      // active membership. The Added date comes from the operator registry.
      // A skill with no Added date is treated as new (gated), not old.
      const trigger = m[1];
      let added = "";
      if (env.LICENSES) {
        try { added = (await env.LICENSES.get("skill-added:" + trigger)) || ""; } catch (e) { added = ""; }
      }
      if (isMembershipGated({
        type: "skill",
        action: "add",
        added: added,
        plan: lic.plan,
        previouslyDelivered: false,
        purchased: lic.purchased,
        created: lic.created,
      })) {
        return json({ ok: false, error: "membership_required",
          message: "This skill was added after your included update period. Add the Fleetly membership at https://fleetlybots.com/#pricing to unlock it." }, 403);
      }
      // KV-synced skills take priority; hardcoded SKILLS is the fallback.
      let skill = null;
      if (env.LICENSES) {
        try { skill = await env.LICENSES.get("skill:" + trigger); } catch (e) {}
      }
      if (!skill) skill = SKILLS[trigger];
      if (!skill) return json({ ok: false, error: "not_found" }, 404);
      let version = null;
      if (env.LICENSES) {
        try { version = await env.LICENSES.get("skill-version:" + trigger); } catch (e) {}
      }
      const resp = { ok: true, trigger: trigger, instructions: skill };
      if (version) resp.version = version;
      if (gate.test) resp.test = true;
      return json(resp);
    }

    return json({ ok: false, error: "not_found" }, 404);
  },

  async scheduled(event, env, ctx) {
    // Hourly: pull fresh skills and KB articles. Update emails are not
    // sent from this job; an admin triggers those and dry-run is the default.
    ctx.waitUntil(syncSkillsFromRegistry(env));
    ctx.waitUntil(syncKBFromNotion(env));
  },
};

export { REGISTRY_QUERY_DB, REGISTRY_DB_MISMATCH, MEMBERSHIP_REQUIRED_NOTE, UPDATE_BEGIN };
