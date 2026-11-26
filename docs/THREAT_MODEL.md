# PulseChat Threat Model

| Threat | Attack | Mitigation | Verification | Residual Risk |
| :--- | :--- | :--- | :--- | :--- |
| **Stolen Access Token** | Attacker steals a JWT from memory/network and replays it indefinitely | Short 15-minute access token TTL (`sid` bound to revocable `Session`); `socket.use()` rejects expired tokens with `auth:expired` and disconnects after 30s | `sessionsAndTokens.test.js` | Valid for up to 15 minutes until expiry or explicit session revocation |
| **Stolen Refresh Token** | Attacker steals `refreshToken` and rotates it before or after the legitimate user | Stored as SHA-256 hash only in `httpOnly`, `SameSite=None; Secure` (prod), `Path=/api/auth` cookie; atomic rotation via `findOneAndUpdate`; replay of `previousTokenHash` outside 10s grace window revokes the entire session family and disconnects sockets | `sessionsAndTokens.test.js` | Replay within the 10-second multi-tab grace window is tolerated before triggering family revocation |
