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

## Automated revalidation — 2026-09-26

The focused regression pass now also verifies:

1. Two rapid clicks while the first start request is pending produce one request.
2. A failed first request produces a safe alert with an enabled explicit retry action.
3. The server-rendered bootstrap contains a loading state and no inert consent button; the first consent button rendered after hydration is enabled.
4. The patient composer retains the IME guard, a multiline textarea, the message-length limit, retry state, 16 px mobile input text and a non-shrinking send button.

These checks are local and synthetic. They do not assert production availability or external delivery.
