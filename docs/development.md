# Developer guide

## Runtime map

| File | Responsibility |
| --- | --- |
| `src/server.js` | HTTP routes, local SQLite schema, sessions, and role checks |
| `src/finance.js` | Integer money, tender, balance, and drawer rules |
| `src/paper.js` | Paper fields, people, slips, collections, and period totals |
| `web/index.html` | Login and application shell |
| `web/style.css`, `web/theme.css` | Base layout and visual theme |
| `web/api.js` | Browser HTTP client and response error handling |
| `web/app.js` | Role screens and interaction handlers |
| `web/paper-ui.js`, `web/paper.css` | Paper dashboard, entry screens, and styles |
| `scripts/seed-demo.js` | Optional local demo users and menu data |

The server listens on `127.0.0.1` by default. It serves browser files from `web/`
and JSON endpoints under `/api/`. The page links `style.css` and `theme.css` relative
to the app root; `app.js` imports `api.js` and `paper-ui.js`. All paths are explicitly allowed by the
static file handler in `src/server.js`.

The paper workflow uses `/api/paper/*` routes. Its tables are created additively on
startup, preserving older POS records. The dashboard does not mix the two ledgers.

## Accounts

An empty database creates the `admin` account from `CANTEEN_ADMIN_PASSWORD`.
Only an administrator can call `POST /api/users` or `PATCH /api/users/:id`. The browser
exposes these actions in **Accounts**. There is no public registration endpoint.

Account edits can change identity, role, section, credit limit, restrictions, active
state, and password. Resetting a password revokes that user's sessions. The API never
returns password hashes. The local database under `data/` is not committed to Git.

## API response contract

Every `/api/` success or failure returns JSON. The browser client reads the response
body once and reports a useful message for network failures, empty bodies, and invalid
JSON. `GET /api/health` returns `{ "status": "ok" }` without requiring login.

When debugging `Unexpected end of JSON input`, check these in order:

1. Start the server from the repository root: `node src/server.js`.
2. Open `http://127.0.0.1:3000/api/health`; it should show JSON.
3. Refresh the page fully after changing JavaScript files.
4. In the browser Network tab, inspect the failing `/api/` request's status and body.
5. Check the PowerShell window for a server exception.

HTTP 405 on `POST /api/login` usually means a static preview or Live Server is
handling the request. The app checks `/api/health` before enabling the login button
and displays a startup hint when the API is missing.

The browser client now shows an error message if the body is empty or not JSON rather
than exposing the browser's `Response.json()` exception.

## Checks

```powershell
node --test
node --check src/server.js
npm.cmd run format:check
```

Run `npm.cmd install` before the formatting check. Integration tests launch a separate
server with a temporary SQLite database and exercise login, account creation and
editing, checkout, debt settlement, reporting, voids, and static asset delivery.
