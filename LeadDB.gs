/**
 * LeadDB.gs — the bot's memory. One row per lead, keyed by their email
 * address, in the "leads" tab of the AutoMyMail spreadsheet.
 * Port of lead_db.py (SQLite) — same merge rules, same computed fields.
 *
 * Why a spreadsheet instead of a database file: the Python version needed
 * ALTER TABLE migrations whenever a column was added, and the DB file had
 * to live on Render's persistent disk. A sheet is schema-free (columns are
 * looked up by header name, so adding one never breaks old rows), survives
 * on its own, and you can open it and read your leads any time.
 */

var LEADS_TAB = "leads";
var LEAD_COLUMNS = [
  "email", "area", "budget", "timeline", "property_type", "availability",
  "property_reference", "must_haves", "ready_to_book", "confirming_notified",
  "times_proposed", "follow_up_sent", "listing_link_pending", "last_updated",
  "last_thread_id", "last_message_id", "last_subject", "notes",
  "conversation_history"
];

function getSheet_() {
  var id = PropertiesService.getScriptProperties().getProperty("LEAD_SHEET_ID");
  if (!id) throw new Error("LEAD_SHEET_ID is not set. Run setup() in Setup.gs first.");
  return SpreadsheetApp.openById(id);
}

function getLeadsTab_() {
  return getSheet_().getSheetByName(LEADS_TAB);
}

/** Header name -> 0-based column index, so column order never matters. */
function columnIndex_(tab) {
  var headers = tab.getRange(1, 1, 1, tab.getLastColumn()).getValues()[0];
  var map = {};
  headers.forEach(function (h, i) { map[String(h).trim()] = i; });
  return map;
}

function rowToProfile_(row, colIdx) {
  var v = function (name) { return row[colIdx[name]]; };
  var profile = {};
  LEAD_COLUMNS.forEach(function (name) { profile[name] = v(name); });
  ["ready_to_book", "confirming_notified", "times_proposed",
   "follow_up_sent", "listing_link_pending"].forEach(function (name) {
    profile[name] = (profile[name] === true || profile[name] === "TRUE" || profile[name] === 1);
  });
  try {
    profile.conversation_history = JSON.parse(profile.conversation_history || "[]");
  } catch (e) {
    profile.conversation_history = [];
  }
  return profile;
}

function emptyProfile_(email) {
  return {
    email: email, area: "", budget: "", timeline: "", property_type: "",
    availability: "", property_reference: "", must_haves: "",
    ready_to_book: false, confirming_notified: false, times_proposed: false,
    follow_up_sent: false, listing_link_pending: false, last_updated: "",
    last_thread_id: "", last_message_id: "", last_subject: "", notes: "",
    conversation_history: []
  };
}

/** Find the 1-based row number for this email, or -1. */
function findLeadRow_(tab, email) {
  var last = tab.getLastRow();
  if (last < 2) return -1;
  var emails = tab.getRange(2, 1, last - 1, 1).getValues();
  for (var i = 0; i < emails.length; i++) {
    if (String(emails[i][0]).trim().toLowerCase() === email) return i + 2;
  }
  return -1;
}

function getLead(email) {
  email = String(email).trim().toLowerCase();
  var tab = getLeadsTab_();
  var rowNum = findLeadRow_(tab, email);
  if (rowNum === -1) return emptyProfile_(email);
  var colIdx = columnIndex_(tab);
  var row = tab.getRange(rowNum, 1, 1, tab.getLastColumn()).getValues()[0];
  return rowToProfile_(row, colIdx);
}

function writeProfile_(tab, profile) {
  var colIdx = columnIndex_(tab);
  var rowNum = findLeadRow_(tab, profile.email);
  var row = LEAD_COLUMNS.map(function (name) {
    var val = profile[name];
    if (name === "conversation_history") return JSON.stringify(val || []);
    if (["ready_to_book", "confirming_notified", "times_proposed",
         "follow_up_sent", "listing_link_pending"].indexOf(name) !== -1) {
      return val ? "TRUE" : "FALSE";
    }
    return (val === null || val === undefined) ? "" : val;
  });
  if (rowNum === -1) {
    tab.appendRow(row);
  } else {
    tab.getRange(rowNum, 1, 1, row.length).setValues([row]);
  }
}

/**
 * Merges newly extracted info into the stored profile. Only overwrites a
 * field when the new extraction actually has a value — info from earlier
 * emails is never lost because a later email didn't repeat it.
 * (Port of lead_db.upsert_lead, same rules including the must_haves
 * per-item dedup and the listing_link_pending / ready_to_book computation.)
 */
function upsertLead(email, newInfo, latestEmailBody, threadId, messageIdHeader, subject) {
  email = String(email).trim().toLowerCase();
  newInfo = newInfo || {};
  var existing = getLead(email);

  var pick = function (key) {
    var nv = newInfo[key];
    return (nv !== null && nv !== undefined && nv !== "") ? nv : existing[key];
  };

  var merged = {
    area: pick("area"), budget: pick("budget"), timeline: pick("timeline"),
    property_type: pick("property_type"), availability: pick("availability"),
    property_reference: pick("property_reference"), notes: pick("notes")
  };

  // must_haves accumulates across emails. Dedup is per comma-separated
  // item: a whole-string substring check would let one matched item
  // silently swallow genuinely new items in the same merge.
  var newMH = newInfo.must_haves, existingMH = existing.must_haves;
  if (newMH && existingMH) {
    var existingItems = existingMH.split(",").map(function (s) { return s.trim(); }).filter(Boolean);
    var existingLower = existingItems.map(function (s) { return s.toLowerCase(); });
    var added = newMH.split(",").map(function (s) { return s.trim(); }).filter(function (item) {
      var low = item.toLowerCase();
      if (existingLower.indexOf(low) !== -1) return false;
      return !existingLower.some(function (ex) { return ex.indexOf(low) !== -1; });
    });
    merged.must_haves = added.length ? existingItems.concat(added).join(", ") : existingMH;
  } else {
    merged.must_haves = newMH || existingMH;
  }

  // listing_link_pending stays true until a real property_reference arrives.
  // It does NOT clear just because the lead didn't mention it again.
  var listingLinkPending;
  if (merged.property_reference) {
    listingLinkPending = false;
  } else if (newInfo.vague_listing_reference) {
    listingLinkPending = true;
  } else {
    listingLinkPending = existing.listing_link_pending;
  }

  // ready_to_book is computed, never extracted:
  // - pending listing link: hard block, never book without knowing the property
  // - specific listing known: only availability is needed (the listing
  //   already implies area/type/rough price)
  // - general search: area + budget + timeline + property_type + availability
  var readyToBook;
  if (listingLinkPending) {
    readyToBook = false;
  } else if (merged.property_reference) {
    readyToBook = !!merged.availability;
  } else {
    readyToBook = !!(merged.area && merged.budget && merged.timeline &&
                     merged.property_type && merged.availability);
  }

  var history = existing.conversation_history || [];
  history.push(latestEmailBody);

  var profile = {
    email: email,
    area: merged.area, budget: merged.budget, timeline: merged.timeline,
    property_type: merged.property_type, availability: merged.availability,
    property_reference: merged.property_reference, must_haves: merged.must_haves,
    ready_to_book: readyToBook,
    confirming_notified: existing.confirming_notified,
    times_proposed: existing.times_proposed,
    follow_up_sent: false, // every upsert resets this, same as the Python version
    listing_link_pending: listingLinkPending,
    last_updated: new Date().toISOString(),
    last_thread_id: threadId || existing.last_thread_id,
    last_message_id: messageIdHeader || existing.last_message_id,
    last_subject: subject || existing.last_subject,
    notes: merged.notes,
    conversation_history: history
  };

  writeProfile_(getLeadsTab_(), profile);
  return profile;
}

function markConfirmingNotified(email) {
  var p = getLead(email); p.confirming_notified = true; writeProfile_(getLeadsTab_(), p);
}

function markTimesProposed(email) {
  var p = getLead(email); p.times_proposed = true; writeProfile_(getLeadsTab_(), p);
}

function markFollowUpSent(email) {
  var p = getLead(email); p.follow_up_sent = true; writeProfile_(getLeadsTab_(), p);
}

/**
 * Leads that are ready, were already sent proposed times, never confirmed,
 * and haven't heard from us in `days` days. (Port of get_stale_ready_leads)
 */
function getStaleReadyLeads(days) {
  days = days || 2;
  var cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  var tab = getLeadsTab_();
  var last = tab.getLastRow();
  if (last < 2) return [];
  var colIdx = columnIndex_(tab);
  var rows = tab.getRange(2, 1, last - 1, tab.getLastColumn()).getValues();
  var stale = [];
  rows.forEach(function (row) {
    var p = rowToProfile_(row, colIdx);
    var updated = p.last_updated ? new Date(p.last_updated) : null;
    if (p.ready_to_book && p.times_proposed && !p.confirming_notified &&
        !p.follow_up_sent && updated && updated < cutoff) {
      stale.push(p);
    }
  });
  return stale;
}
