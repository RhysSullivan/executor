---
"executor": patch
---

Add a test seam to skip the first-run "keep Executor running in the background?" consent dialog under automation, matching the existing `confirmResetState` seam. Set `EXECUTOR_TEST_AUTO_CONFIRM_BACKGROUND_SERVICE=1` to keep the background service or any other value to decline. When the variable is unset the dialog is shown exactly as before. Native dialogs cannot be answered from CDP or Playwright, so a packaged first-run boot under automation previously blocked at this prompt with no way to proceed.
