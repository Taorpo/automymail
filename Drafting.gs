/**
 * Drafting.gs — everything the bot writes: qualifying replies, follow-up
 * nudges, the agent's confirmation summary, and the Gmail draft plumbing.
 * Ports reply_drafter.py, follow_up.py, agent_summary.py, create_draft.py.
 *
 * Nothing here sends email to a lead automatically. Replies are created as
 * Gmail DRAFTS for a human to review and send. The only real send is the
 * internal summary to the agent themself.
 *
 * NOTE: createDraftReply_ uses the Advanced Gmail service
 * (Gmail.Users.Drafts.create) so the draft threads correctly with
 * In-Reply-To / References headers. Enable it once via
 * Services (+) > Gmail API > Add.
 */

var REPLY_SYSTEM_PROMPT =
  "You are drafting an email reply on behalf of a real estate agent,\n" +
  "responding to a lead who is interested in buying or renting.\n" +
  "\n" +
  "You will be given:\n" +
  "1. The lead's structured profile (what we know so far: area, budget, timeline,\n" +
  "   property_type, availability, ready_to_book)\n" +
  "2. The original email text they sent\n" +
  "\n" +
  VOICE_GUIDE + "\n" +
  "\n" +
  "Additional rules for this specific email:\n" +
  "\n" +
  "- If the lead's profile shows listing_link_pending is true: this is a HARD\n" +
  "  REQUIREMENT that overrides everything else. Do not discuss scheduling,\n" +
  "  availability, or ask any other qualifying questions - the ONLY thing to\n" +
  "  do is politely ask for the specific listing link or address again. Keep\n" +
  "  asking every time until they provide it, even if they've ignored the\n" +
  "  question in a previous email.\n" +
  "- If property_reference IS known (they gave a specific address/listing):\n" +
  "  the listing itself already tells us the area, type, and roughly the price.\n" +
  "  Do NOT ask for area, budget, or property type - that would look like you\n" +
  "  didn't read their email. The only thing actually needed before booking is\n" +
  "  their availability, so if that's missing, ask for that and nothing else.\n" +
  "- If ready_to_book is false AND no specific listing is known: acknowledge what they DID tell you, then ask ONLY for\n" +
  "  the specific missing fields (never re-ask something already known). Ask at most\n" +
  "  1-2 questions. Keep it to 3-4 sentences total.\n" +
  "- If ready_to_book is true: thank them for the details, briefly summarize what\n" +
  "  you understood (area/budget/timeline/type) in one sentence, and tell them\n" +
  "  you're checking calendar availability now and will follow up shortly with\n" +
  "  specific times. Keep it to 3-4 sentences total.\n" +
  "- Sign off simply, e.g. \"Talk soon,\" on its own line, no name (the agent will\n" +
  "  sign it themselves for now).\n" +
  "- Return ONLY the email body text. No subject line, no explanation, no markdown.\n";

function draftReply(leadProfile, originalEmail) {
  var userContent = "Lead profile so far:\n" + JSON.stringify(leadProfile) +
    "\n\nOriginal email from lead:\n" + originalEmail;
  var result = callClaude_(REPLY_SYSTEM_PROMPT, userContent, MODEL_SONNET, 300);
  if (result.stopReason === "max_tokens") {
    Logger.log("WARNING: reply was cut off by the max_tokens limit - draft may be incomplete.");
  }
  return result.text.trim();
}

var FOLLOW_UP_SYSTEM_PROMPT =
  "You are drafting a brief check-in email on behalf of\n" +
  "a real estate agent, to a lead who was sent proposed showing times a couple days\n" +
  "ago and hasn't responded since.\n" +
  "\n" +
  VOICE_GUIDE + "\n" +
  "\n" +
  "CRITICAL RULES:\n" +
  "- Do NOT repeat the specific old time slots - the calendar may have changed\n" +
  "  since then, so those exact times might not even be valid anymore.\n" +
  "- Just ask if they're still interested and what day/time generally works now,\n" +
  "  so the agent can check current availability and follow up with fresh options.\n" +
  "- Keep it short - 2-3 sentences. This is a light nudge, not a full re-pitch.\n" +
  "- Don't be pushy or guilt-trippy about the lack of response.\n" +
  "- Sign off with \"Talk soon,\" on its own line, no name.\n" +
  "- Return ONLY the email body text. No subject line, no explanation, no markdown.\n";

function draftFollowUp(leadProfile) {
  var userContent = "Lead profile (went quiet after being sent proposed times):\n" +
    JSON.stringify(leadProfile);
  var result = callClaude_(FOLLOW_UP_SYSTEM_PROMPT, userContent, MODEL_SONNET, 200);
  if (result.stopReason === "max_tokens") {
    Logger.log("WARNING: follow-up was cut off by the max_tokens limit - draft may be incomplete.");
  }
  return result.text.trim();
}

/**
 * Creates a Gmail draft that replies inside the original thread.
 * (Port of create_draft.py — raw MIME so In-Reply-To/References thread it.)
 */
function createDraftReply_(toEmail, subject, bodyText, threadId, originalMessageId) {
  if (!/^re:/i.test(subject)) subject = "Re: " + subject;

  var lines = [
    "To: " + toEmail,
    "Subject: " + subject,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: 8bit"
  ];
  if (originalMessageId) {
    lines.push("In-Reply-To: " + originalMessageId);
    lines.push("References: " + originalMessageId);
  }
  lines.push("", bodyText);
  var raw = Utilities.base64EncodeWebSafe(lines.join("\r\n"), Utilities.Charset.UTF_8);

  var resource = { message: { raw: raw } };
  if (threadId) resource.message.threadId = threadId;
  return Gmail.Users.Drafts.create(resource, "me");
}

/** Plain, factual internal summary — no voice tuning, this is for the agent. */
function buildSummaryText_(profile, leadEmail, triggerReason) {
  var lines = [
    "Lead: " + leadEmail,
    "Status: " + triggerReason,
    ""
  ];
  if (profile.property_reference) {
    lines.push("LISTING: " + profile.property_reference);
    lines.push("(confirm this listing's current status manually - not auto-verified)");
    lines.push("");
  }
  if (profile.notes) {
    lines.push("Notes: " + profile.notes);
    lines.push("");
  }
  lines.push("Area: " + (profile.area || "not provided"));
  lines.push("Budget: " + (profile.budget || "not provided"));
  lines.push("Timeline: " + (profile.timeline || "not provided"));
  lines.push("Property type: " + (profile.property_type || "not provided"));
  lines.push("Stated availability: " + (profile.availability || "not provided"));
  if (profile.must_haves) lines.push("Must-haves / deal-breakers: " + profile.must_haves);
  return lines.join("\n");
}

/**
 * Sends (not drafts) one real email to the agent when a lead confirms a
 * showing time. Never sent to a lead. (Port of agent_summary.py)
 */
function sendAgentSummary(leadProfile, leadEmail, triggerReason) {
  var agentEmail = PropertiesService.getScriptProperties().getProperty("AGENT_EMAIL") ||
    Session.getActiveUser().getEmail();
  GmailApp.sendEmail(
    agentEmail,
    "[AutoMyMail] Showing confirmed: " + leadEmail,
    buildSummaryText_(leadProfile, leadEmail, triggerReason)
  );
}
