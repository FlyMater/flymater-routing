set -eu
git diff --cached --quiet && exit 0
git config user.name 'github-actions[bot]'
git config user.email '41898282+github-actions[bot]@users.noreply.github.com'
git commit -m "$1"
for attempt in 1 2 3; do
  git push origin "HEAD:$GITHUB_REF_NAME" && exit 0
  git fetch origin "$GITHUB_REF_NAME"
  # A newer input has its own run. Never publish an obsolete build over it.
  if ! git diff --quiet HEAD^ FETCH_HEAD -- source scripts .github "${2:-source/routing.json}"; then
    exit 1
  fi
  git rebase FETCH_HEAD
done
exit 1
