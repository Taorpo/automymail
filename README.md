# AutoMyMail

An AI lead follow-up assistant for real estate agents, running entirely on
**Google Apps Script** — no servers, no hosting bill.

It watches a Gmail inbox, holds natural back-and-forth conversations with
new leads, and drafts booking-ready replies for the agent to review. It
**drafts** replies; it never sends email to a lead on its own.

## How it works

Every 10 minutes a time trigger runs `runCheck()` (`Code.gs`), which does
two passes:

1. **Inbox pass** — scans unread or last-2-days mail, skipping the agent's
   own address and AutoMyMail's own `[AutoMyMail]` summary emails.
2. **Stale-lead pass** — nudges leads who got proposed showing times 2+
   days ago but never confirmed.

For each new email from a lead:

- **Extractor** (`Extractor.gs`) — Claude Haiku classifies the intent
  (`new_lead`, `reply_with_info`, `confirming_time`, `closing`,
  `unrelated`) and pulls structured fields: area, budget, timeline,
  property type, availability, must-haves, and whether they're ready to book.
- **LeadDB** (`LeadDB.gs`) — merges the result into the lead's full profile
  in a Google Sheet (`leads` tab, keyed by email). Memory spans threads, so
  the bot remembers the whole conversation, not just the latest email.
- **Drafting** (`Drafting.gs`) — Claude Sonnet writes the reply in the
  agent's voice (`Voice.gs`) and saves it as a **Gmail draft** for human
  review. The only email ever actually *sent* is an internal summary to the
  agent when a lead confirms a showing time.
- **CalendarMatcher** (`CalendarMatcher.gs`) — when a lead is ready to book,
  it reads the agent's real calendar for blocks marked available and proposes
  2–3 concrete times.

Two deliberate safety rules:

- **Slot selection is plain code, never the AI.** The model is handed
  pre-formatted date labels and told to copy them verbatim — it can't
  invent or shift a time.
- **One bad email can never jam the batch.** Every email is marked processed
  whether it succeeded or threw, so a single failure doesn't block everything
  behind it.

A 20-check parity harness verified this port behaves identically to the
original Python prototype before cutover (all 20 passed).

## Setup

1. Create a **standalone** Apps Script project at
   [script.google.com](https://script.google.com) (not bound to a Sheet —
   it uses the Gmail and calendar of whichever Google account runs it).
2. Paste in the `.gs` files and `appsscript.json`, or push with
   [`clasp`](https://github.com/google/clasp).
3. In the editor: **Services (+) → Gmail API → Add** (the Advanced Gmail
   service, needed so drafts thread correctly with In-Reply-To headers).
4. Run `setup()` in `Setup.gs` — creates the "AutoMyMail Leads" spreadsheet
   (tabs: `leads`, `processed`) and stores its ID.
5. Run `storeApiKey()` in `Setup.gs` — saves your Anthropic API key. You'll
   be prompted to paste it; it goes to Script Properties, never into code.
6. Run the self-test functions in `Setup.gs` with synthetic emails first —
   no real lead gets a reply until you approve it.
7. Run `installTriggers()` — starts the free 10-minute check loop.

### Script Properties

| Property | Set by | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | `storeApiKey()` | Anthropic API key (Haiku for extraction, Sonnet for drafting) |
| `LEAD_SHEET_ID` | `setup()` | ID of the "AutoMyMail Leads" spreadsheet |
| `AGENT_EMAIL` | optional | Defaults to the account running the script; used to skip your own mail |

Manage them any time via **Project settings → Script properties**.

## Project history

AutoMyMail started as a Python prototype (Gmail API + Anthropic SDK +
SQLite, running 24/7 on a Render web service). It worked, but a $7+/month
server to check email felt wrong, so it was ported to Apps Script, where the
whole thing runs free inside Google's quota. This repo holds the Apps Script
version — the one that's actually deployed.

## Built with AI assistance

This project was developed with AI-assisted coding (Claude). I designed the
workflow and safety rules, directed the implementation, wrote and ran the
parity tests, troubleshot the edge cases (silently-dropped confirmations,
per-item dedup, Unicode stdout crashes), and did the Apps Script migration.
If you ask me about any file here, I can walk you through what it does and
why it's shaped that way.

## Limitations

- Replies are **drafts** — a human reviews and sends every one. That's a
  feature, not a bug.
- It proposes showing times; it does **not** create calendar bookings
  automatically.
- Extraction quality depends on the lead writing something legible; vague
  one-liners get a clarifying question, not a guess.
- Apps Script quotas apply (UrlFetch calls, Gmail reads) — fine for a solo
  agent's inbox, not for bulk outreach.

## No secrets in this repo

There are no API keys, credentials, tokens, or real lead data here — and
there never will be. Configuration lives in Script Properties, set at deploy
time. If you fork this, bring your own Anthropic key.
