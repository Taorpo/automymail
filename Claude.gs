/**
 * Claude.gs — the bot's "brain" calls. Replaces lead_extractor.py's Anthropic
 * SDK usage with direct HTTPS calls to the Anthropic Messages API via
 * UrlFetchApp. Same models, same prompts, same retry behavior.
 *
 * Your API key lives in Script Properties (never in this code):
 *   ANTHROPIC_API_KEY = sk-ant-...
 * Set it once via Setup.gs > "Store API key" or File > Project settings >
 * Script Properties.
 */

// Change these in ONE place if Anthropic renames a model.
var MODEL_HAIKU = "claude-haiku-4-5-20251001";  // extraction/classification (cheap)
var MODEL_SONNET = "claude-sonnet-4-6";         // anything the lead will read

function getApiKey_() {
  var key = PropertiesService.getScriptProperties().getProperty("ANTHROPIC_API_KEY");
  if (!key) {
    throw new Error("ANTHROPIC_API_KEY is not set. Run storeApiKey() in Setup.gs first.");
  }
  return key;
}

/**
 * Calls the Anthropic Messages API. Mirrors the Python SDK call:
 * system prompt with prompt caching, one retry on transient failure.
 */
function callClaude_(systemPrompt, userContent, model, maxTokens) {
  var payload = {
    model: model,
    max_tokens: maxTokens,
    system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: userContent }]
  };

  var attempt = function () {
    var resp = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
      method: "post",
      contentType: "application/json",
      muteHttpExceptions: true,
      headers: {
        "x-api-key": getApiKey_(),
        "anthropic-version": "2023-06-01"
      },
      payload: JSON.stringify(payload)
    });
    if (resp.getResponseCode() >= 400) {
      throw new Error("Anthropic API HTTP " + resp.getResponseCode() + ": " + resp.getContentText().slice(0, 300));
    }
    var data = JSON.parse(resp.getContentText());
    var text = data.content.map(function (b) { return b.text || ""; }).join("");
    return { text: text, stopReason: data.stop_reason };
  };

  try {
    return attempt();
  } catch (e) {
    // One retry on a transient failure (network blip, rate limit), exactly
    // like the Python version. A single one-off hiccup must not permanently
    // drop a lead's email.
    Logger.log("WARNING: Claude API call failed (" + e.message + ") - retrying once...");
    Utilities.sleep(2000);
    return attempt(); // if this throws, the caller treats it as extraction failure
  }
}

/**
 * Claude occasionally wraps JSON in ```json fences despite being told not
 * to. Strip defensively so a stray fence doesn't fail JSON.parse.
 * (Port of lead_extractor._strip_markdown_fence)
 */
function stripMarkdownFence_(text) {
  text = text.trim();
  if (text.indexOf("```") === 0) {
    text = text.slice(3);
    if (text.toLowerCase().indexOf("json") === 0) text = text.slice(4);
    if (text.lastIndexOf("```") === text.length - 3) text = text.slice(0, -3);
    text = text.trim();
  }
  return text;
}
