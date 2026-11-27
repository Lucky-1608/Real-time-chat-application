# External Data Flows

This document records every third-party integration, what data leaves the server, and which workspace/feature controls gate it.

| Provider / Feature | Interface | Outbound Data | Gating Controls | Local Dev / Test Behavior |
| --- | --- | --- | --- | --- |
| **Anthropic Claude** (`Catch me up` / `/summarize`) | `services/summaryService.js` | Room message transcript wrapped in `<untrusted_chat_transcript>` XML tags (with prompt-injection system guard) | `aiSummaries` feature flag + per-user rate limit (5/hr) + room membership | Mock Anthropic client in tests |
| **Giphy** (`/giphy <query>`) | `services/providers/gifProvider.js` | Search query string only (never message history or user PII); `rating=pg` enforced | `slashCommands` feature flag + `workspace.settings.allowExternalProcessing` + per-user rate limit (10/min) + CSP `img-src` allowlist | `createMockGifProvider()` used in tests and when `GIPHY_API_KEY` is unset |
| **Outgoing Webhooks** (`dispatchOutgoingEvent`) | `services/webhooks/outgoingDispatcher.js` + `ssrfGuard.js` | Signed JSON event payload (`eventId`, `deliveryId`, `event`, `workspaceId`, `roomId`, minimal message/member data) | `outgoingWebhooks` feature flag + workspace/room scoping + HTTPS-only + SSRF IP/redirect guard | Delivered via atomic `OutgoingDeliveryJob` queue (Redis/BullMQ optional) |
