# Customer Reps grid

A small internal page for searching, paging through, adding, editing, and deleting
rows in the Azure SQL table `dbo.Multi_Line_Rep_new`. Its identity primary key
`ID` identifies each row for editing and deletion. SQL generates IDs for new rows,
which require at least one data value.

```
public/index.html  ──>  api/index.js (Azure Functions)  ──>  Azure SQL
```

## How this project is built (read this before changing anything)

- **Few files, little indirection.** The whole page is `public/index.html`
  (HTML + CSS + JS inline). The whole API is `api/index.js` (columns, SQL,
  password check). Large files are fine. Many small files are not.
- **Grow the files that exist.** A new feature means more code in
  `index.html` or `index.js`, not a new file, folder, layer or helper module.
- **No frameworks, build steps, TypeScript, ORMs, Docker or "for later" code.**
  Add something only when it's needed today.
- **SQL is written out in full** in `api/index.js`. Search values are passed
  as parameters, and the grid uses the database primary key as its row ID.
- **Secrets live only in `.env`** (local) and in Azure's Environment variables
  (live). Never in code, never shared in chat.

## Files

| File | What it is |
|---|---|
| `public/index.html` | The whole page. |
| `api/index.js` | The whole API. |
| `sandbox.cmd` | Double-click: runs the app locally and opens the browser. |
| `deploy.cmd` | Double-click: publishes to Azure. |
| `.env` | Database settings + app password. Private. |
| `deploy-token.txt` | Azure deploy password. Private. |
| `public/staticwebapp.config.json`, `api/package.json`, `api/package-lock.json`, `api/host.json`, `api/local.settings.json` | Required by Azure. Rarely touched. |

## Run it locally

Nothing to install. Double-click **`sandbox.cmd`**: the page opens at
http://localhost:4280 (the first run downloads its own tools into `tools/`
and takes a few minutes; after that ~20 seconds). Close the black window to
stop. It uses `HPG_CDW_SB01`, the same database as the published application.

## Deploy

Double-click **`deploy.cmd`**. Wait for "DONE".
Live site: https://mango-stone-0632ee610.5.azurestaticapps.net

## Settings (`.env` locally, Environment variables in Azure)

```
AZURE_SQL_USER=grid_app
AZURE_SQL_PASSWORD=...
APP_PASSWORD=the-password-people-type
GITHUB_TOKEN=...
# Optional; defaults to martyscherrhpg/DataUtility
GITHUB_REPOSITORY=martyscherrhpg/DataUtility
```

The database login needs read, insert, update, and delete access:
`GRANT SELECT, INSERT, UPDATE, DELETE ON dbo.Multi_Line_Rep_new TO grid_app;`

GitHub uploads use a fine-grained personal access token scoped to the target
repository with **Contents: Read and write** permission. Keep it in `.env` for
local runs and add `GITHUB_TOKEN` as an Azure Static Web Apps application
setting for the live app. Uploads are grouped into a unique `incoming/` folder
and committed to the repository's default branch; the app password is also
required. `GITHUB_REPOSITORY` can override the default `owner/repository` target.

## Changing columns or the table

The actual table and columns are configured in `api/index.js`. Pagination is
server-side (25–200 rows per page) and search spans the complete table. Each row
uses the identity primary key `ID`, including rows with identical data values.
Both local and published connections explicitly target `HPG_CDW_SB01` on
`db-hpg-cdw-sb01.database.windows.net` in `api/index.js`. Old
`AZURE_SQL_SERVER` and `AZURE_SQL_DATABASE` environment variables are ignored.
Database credentials and the application password still use environment settings.

## Later (not built yet)

- **Company sign-in:** Static Web Apps Standard plan + Entra app registration,
  configured in `staticwebapp.config.json`; then remove the password check.
- **No database password:** Managed Identity needs the API in its own Function
  App (Standard plan).
- **Auto-deploy on git push:** GitHub repo + the `Azure/static-web-apps-deploy`
  action.
