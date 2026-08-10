#!/usr/bin/env python3
"""Draft tweets from a git diff/commit context using OpenRouter, then send to Telegram."""
import json
import os
import re
import subprocess
import sys
import urllib.request

SYSTEM_PROMPT = """You draft tweets for Rob (robsannaa), the solo builder of OpenClaw Mission Control (a self-hosted dashboard for managing OpenClaw AI agent instances) and agentbay.space (hosted OpenClaw + Mission Control SaaS). You will be given commit messages and a diff summary for a batch of changes just pushed to the main branch. Draft 3 to 5 tweet options promoting this work.

FORMAT RULES (X-native style, mandatory):
- Under 280 characters, always. Postable as-is, no trimming needed.
- Use emojis: 1 to 3 per tweet, placed naturally (as bullet markers, at the start of a benefit line, or as a light accent). Not excessive, not absent. Think "real builder tweeting", not corporate, not bare text either.
- Prefer bullet-point structure when listing 2+ things (use an emoji or a bullet character as the marker, with line breaks between bullets). A single strong one-liner is fine when the update is one clear thing.
- Benefit first, hook first. The opening line must make someone want to keep reading or go check the repo out. Lead with the outcome or payoff, not a flat "fixed X" or "shipped Y" statement.
- No em dashes. Use periods, commas, line breaks, or bullets instead.

TONE RULES (mandatory):
- Sound human. Write like a person tweeting, not marketing copy. Casual, direct, no jargon-stacking.
- Not spammy. No hype words like "game-changer", "huge", "insane". No engagement-bait like "thoughts?" or "agree?".
- Humble. Do not oversell. Acknowledge the work took effort without bragging. "Took a while to track down" beats "crushed this bug".
- Always positive. Even when describing a painful bug or a broken release, land on the fix and the forward motion, not the complaint.
- Never giving up undertone. Still building, still improving, showing up. Small consistent progress, not one-off flexes.
- Spark curiosity. The reader should feel "oh, I should go look at this repo", not just "ok, noted".

If the diff is trivial (docs typo, dependency bump, CI tweak) with nothing genuinely tweet-worthy, respond with exactly: NOTHING_TWEET_WORTHY

Output ONLY the tweet drafts, one per line, numbered 1 to N, with emojis/bullets already formatted in. No preamble, no explanation."""


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


def send_telegram_message(text: str) -> None:
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


TWEET_CHAR_LIMIT = 280


def parse_tweets(raw: str) -> list[str]:
    """Split the model's numbered-list output into individual tweet strings.

    Each tweet starts with a line like "1. " / "2. " etc. Everything up to
    the next numbered marker (or end of text) belongs to that tweet.
    """
    lines = raw.strip().splitlines()
    tweets: list[str] = []
    current: list[str] = []

    def flush():
        if current:
            tweet = "\n".join(current).strip()
            if tweet:
                tweets.append(tweet)

    marker_re = re.compile(r"^\s*(\d+)[.)]\s+(.*)$")
    for line in lines:
        m = marker_re.match(line)
        if m:
            flush()
            current = [m.group(2)]
        else:
            current.append(line)
    flush()
    return tweets


def enforce_limit(tweet: str) -> str:
    """Hard-enforce the character limit. Never trust the model alone."""
    if len(tweet) <= TWEET_CHAR_LIMIT:
        return tweet
    # Trim to the limit minus an ellipsis, breaking on the last whitespace
    # before the cutoff so we do not chop a word or emoji in half.
    cutoff = TWEET_CHAR_LIMIT - 1
    trimmed = tweet[:cutoff]
    last_space = trimmed.rfind(" ")
    if last_space > 0:
        trimmed = trimmed[:last_space]
    return trimmed.rstrip() + "\u2026"


def send_telegram_tweets(tweets: list[str], commit_url: str) -> None:
    """Send an intro line, then each tweet as its own separate message so
    it is immediately obvious where one tweet ends and the next begins."""
    intro = f"New Mission Control tweet drafts ({len(tweets)})\nPushed: {commit_url}"
    send_telegram_message(intro)
    for i, tweet in enumerate(tweets, start=1):
        clean = enforce_limit(tweet)
        send_telegram_message(f"{i}/{len(tweets)} ({len(clean)} chars)\n\n{clean}")


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

    # `send_telegram` never existed: every push that produced drafts got all the
    # way here, generated them, and then died with a NameError — so the drafts
    # were only ever visible in the Actions log. `send_telegram_tweets` splits
    # them into one message per tweet, which is why `parse_tweets` is here.
    drafts = parse_tweets(tweets)
    if not drafts:
        print("Model output had no numbered tweets to parse, skipping Telegram send.")
        return

    send_telegram_tweets(drafts, commit_url)


if __name__ == "__main__":
    main()
