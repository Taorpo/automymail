/**
 * Code.gs — the orchestrator. Port of process_inbox.py + processed_tracker.py.
 *
 * runCheck() is what the time trigger calls. It does one inbox pass, then
 * one stale-lead pass, exactly like the Python run_loop did every 60s.
 *
 * Every safety rule from the prototype is preserved:
 * - Scans unread OR last-2-days mail (an agent opening a lead's email early
 *   must not make it vanish from the scan).
 * - Skips the agent's own address and anything with the [AutoMyMail]
 *   subject prefix (prevents replying to our own summary emails forever).
 * - "awaiting_confirmation": a short "Sounds good!" reply that arrives while
 *   proposed times are pending is treated as a confirmation, because the
 *   per-email classifier can't see that context.
 * - Every email is marked processed AND marked read whether it succeeded or
 *   raised — one bad email can never block the batch behind it.
 */

var PROCESSED_TAB = "processed";
var SYSTEM_PREFIX = "[AutoMyMail]";

function getProcessedIds_() {
  var tab = getSheet_().getSheetByName(PROCESSED_TAB);
  var last = tab.getLastRow();
  if (last < 2) return {};
  var ids = tab.getRange(2, 1, last - 1, 1).getValues();
  var set = {};
  ids.forEach(function (r) { if (r[0]) set[String(r[0])] = true; });
  return set;
}

function markAsProcessed_(messageId) {
  getSheet_().getSheetByName(PROCESSED_TAB).appendRow([String(messageId), new Date().toISOString()]);
}

function extractEmailAddress_(fromHeader) {
  var m = String(fromHeader).match(/<([^>]+)>/);
  return (m ? m[1] : String(fromHeader)).trim().toLowerCase();
}

/** Up to 20 candidate messages: unread OR from the last 2 days. */
function getRecentEmails_() {
  var threads = GmailApp.search("in:inbox (is:unread OR newer_than:2d)", 0, 20);
  var emails = [];
  threads.forEach(function (t) {
    t.getMessages().forEach(function (m) {
      if (emails.length >= 20) return;
      emails.push({
        id: m.getId(),
        threadId: t.getId(),
        message: m,
        sender: m.getFrom(),
        subject: m.getSubject() || "(no subject)",
        messageIdHeader: m.getHeader("Message-ID"),
        body: m.getPlainBody() || "(no plain text body found)"
      });
    });
  });
  return emails;
}

function finishEmail_(email, processedSet) {
  markAsProcessed_(email.id);
  processedSet[email.id] = true;
  try {
    email.message.markRead();
  } catch (e) {
    Logger.log("(Note: couldn't mark as read, non-critical: " + e.message + ")");
  }
}

function processNewEmails() {
  var agentEmail = (PropertiesService.getScriptProperties().getProperty("AGENT_EMAIL") ||
    Session.getActiveUser().getEmail()).toLowerCase();
  var processed = getProcessedIds_();
  var recentEmails = getRecentEmails_();
  var newCount = 0;

  recentEmails.forEach(function (email) {
    if (processed[email.id]) return; // already handled
    newCount++;
    Logger.log("NEW EMAIL from " + email.sender + " | " + email.subject);

    try {
      var leadEmail = extractEmailAddress_(email.sender);

      var isSelfSent = (leadEmail === agentEmail);
      var isSystemEmail = email.subject.indexOf(SYSTEM_PREFIX) === 0;
      if (isSelfSent || isSystemEmail) {
        Logger.log("(Skipping - this is our own system email, not a real lead)");
        finishEmail_(email, processed);
        return;
      }

      // State BEFORE extraction: were proposed times already sent and not
      // yet confirmed? The classifier only sees this one email, so a bare
      // "Sounds good, thanks!" looks like "closing" to it — the
      // orchestration layer catches the real meaning with this context.
      var previousProfile = getLead(leadEmail);
      var alreadyNotified = previousProfile.confirming_notified;
      var awaitingConfirmation = previousProfile.times_proposed && !alreadyNotified;

      var result = extractLeadInfo(email.body);
      Logger.log("Extracted: " + JSON.stringify(result));

      // Extraction failure == biggest doubt there is: treat like
      // "unrelated", never draft a reply off an empty profile.
      if (result === null) {
        Logger.log("(Skipping - could not get a reliable classification for this email)");
        finishEmail_(email, processed);
        return;
      }
      if (result.intent === "unrelated" ||
          (result.intent === "closing" && !awaitingConfirmation)) {
        Logger.log("(Skipping - not something that needs a reply drafted)");
        finishEmail_(email, processed);
        return;
      }

      // Merge into the lead's full stored profile (memory spans threads).
      var profile = upsertLead(leadEmail, result, email.body,
        email.threadId, email.messageIdHeader, email.subject);
      Logger.log("Full profile: " + JSON.stringify(profile));

      var replyText;
      if (profile.ready_to_book && !profile.times_proposed) {
        Logger.log("Lead is ready to book - checking real calendar availability...");
        var slots = getAvailableSlots(14);
        Logger.log("Found " + slots.length + " available slot(s) on calendar.");
        replyText = proposeTimes(profile, slots);
        markTimesProposed(leadEmail);
      } else if (profile.times_proposed) {
        Logger.log("Times already proposed earlier - short acknowledgment only...");
        replyText = draftConfirmationAck(profile, email.body);
      } else {
        Logger.log("Drafting reply using FULL profile (not just this one email)...");
        replyText = draftReply(profile, email.body);
      }

      var draft = createDraftReply_(leadEmail, email.subject, replyText,
        email.threadId, email.messageIdHeader);
      Logger.log("Draft created in Gmail (draft id: " + draft.getId() + ")");

      // Notify the agent (one real email, to the agent only) the first time
      // a lead confirms a showing time. A bare "closing"-style reply that
      // arrives while confirmation was pending counts as a confirmation.
      var intent = result.intent;
      var isConfirmation = (intent === "confirming_time") ||
        (intent === "closing" && awaitingConfirmation);
      if (isConfirmation && !alreadyNotified) {
        sendAgentSummary(profile, leadEmail,
          "Lead confirmed a showing time - full details below");
        markConfirmingNotified(leadEmail);
        Logger.log("Agent notified with complete lead summary.");
      }
    } catch (e) {
      // One bad email must never block the batch behind it.
      Logger.log("ERROR processing this email, skipping it: " + e.message + "\n" + e.stack);
    }

    // Marked processed on success OR failure — never re-crash on it.
    finishEmail_(email, processed);
  });

  if (newCount === 0) Logger.log("No new emails.");
  return newCount;
}

/**
 * Drafts a gentle check-in for leads sent proposed times 2+ days ago who
 * never confirmed. Port of check_stale_leads().
 */
function checkStaleLeads() {
  var staleLeads = getStaleReadyLeads(2);
  staleLeads.forEach(function (lead) {
    Logger.log("Stale lead detected: " + lead.email + " - drafting a check-in");
    var text = draftFollowUp(lead);
    if (lead.last_thread_id) {
      createDraftReply_(lead.email, lead.last_subject || "Following up",
        text, lead.last_thread_id, lead.last_message_id);
      Logger.log("Follow-up draft created for " + lead.email);
    }
    markFollowUpSent(lead.email);
  });
  return staleLeads.length;
}

/** The single entry point the time trigger calls. */
function runCheck() {
  try {
    processNewEmails();
  } catch (e) {
    Logger.log("Error during inbox pass: " + e.message);
  }
  try {
    checkStaleLeads();
  } catch (e) {
    Logger.log("Error during stale-lead pass: " + e.message);
  }
}
