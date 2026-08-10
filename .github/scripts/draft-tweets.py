#!/usr/bin/env python3
"""Draft ONE promo tweet from a git diff/commit context using OpenRouter, then send to Telegram."""
import json
import os
import subprocess
import sys
import urllib.request

REPO_URL = "https://github.com/robsannaa/openclaw-mission-control"

SYSTEM_PROMPT = f"""You draft tweets for Rob (robsannaa), the solo builder of OpenClaw Mission Control (a self-hosted dashboard for managing OpenClaw AI agent instances) and agentbay.space (hosted OpenClaw + Mission Control SaaS). You will be given commit messages and a diff summary for a batch of changes just pushed to the main branch. Draft EXACTLY ONE tweet promoting this work.

GOAL: spark curiosity. The reader should think "this looks cool, I want to check this out" and click through to the repo. Sell Mission Control as an interesting, useful product, with this push as fresh proof it keeps getting better.

FORMAT RULES (mandatory):
- ONE tweet only. Not a thread, not options, no numbering.
- Under 280 characters total, always. Postable as-is, no trimming needed.
- Structure: one hook line that leads with the payoff, then a short bullet list (2-4 bullets) of what just shipped, then the repo link on its own last line.
- The tweet MUST end with this exact URL on its own line: {REPO_URL}
- Bullets use an emoji or a bullet character as the marker, with line breaks between bullets. Keep each bullet a few words, benefit-phrased, not commit-message-phrased.
- Use emojis: 1 to 3 total, placed naturally. Not excessive, not absent.
- No em dashes. Use periods, commas, line breaks, or bullets instead.

TONE RULES (mandatory):
- Always positive. Frame everything as forward motion and product value. A bug fix becomes "more reliable", never a complaint.
- Sound human. Write like a builder tweeting, not marketing copy. No hype words like "game-changer", "huge", "insane". No engagement-bait.
- Spark curiosity without overselling. Concrete beats grandiose.

If the diff is trivial (docs typo, dependency bump, CI tweak) with nothing genuinely tweet-worthy, respond with exactly: NOTHING_TWEET_WORTHY

Output ONLY the tweet text, fully formatted. No preamble, no explanation, no quotes around it."""

# The exact answer the prompt above asks for when a push is not worth tweeting.
# Compared against the model's whole reply, never searched for inside it.
NOTHING_SENTINEL = "NOTHING_TWEET_WORTHY"


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


def draft_tweet(context: str) -> str:
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


def enforce_tweet(tweet: str) -> str:
    """Guarantee the repo URL is present and the limit holds.

    Never trust the model alone: append the URL if it dropped it, and when
    trimming, cut the body while keeping the URL line intact.
    """
    tweet = tweet.strip().strip('"')
    if REPO_URL not in tweet:
        tweet = f"{tweet}\n{REPO_URL}"
    if len(tweet) <= TWEET_CHAR_LIMIT:
        return tweet

    body = tweet.replace(REPO_URL, "").rstrip()
    max_body = TWEET_CHAR_LIMIT - len(REPO_URL) - 2  # newline + ellipsis
    trimmed = body[:max_body]
    last_space = trimmed.rfind(" ")
    if last_space > 0:
        trimmed = trimmed[:last_space]
    return f"{trimmed.rstrip()}…\n{REPO_URL}"


def main() -> None:
    context = get_context()
    print("=== Context sent to model ===", file=sys.stderr)
    print(context, file=sys.stderr)

    raw = draft_tweet(context)
    print("=== Draft tweet ===", file=sys.stderr)
    print(raw, file=sys.stderr)

    # The sentinel counts only when it is the model's WHOLE answer, so a tweet
    # that merely quotes the token can never silence a real draft.
    if raw.strip() == NOTHING_SENTINEL:
        print("Nothing tweet-worthy in this push, skipping Telegram send.")
        return

    server_url = os.environ.get("GITHUB_SERVER_URL", "https://github.com")
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    sha = os.environ.get("GITHUB_SHA", "")
    commit_url = f"{server_url}/{repo}/commit/{sha}"

    tweet = enforce_tweet(raw)
    send_telegram_message(f"New Mission Control tweet draft\nPushed: {commit_url}")
    # The tweet goes as its own message so it can be copied verbatim.
    send_telegram_message(f"({len(tweet)} chars)\n\n{tweet}")


if __name__ == "__main__":
    main()
