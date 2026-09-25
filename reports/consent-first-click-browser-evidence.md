# Consent first-click browser evidence

Date: 2026-09-21 (Asia/Almaty)
Scope: patient consent bootstrap only
Environment: local development build, browser automation session, synthetic invalid token, no external API calls

## Manual browser result

Five fresh page visits were performed. On every visit:

1. The consent action was absent while query and session-storage bootstrap was pending.
2. The first consent action shown to the user was enabled.
3. Its first click produced exactly one `POST /api/chat/start` request.
4. The synthetic token received the expected `400` response and the page moved to its invalid-link state instead of ignoring the click.

Result: **5/5 first visible clicks reached the start endpoint; 0 duplicate requests.**

This is local browser evidence, not a production smoke result. It uses no patient data and does not establish live API or production availability.

## Permanent regression gate

`tests/unit/consent-hydration.test.tsx` repeats five independent full `PatientChat` SSR-to-hydration cycles in jsdom. Each cycle waits for the real mount effect to replace the loading state, clicks the first enabled consent DOM button, and verifies exactly one `startChat(token, language)` call and the resulting chat state.

Run it with:

```bash
npx vitest run tests/unit/consent-hydration.test.tsx
```

The repository uses jsdom for this narrow hydration gate. Playwright is not a repository dependency.
