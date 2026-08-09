#!/usr/bin/env python3
"""Draft tweets from a git diff/commit context using OpenRouter, then send to Telegram."""
import json
import os
import subprocess
import sys
import urllib.request

SYSTEM_PROMPT = """You draft tweets for Rob (robsannaa), the solo builder of OpenClaw Mission Control (a self-hosted dashboard for managing OpenClaw AI agent instances). You will be given commit messages and a diff summary for a batch of changes just pushed to the main branch. Draft 3 to 5 tweet options promoting this work.

VOICE RULES (mandatory, follow exactly):
- Benefit first. Lead with what it means for the reader or user, not with "I fixed X" as the opening line. State the outcome, then the work behind it.
- Sound human. Write like a person talking, not marketing copy. Casual, direct, no jargon-stacking.
- No em dashes. Use periods, commas, or start a new sentence instead.
- Not spammy. No hype words like "game-changer", "huge", "insane". No excessive emoji. No engagement-bait like "thoughts?" or "agree?".
- Humble. Do not oversell. Acknowledge the work took effort without bragging.
- Always positive. Even when describing a painful bug or a broken release, land on the fix and the forward motion, not the complaint.
- Never giving up undertone. Still building, still improving, showing up. Small consistent progress, not one-off flexes.
- Each tweet must be under 280 characters and postable as-is.

If the diff is trivial (docs typo, dependency bump, CI tweak) with nothing genuinely tweet-worthy, respond with exactly: NOTHING_TWEET_WORTHY

Output ONLY the tweet drafts, one per line, numbered 1 to N. No preamble, no explanation."""


def get_context() -> str:
    before = os.environ.get("GITHUB_EVENT_BEFORE", "")
    sha = os.environ.get("GITHUB_SHA", "HEAD")
    empty_sha = "0000000000000000000000000000000000000000"

    if not before or before == empty_sha:
        rev_range = f"{sha}~1..{sha}"
    else:
        rev_range = f"{before}..{sha}"

    log = subprocess.run(
        ["git", "log", rev_range, "--pretty=format:### %h%n%B%n"],
        capture_output=True, text=True
    ).stdout

    diffstat = subprocess.run(
        ["git", "diff", "--stat", rev_range],
        capture_output=True, text=True
    ).stdout

    context = f"## Commit messages\n{log}\n\n## Diff stat\n{diffstat}"
    return context[:12000]


def draft_tweets(context: str) -> str:
    api_key = os.environ["OPENROUTER_API_KEY"]
    payload = {
        "model": "anthropic/claude-sonnet-4.5",
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": context},
        ],
    }
    req = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=json.dumps(payload).encode(),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.load(resp)
    return data["choices"][0]["message"]["content"].strip()


def send_telegram(text: str) -> None:
    token = os.environ["TELEGRAM_BOT_TOKEN"]
    chat_id = os.environ["TELEGRAM_CHAT_ID"]
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {"chat_id": chat_id, "text": text}
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        print(resp.read().decode())


def main() -> None:
    context = get_context()
    print("=== Context sent to model ===", file=sys.stderr)
    print(context, file=sys.stderr)

    tweets = draft_tweets(context)
    print("=== Draft tweets ===", file=sys.stderr)
    print(tweets, file=sys.stderr)

    if "NOTHING_TWEET_WORTHY" in tweets:
        print("Nothing tweet-worthy in this push, skipping Telegram send.")
        return

    server_url = os.environ.get("GITHUB_SERVER_URL", "https://github.com")
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    sha = os.environ.get("GITHUB_SHA", "")
    commit_url = f"{server_url}/{repo}/commit/{sha}"

    message = f"New Mission Control tweet drafts\nPushed: {commit_url}\n\n{tweets}"
    send_telegram(message)


if __name__ == "__main__":
    main()
