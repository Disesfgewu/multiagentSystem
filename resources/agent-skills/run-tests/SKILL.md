---
name: run-tests
description: Run this project's real tests once and report only what matters (counts and failures). Use before saying something works, before opening or updating a pull request, and after every fix, instead of guessing the command or pasting the whole output.
---

1. Find the test command once per session: `package.json` scripts, `Makefile`, the README, or the CI workflow (`.github/workflows/*`). Prefer the command CI runs. Do not invent one.
2. Run it from the repository root and keep only the end of the output:
   ```bash
   <test command> 2>&1 | tail -40
   ```
   If the project has separate suites (unit, integration, end-to-end), run the ones your change touches, and say which you did not run.
3. Report: the command, how many passed and failed, and for each failure its name and the first assertion message. Nothing else.
4. A failure is either yours or already on the base branch. Check the base branch before calling one unrelated; never skip or loosen a test to make it pass.
5. Never say "all tests pass" for a suite you did not run.
