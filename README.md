# InkNotes

Sticky notes you can write on with a pen (pressure-sensitive), type in, and paste images into.
Installable web app that works offline. Notes are stored on each device (IndexedDB) and can
sync through your own OneDrive.

- `app/` – the web app (published to GitHub Pages)
- `ink-test.html` – pen test bench
- `dev-server.js` – local server: `node dev-server.js`, then open http://localhost:5173
- `test/sync.test.mjs` – sync and encryption tests: `node test/sync.test.mjs`

## OneDrive sync

- Signs in with a personal Microsoft account and uses only the app folder (`Apps/InkNotes`,
  permission `Files.ReadWrite.AppFolder`).
- End-to-end encrypted: notes and images are sealed with AES-256-GCM on the device, using a key
  made from a sync passphrase (PBKDF2-SHA256, 600,000 rounds). OneDrive only holds ciphertext.
- Per note, the most recent edit wins. Deletions sync too.

Setup: register an app in the Microsoft Entra admin center (account type "Personal Microsoft
accounts only", platform "Single-page application", redirect URI
`https://hwang106.github.io/inknotes/` and `http://localhost:5173/`), then put its Application
(client) ID in `app/js/config.js`.

To test sync without a real account: `node dev-server.js --fake-ms --port=5174`, then open
http://localhost:5174 and http://127.0.0.1:5174 as two devices.
