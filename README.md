# RestoHub Print Worker

> **Archived:** this component now lives at
> [`DinnoArmenia/RestoHubLocalAgent/src/RestoHub.PrintWorker`](https://github.com/DinnoArmenia/RestoHubLocalAgent/tree/master/src/RestoHub.PrintWorker).
> All new development, versioning and Windows releases happen in the unified repository.

Background Windows printing for RestoHub kitchen, bar and bill printers. The agent uses Electron's silent native print API, so Armenian text is rendered by Chromium and sent through the selected Windows printer driver without a visible browser or print dialog.

The customer-facing product is **RestoHub Local Agent**. This repository contains its isolated printing
worker. The fiscal Windows service supervises the worker and owns the unified tray, setup and support UI;
the worker stays in the signed-in Windows session because that is where Windows printer drivers are
available. A printer crash therefore cannot stop fiscal receipts, and an HDM failure cannot stop kitchen
printing.

## Managed mode

The combined installer starts the unpacked worker with:

```powershell
"RestoHub Print Worker.exe" --managed-worker --data-dir "C:\ProgramData\HdmBridge\printing"
```

Managed mode has no tray icon or configuration window. It reads `config.json` from the shared directory
and publishes a credential-free `status.json` containing detected Windows printers and per-route health.
The RestoHub Local Agent UI owns those files. Changes to `config.json` are picked up without restarting the
worker.

The legacy standalone UI remains available during the pilot, but it is not the intended customer install.

## Install

1. Install the generated standalone worker setup as Administrator.
2. Open **RestoHub Print Worker** from Start Menu.
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
