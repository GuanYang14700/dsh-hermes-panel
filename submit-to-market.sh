#!/usr/bin/env bash
# Submit hermes-panel to the DSH plugin market.
#
# Automated form of PUBLISH-TO-MARKET.md. Safe to re-run: it refuses to start
# before the repository meets the market's own age floor, and it reports an
# existing pull request instead of opening a duplicate.
#
# Usage:  bash submit-to-market.sh [--force] [--dry-run]
#   --force    submit even if the 1-day age floor is not met yet
#   --dry-run  do everything up to the push, then stop; changes nothing on GitHub
set -uo pipefail

REPO_SLUG="GuanYang14700/dsh-hermes-panel"
UPSTREAM="awesome-dsh-plugin/awesome-dsh-plugin"
ENTRY_FILE="data/plugins/GuanYang14700__dsh-hermes-panel.yml"
BRANCH="add-hermes-panel"
MARKET_SRC="E:/Harness/dsh/plugins/hermes-panel/market-entry.yml"
ENTRY_CHECK="E:/Harness/dsh/plugins/hermes-panel/verify/market-entry.mjs"
SUBMIT_DIR="E:/Harness/dsh/home/.market-submit"
# The age bar clears at 2026-10-16T08:18:27Z; after this instant the check is
# expected to pass. Kept as a constant so the message never has to be redone.
AGE_READY_UTC="2026-10-16T08:18:27Z"

FORCE=0
DRY=0
for arg in "$@"; do
  case "$arg" in
    --force)   FORCE=1 ;;
    --dry-run) DRY=1 ;;
    *) printf 'unknown option: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
die() { printf 'FAILED: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- age floor
# One request answers all of it; no API token needed for a public repo.
meta=$(curl -s "https://api.github.com/repos/$REPO_SLUG") || die "GitHub API unreachable"
created=$(printf '%s' "$meta" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s);if(!r.created_at){process.stderr.write("API error: "+JSON.stringify(r).slice(0,200)+"\n");process.exit(1)}process.stdout.write(r.created_at)})') \
  || die "could not read repository metadata"
private=$(printf '%s' "$meta" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(String(JSON.parse(s).private))})')
branch=$(printf '%s' "$meta" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(JSON.parse(s).default_branch)})')

age_days=$(node -e "console.log(((Date.now()-Date.parse(process.argv[1]))/86400000).toFixed(3))" "$created")
say "repo created_at : $created"
say "repo age (days) : $age_days  (market floor: 1, from scripts/check-submission.mjs MIN_AGE_DAYS)"

if node -e "process.exit(Number(process.argv[1]) < 1 ? 1 : 0)" "$age_days"; then
  say "age floor      : met"
else
  if [[ $FORCE -eq 1 ]]; then
    say "WARNING: below the 1-day floor; --force given, continuing."
    say "         CI reports the age bar and regate.yml re-runs the gate every 6h,"
    say "         so the verdict clears on its own — no resubmit needed."
  else
    die "repository is only $age_days days old; the market's CI requires a full 24h.
     The bar clears at $AGE_READY_UTC (16:18 Beijing time).
     Nothing is lost by waiting; re-run this script after that time."
  fi
fi

[[ "$private" == "false" ]] || die "repository is not public (private=$private)"
[[ "$branch" == "main" ]] || die "default_branch is '$branch', market expects 'main'"

# ------------------------------------------------------------------- source
[[ -f "$MARKET_SRC" ]] || die "market entry source missing: $MARKET_SRC"
[[ -f "$ENTRY_CHECK" ]] || die "entry checker missing: $ENTRY_CHECK"

# Only url / name / category / description survive; anything else (e.g.
# tarball:) is dropped, and the market's own quoting rule is checked here.
say "==> validating $MARKET_SRC"
entry_body=$(node "$ENTRY_CHECK" "$MARKET_SRC") || die "the market entry is not submittable (see the reason above)"

say "entry fields to submit:"
printf '%s\n' "$entry_body" | sed 's/^/  /'

# ------------------------------------------------------------------ gh ready
gh auth status >/dev/null 2>&1 || die "gh is not authenticated"

# ----------------------------------------------------------- fork and branch
rm -rf "$SUBMIT_DIR"
mkdir -p "$SUBMIT_DIR"
cd "$SUBMIT_DIR" || die "cannot enter $SUBMIT_DIR"

say ""
say "==> forking $UPSTREAM"
gh repo fork "$UPSTREAM" --clone=false >/dev/null 2>&1 || say "    (fork may already exist; continuing)"

# Clone the contributor's fork if it exists and is current, else upstream.
if gh repo view "GuanYang14700/awesome-dsh-plugin" >/dev/null 2>&1; then
  say "==> cloning fork GuanYang14700/awesome-dsh-plugin"
  gh repo clone "GuanYang14700/awesome-dsh-plugin" awesome-dsh-plugin >/dev/null 2>&1 \
    || die "could not clone the fork"
else
  say "==> no fork found; cloning upstream directly"
  gh repo clone "$UPSTREAM" awesome-dsh-plugin >/dev/null 2>&1 || die "could not clone upstream"
fi

cd awesome-dsh-plugin || die "clone did not produce awesome-dsh-plugin"

if git remote get-url upstream >/dev/null 2>&1; then
  say "==> syncing fork with upstream main"
  git fetch -q upstream main || die "could not fetch upstream"
  git checkout -q main || die "could not check out main"
  git merge -q --ff-only upstream/main || die "fork main has diverged from upstream; sync it on GitHub and re-run"
fi

# A fork is a fine base but the PR must be opened against upstream.
if ! git remote get-url origin | grep -q "GuanYang14700/awesome-dsh-plugin"; then
  say "==> origin is not the fork; pushing from a fork is required for a PR"
  die "clone came from upstream and no fork exists yet — re-run once the fork exists"
fi

# The branch must start from the fork's up-to-date main.
git checkout -q -B "$BRANCH" || die "could not create branch $BRANCH"

mkdir -p "$(dirname "$ENTRY_FILE")"
# printf, not echo: command substitution already stripped the trailing newline
# from entry_body, and a YAML file without a final newline is not what the
# generator or the linter expects.
printf '%s\n' "$entry_body" > "$ENTRY_FILE" || die "could not write $ENTRY_FILE"
say "==> wrote $ENTRY_FILE ($(wc -c < "$ENTRY_FILE") bytes)"

# The stale-fork guard fails on >2 deletions; confirm we only added one file.
git add "$ENTRY_FILE"
staged=$(git diff --cached --name-status --diff-filter=D -- data/plugins | grep -c '\.yml$' || true)
added=$(git diff --cached --name-status --diff-filter=A -- data/plugins | grep -c '\.yml$' || true)
say "staged entry files: +$added -$staged"
[[ "$added" == "1" ]] || die "expected exactly one added entry file, staged +$added"
[[ "$staged" == "0" ]] || die "this branch would delete $staged entry files (stale fork); sync the fork and re-run"

git -c user.name="GuanYang14700" -c user.email="GuanYang14700@users.noreply.github.com" \
  commit -q -m "Add $REPO_SLUG" || die "commit failed"
say "==> committed"

# ------------------------------------------------------------- push and PR
if [[ $DRY -eq 1 ]]; then
  say ""
  say "==> --dry-run: stopping before push. Branch $BRANCH is committed locally."
  say "    staged:"
  git show --stat --oneline HEAD | sed 's/^/      /'
  say "DRY_RUN_OK"
  exit 0
fi

say "==> pushing $BRANCH"
git push -q -u origin "$BRANCH" --force-with-lease || die "push failed"

existing=$(curl -s "https://api.github.com/repos/$UPSTREAM/pulls?state=all&head=GuanYang14700:$BRANCH" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const a=JSON.parse(s);console.log(Array.isArray(a)&&a[0]?a[0].html_url:"");}catch{console.log("");}})')

if [[ -n "$existing" ]]; then
  say "==> pull request already open: $existing"
  say "    the branch was updated in place, so that PR now carries the current entry."
  PR_URL="$existing"
else
  PR_URL=$(gh pr create --repo "$UPSTREAM" \
    --head "GuanYang14700:$BRANCH" \
    --title "Add $REPO_SLUG" \
    --body "A Hermes panel for DSH. Repo: https://github.com/$REPO_SLUG" 2>&1) || {
      say "gh pr create said: $PR_URL"
      die "could not open the pull request (is the fork ahead of upstream? try: gh pr create --repo $UPSTREAM --web)"
    }
  say "==> pull request: $PR_URL"
fi

say ""
say "PR_URL=$PR_URL"
say "DONE"
