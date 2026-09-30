/**
 * Extractor.gs — the first "brain" piece. Classifies the email and pulls out
 * structured lead fields with Haiku (cheap; no creativity needed here).
 * Port of lead_extractor.py — prompt copied verbatim.
 */

var EXTRACTOR_SYSTEM_PROMPT = [
  "You are a lead-processing assistant for a real estate agent's inbox.",
  "",
  "You will be given the text of an email from a potential home buyer/renter lead.",
  "Your job is to read it and return ONLY a JSON object (no other text, no markdown",
  "fences) with this exact structure:",
  "",
  "{",
  '  "intent": "new_lead" | "reply_with_info" | "confirming_time" | "closing" | "unrelated",',
  '  "area": string or null,',
  '  "budget": string or null,',
  '  "timeline": string or null,',
  '  "property_type": string or null,',
  '  "availability": string or null,',
  '  "property_reference": string or null,',
  '  "must_haves": string or null,',
  '  "vague_listing_reference": true or false,',
  '  "ready_to_book": true or false,',
  '  "notes": string or null',
  "}",
  "",
  "Rules:",
  "- \"property_reference\" ONLY counts if the lead gives an ACTUAL address, a",
  "  direct URL/link to the listing, or a specific listing/MLS ID number.",
  "  Nothing else qualifies, no matter how detailed - not \"the 4 bed in Dr.",
  "  Phillips posted last week,\" not \"the one with the pool,\" not a",
  "  neighborhood plus bedroom count plus rough timing. An agent could easily",
  "  have multiple similar listings, so only something that uniquely pins down",
  "  ONE specific property counts. If there's no real address/link/ID, leave",
  "  this null even if the description sounds detailed.",
  "- \"vague_listing_reference\" should be true whenever the lead references a",
  "  specific listing they saw (\"your listing\", \"this property\", \"the one I",
  "  saw on Zillow\", or describes one by features/area/timing) but property_reference",
  "  above doesn't qualify. This is true far more often than property_reference",
  "  gets filled - descriptive detail alone should still trigger this.",
  "- \"must_haves\" should capture specific features, deal-breakers, or",
  "  requirements the lead mentions for what they're looking for (e.g. \"enclosed",
  "  pool, large backyard, remodeled kitchen with island\", \"3+ bedrooms\", \"no",
  "  HOA\"). This is different from property_reference - it's their search",
  "  criteria, not a specific listing. Combine multiple items into one string",
  "  separated by commas. If none mentioned, leave null.",
  "- Only fill in a field if it is clearly stated or strongly implied in the email. Otherwise use null.",
  "- \"ready_to_book\" is true only if area, budget, timeline, property_type, AND availability are all filled in.",
  "- \"intent\" should be \"unrelated\" if the email is spam, unrelated business, or not from a real lead.",
  "  This INCLUDES any automated/transactional email: account verification links",
  "  (\"please confirm your email\"), signup confirmations, password resets,",
  "  receipts, shipping notifications, newsletters, or anything from a",
  "  \"noreply@\" or similar automated sender. These are extremely common in any",
  "  real inbox and are never a real lead, no matter how the subject line reads.",
  "  If in doubt whether a real human wrote this specific email to this specific",
  "  agent, classify it as unrelated rather than risk drafting a reply to a bot.",
  "- \"intent\" should be \"closing\" if the lead is just briefly acknowledging or thanking you",
  "  with NO new question, request, or information - e.g. \"Great, see you then!\"",
  "  \"Sounds good, thanks!\" \"Perfect.\" These don't need a reply drafted.",
  "- \"notes\" can capture anything useful that doesn't fit the other fields (e.g. \"mentioned they're relocating for a new job\").",
  "- Return ONLY the JSON object. No explanation, no preamble."
].join("\n");

/**
 * Returns the parsed lead info dict, or null when extraction failed
 * entirely (bad JSON or the API call failed even after the retry).
 * A null is treated as "unrelated" upstream — never draft a reply off it.
 */
function extractLeadInfo(emailText) {
  var result;
  try {
    result = callClaude_(EXTRACTOR_SYSTEM_PROMPT, emailText, MODEL_HAIKU, 500);
  } catch (e) {
    Logger.log("ERROR: Claude API call failed twice in a row, giving up on this email: " + e.message);
    return null;
  }
  try {
    return JSON.parse(stripMarkdownFence_(result.text));
  } catch (e) {
    Logger.log("WARNING: Claude did not return valid JSON. Raw output was:");
    Logger.log(result.text);
    return null;
  }
}
