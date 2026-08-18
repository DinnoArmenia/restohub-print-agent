# RestoHub Print Agent

Background Windows printing for RestoHub kitchen, bar and bill printers. The agent uses Electron's silent native print API, so Armenian text is rendered by Chromium and sent through the selected Windows printer driver without a visible browser or print dialog.

## Install

1. Install the generated `RestoHub-Print-Agent-Setup-*.exe` as Administrator.
2. Open **RestoHub Print Agent** from Start Menu.
3. Add a route, paste the printer key from RestoHub, and select its Windows printer.
4. Save and use **Test** in RestoHub Back Office.

The agent starts automatically at Windows login and lives in the system tray. Closing the configuration window does not stop printing.

## Development

```bash
npm ci
npm test
npm run typecheck
npm run dev
```

Build the signed/unsigned Windows installer on Windows or a Windows GitHub Actions runner:

```powershell
npm ci
npm run dist:win
```

## Reliability model

- Server jobs are leased and acknowledged; an interrupted job returns to the queue.
- Windows printer names are explicit per route; the default printer is never assumed.
- Failures are reported to RestoHub and retried by server policy.
- Only HTTPS RestoHub servers are accepted outside local development.

Version 0.1 uses existing printer keys for backward compatibility. The RestoHub integration branch adds device enrollment and rotating agent credentials before general rollout.
