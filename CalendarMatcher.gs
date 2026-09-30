/**
 * CalendarMatcher.gs — reads the agent's real calendar, finds blocks the
 * agent marked "available" (e.g. an event titled "Available for showings"),
 * and drafts a reply with actual proposed times.
 * Port of calendar_matcher.py.
 *
 * Two deliberate safety rules carried over from the prototype:
 * 1. Slot SELECTION is plain code, never the AI — the AI is only ever given
 *    pre-formatted labels and told to copy them verbatim.
 * 2. Day-of-week/date labels are computed in code, never left for the AI.
 */

var PROPOSE_SYSTEM_PROMPT =
  "You are drafting an email reply on behalf of a real estate agent.\n" +
  "\n" +
  "The lead is ready to schedule a showing. You will be given a FIXED list of\n" +
  "2-3 exact time slots that have already been selected in code - your ONLY\n" +
  "job is to write a short, warm email presenting these exact options.\n" +
  "\n" +
  VOICE_GUIDE + "\n" +
  "\n" +
  "CRITICAL RULES:\n" +
  "- Copy the given date/time labels EXACTLY as provided, character for character.\n" +
  "  Do not recalculate, rephrase, reformat, invent, or add any slot not in the\n" +
  "  given list.\n" +
  "- Do not mention any date or time that is not explicitly given to you.\n" +
  "- If told these are \"fallback\" slots (didn't match the lead's stated\n" +
  "  preference), briefly and honestly acknowledge that these are the soonest\n" +
  "  options available even though they may not perfectly match what they asked for.\n" +
  "- If given an empty list, do not invent times - instead say you're finalizing\n" +
  "  the calendar and will follow up shortly.\n" +
  "- Ask them to reply with which one works, or suggest another time if none do.\n" +
  "- Sign off with \"Talk soon,\" on its own line, no name.\n" +
  "- Return ONLY the email body text. No subject line, no explanation, no markdown.\n";

var ACK_SYSTEM_PROMPT =
  "You are drafting a very short email reply on behalf of a real\n" +
  "estate agent. Showing times were already proposed to this lead earlier, and they've\n" +
  "now replied (confirming a time, asking a small follow-up, etc).\n" +
  "\n" +
  VOICE_GUIDE + "\n" +
  "\n" +
  "CRITICAL RULES:\n" +
  "- Output ONLY the final email body text. Nothing else - no reasoning, no\n" +
  "  meta-commentary, no explanation of what you're about to do or why. Do not\n" +
  "  narrate your own thought process.\n" +
  "- Keep it to 1-3 sentences. This is a quick acknowledgment, not a full re-explanation.\n" +
  "- Do not repeat the full list of time slots again - they already picked one.\n" +
  "- Do not invent or state any new facts (dates, addresses, prices) not already\n" +
  "  given to you in the lead's profile.\n" +
  "- Sign off with \"Talk soon,\" on its own line, no name.\n";

/**
 * Returns events titled with "available" in the next `daysAhead` days.
 * The agent marks showing windows by creating normal calendar events with
 * "available" in the title.
 */
function getAvailableSlots(daysAhead) {
  daysAhead = daysAhead || 14;
  var now = new Date();
  var max = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
  var events = CalendarApp.getDefaultCalendar().getEvents(now, max);
  return events
    .filter(function (e) { return e.getTitle().toLowerCase().indexOf("available") !== -1; })
    .map(function (e) { return { start: e.getStartTime(), end: e.getEndTime(), title: e.getTitle() }; });
}

var DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
var MONTH_NAMES = ["January", "February", "March", "April", "May", "June",
                   "July", "August", "September", "October", "November", "December"];

function formatTime_(d) {
  var h = d.getHours(), m = d.getMinutes();
  var ampm = h >= 12 ? "PM" : "AM";
  h = h % 12; if (h === 0) h = 12;
  return h + ":" + (m < 10 ? "0" + m : m) + " " + ampm;
}

/**
 * Pre-formatted label with the CORRECT day of week computed in code, e.g.
 * "Saturday, August 15, 2026, 1:00 PM - 5:00 PM". Never left for the AI.
 */
function formatSlot(slot) {
  var s = slot.start, e = slot.end;
  return DAY_NAMES[s.getDay()] + ", " + MONTH_NAMES[s.getMonth()] + " " +
    s.getDate() + ", " + s.getFullYear() + ", " +
    formatTime_(s) + " - " + formatTime_(e);
}

/**
 * Picks the best slots in plain code — NOT the AI. Matches the lead's
 * stated preference (weekend/weekday/morning/afternoon/evening keywords);
 * falls back to soonest slots when nothing matches, flagged honestly.
 * Returns { slots: [...], usedFallback: bool }.
 */
function selectBestSlots(leadProfile, availableSlots, maxResults) {
  maxResults = maxResults || 3;
  var availabilityText = (leadProfile.availability || "").toLowerCase();

  var matchesPreference = function (start) {
    var weekday = start.getDay(); // 0=Sun ... 6=Sat
    var hour = start.getHours();
    var isWeekend = (weekday === 0 || weekday === 6);
    if (availabilityText.indexOf("weekend") !== -1 && !isWeekend) return false;
    if (availabilityText.indexOf("weekday") !== -1 && isWeekend) return false;
    if (availabilityText.indexOf("morning") !== -1 && !(hour >= 5 && hour < 12)) return false;
    if (availabilityText.indexOf("afternoon") !== -1 && !(hour >= 12 && hour < 17)) return false;
    if (availabilityText.indexOf("evening") !== -1 && !(hour >= 17 && hour < 22)) return false;
    return true;
  };

  var sorted = availableSlots.slice().sort(function (a, b) { return a.start - b.start; });
  var matching = sorted.filter(function (s) { return matchesPreference(s.start); });
  var chosen = matching.slice(0, maxResults);
  var usedFallback = false;
  if (chosen.length === 0 && sorted.length > 0) {
    chosen = sorted.slice(0, maxResults);
    usedFallback = true;
  }
  return { slots: chosen, usedFallback: usedFallback };
}

function proposeTimes(leadProfile, availableSlots) {
  var picked = selectBestSlots(leadProfile, availableSlots);
  var slotsText = picked.slots.length
    ? picked.slots.map(function (s) { return "- " + formatSlot(s); }).join("\n")
    : "(none available)";

  var userContent = "Lead profile:\n" + JSON.stringify(leadProfile) +
    "\n\nExact slots to present (fallback: " + picked.usedFallback + "):\n" + slotsText;

  var result = callClaude_(PROPOSE_SYSTEM_PROMPT, userContent, MODEL_SONNET, 400);
  if (result.stopReason === "max_tokens") {
    Logger.log("WARNING: proposed-times email was cut off by the max_tokens limit - draft may be incomplete.");
  }
  return result.text.trim();
}

function draftConfirmationAck(leadProfile, latestEmail) {
  var userContent = "Lead profile (already confirmed a showing time earlier):\n" +
    JSON.stringify(leadProfile) + "\n\nTheir latest message:\n" + latestEmail;
  var result = callClaude_(ACK_SYSTEM_PROMPT, userContent, MODEL_SONNET, 200);
  if (result.stopReason === "max_tokens") {
    Logger.log("WARNING: confirmation ack was cut off by the max_tokens limit - draft may be incomplete.");
  }
  return result.text.trim();
}
