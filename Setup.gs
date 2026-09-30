/**
 * Setup.gs — one-time setup, trigger install, and self-tests.
 *
 * ORDER OF OPERATIONS (also in the cutover checklist in the doc):
 *   1. Paste the .gs files into a new Apps Script project bound to NOTHING
 *      (a standalone script at script.google.com — it uses YOUR Gmail and
 *      calendar whichever Google account you run it under).
 *   2. Services (+) > enable "Gmail API" (Advanced service, for threaded drafts).
 *   3. Run setup() once — creates the "AutoMyMail Leads" spreadsheet
 *      (tabs: leads, processed) and stores its ID.
 *   4. Run storeApiKey() once — saves your Anthropic key in Script
 *      Properties (never in the code).
 *   5. Run the test functions below with synthetic emails — no real lead
 *      gets a reply until YOU approve cutover.
 *   6. Run installTriggers() — starts the free 10-minute check loop.
 */

function setup() {
  var props = PropertiesService.getScriptProperties();
  var existingId = props.getProperty("LEAD_SHEET_ID");
  if (existingId) {
    Logger.log("Sheet already set up: " + existingId);
    return;
  }
  var ss = SpreadsheetApp.create("AutoMyMail Leads");
  var leads = ss.getSheets()[0];
  leads.setName("leads");
  leads.appendRow(LEAD_COLUMNS);
  leads.setFrozenRows(1);
  var processed = ss.insertSheet("processed");
  processed.appendRow(["message_id", "processed_at"]);
  processed.setFrozenRows(1);
  props.setProperty("LEAD_SHEET_ID", ss.getId());
  Logger.log("Created spreadsheet: " + ss.getUrl());
  Logger.log("Open it any time to watch your leads — it's the bot's memory.");
}

/** Run once, paste your key when prompted. Stored in Script Properties. */
function storeApiKey() {
  var key = Browser.inputBox("Paste your Anthropic API key (sk-ant-...)");
  if (key && key !== "cancel") {
    PropertiesService.getScriptProperties().setProperty("ANTHROPIC_API_KEY", key.trim());
    Logger.log("API key stored in Script Properties.");
  }
}

/** Optional: override which address counts as "the agent" (defaults to you). */
function setAgentEmail(email) {
  PropertiesService.getScriptProperties().setProperty("AGENT_EMAIL", email.trim().toLowerCase());
  Logger.log("Agent email set to " + email);
}

function installTriggers() {
  uninstallTriggers();
  ScriptApp.newTrigger("runCheck").timeBased().everyMinutes(10).create();
  Logger.log("Installed: runCheck every 10 minutes. Free forever — no server.");
}

function uninstallTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === "runCheck") ScriptApp.deleteTrigger(t);
  });
}

/* ------------------------------------------------------------------ */
/* Self-tests — synthetic leads only. Nothing here emails a real lead. */
/* ------------------------------------------------------------------ */

/** Fake extraction result, so prompt/logic tests don't spend API calls. */
var SYNTH_NEW_LEAD = {
  intent: "new_lead", area: "Winter Park", budget: "$400k",
  timeline: "2-3 months", property_type: "house",
  availability: "weekday evenings after 6pm",
  property_reference: null, must_haves: "3+ bedrooms, no HOA",
  vague_listing_reference: false, ready_to_book: true,
  notes: "Relocating for a new job"
};

var SYNTH_EMAIL_1 =
  "Hi, I saw your listing and I'm interested. I'm looking for a 3 bedroom\n" +
  "house in Winter Park, budget around 400k. I'm hoping to move in the next\n" +
  "2-3 months. I'm usually free on weekday evenings after 6pm to see places.";

function testMergeLogic() {
  // Mirrors the prototype's pytest suite: merge rules, must_haves dedup,
  // listing_link_pending block, ready_to_book computation.
  var email = "test-phil-" + Date.now() + "@example.com";

  var p1 = upsertLead(email,
    { area: "Altamonte Springs", budget: "$300k", timeline: "2 months",
      property_type: "condo", availability: null, must_haves: "large backyard for the dog" },
    "first email");
  Logger.log("After email 1 — ready_to_book=" + p1.ready_to_book + " (expect false, availability missing)");

  var p2 = upsertLead(email,
    { area: null, budget: null, availability: "weekend afternoons",
      must_haves: "yard, no HOA" },
    "second email");
  Logger.log("After email 2 — area kept: " + p2.area + " (expect Altamonte Springs)");
  Logger.log("must_haves: " + p2.must_haves + " (expect 'large backyard for the dog, no HOA' — 'yard' deduped)");
  Logger.log("ready_to_book=" + p2.ready_to_book + " (expect true)");

  var v = upsertLead("test-vague-" + Date.now() + "@example.com",
    { vague_listing_reference: true, area: "Dr. Phillips" }, "saw your listing...");
  Logger.log("Vague listing — listing_link_pending=" + v.listing_link_pending + " (expect true), ready_to_book=" +
    v.ready_to_book + " (expect false, hard block)");

  var s = upsertLead("test-specific-" + Date.now() + "@example.com",
    { property_reference: "123 Lake Ave, Orlando, FL", availability: "Saturday morning" },
    "interested in 123 Lake Ave...");
  Logger.log("Specific listing + availability — ready_to_book=" + s.ready_to_book + " (expect true, no area/budget asked)");

  Logger.log("testMergeLogic done. Clean these test rows out of the sheet when finished.");
}

function testSlotSelection() {
  // Next Saturday 2pm and next Sunday 10am, plus a Wednesday 7pm.
  var now = new Date();
  var sat = new Date(now); sat.setDate(now.getDate() + ((6 - now.getDay() + 7) % 7 || 7)); sat.setHours(14, 0, 0, 0);
  var sun = new Date(sat); sun.setDate(sat.getDate() + 1); sun.setHours(10, 0, 0, 0);
  var wed = new Date(sat); wed.setDate(sat.getDate() - 3); wed.setHours(19, 0, 0, 0);
  var slots = [
    { start: wed, end: new Date(wed.getTime() + 3600000), title: "Available for showings" },
    { start: sat, end: new Date(sat.getTime() + 4 * 3600000), title: "Available for showings" },
    { start: sun, end: new Date(sun.getTime() + 2 * 3600000), title: "Available for showings" }
  ];
  var picked = selectBestSlots({ availability: "weekend afternoons" }, slots);
  Logger.log("Weekend-afternoon lead got:");
  picked.slots.forEach(function (sl) { Logger.log("  " + formatSlot(sl)); });
  Logger.log("usedFallback=" + picked.usedFallback + " (expect false)");

  var picked2 = selectBestSlots({ availability: "Tuesday mornings" }, slots);
  Logger.log("Tuesday-morning lead got " + picked2.slots.length + " slot(s), usedFallback=" +
    picked2.usedFallback + " (expect true — honest fallback to soonest)");
}

function testDraftReply() {
  // Uses REAL API calls (costs a few cents). Draft text is only logged,
  // never sent — safe to run.
  var profile = upsertLead("test-draft-" + Date.now() + "@example.com",
    SYNTH_NEW_LEAD, SYNTH_EMAIL_1);
  var reply = draftReply(profile, SYNTH_EMAIL_1);
  Logger.log("Drafted qualifying reply:\n" + reply);
  Logger.log("(Check: acknowledges what they said, asks at most 1-2 questions, no re-asking.)");
}

function testProposeTimes() {
  // Uses REAL API calls. Logs the email only — never sent, never booked.
  var now = new Date();
  var sat = new Date(now); sat.setDate(now.getDate() + ((6 - now.getDay() + 7) % 7 || 7)); sat.setHours(13, 0, 0, 0);
  var email = "test-propose-" + Date.now() + "@example.com";
  var profile = upsertLead(email, {
    area: "Winter Park", budget: "$400k", timeline: "2-3 months",
    property_type: "house", availability: "weekend afternoons",
    intent: "new_lead", vague_listing_reference: false, ready_to_book: true
  }, SYNTH_EMAIL_1);
  var slots = [{ start: sat, end: new Date(sat.getTime() + 4 * 3600000), title: "Available for showings" }];
  var text = proposeTimes(profile, slots);
  Logger.log("Proposed-times email:\n" + text);
  Logger.log("(Check: slot label copied EXACTLY — same weekday, date, and time as the log above.)");
}
