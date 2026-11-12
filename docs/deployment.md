# Free deployment with Render and Supabase

The hosted application uses a free Render Node web service and a free Supabase
PostgreSQL database. Local development continues to use SQLite unless `DATABASE_URL`
is set.

## 1. Create the free Supabase database

1. Create a Supabase account and a new free project.
2. Save the database password securely.
3. In the project dashboard, select **Connect**.
4. Choose **Session pooler** and copy its connection string.
5. Replace `[YOUR-PASSWORD]` with the database password. Percent-encode characters
   such as `@`, `#`, `?`, `&`, `%`, and spaces if they appear in the password.

Do not put this connection string in GitHub or any project file.

## 2. Create the free Render service

1. In Render, select **New → Web Service**.
2. Connect `adrianjoseph840-ship-it/Grocery-Store-Management-System`.
3. Select branch `main`, runtime **Node**, and the **Free** service plan.
4. Use `npm install` as the build command and `npm start` as the start command.
5. Set the health check path to `/api/health`.
6. Add these environment variables:

| Variable | Value |
| --- | --- |
| `HOST` | `0.0.0.0` |
| `DATABASE_URL` | The Supabase **Session pooler** connection string |
| `CANTEEN_ADMIN_PASSWORD` | A unique password of at least 12 characters |

Render supplies `PORT`. Do not add a persistent disk or `CANTEEN_DATA_DIR` for this
PostgreSQL deployment.

## 3. First deployment

Select **Create Web Service**. The application creates its PostgreSQL tables and the
first `admin` account automatically. When `/api/health` succeeds, open the assigned
`https://...onrender.com` address and log in as `admin`.

## 4. Copy existing local records (optional)

The hosted service must complete its first deployment before this step so its tables
exist. Stop the local server, then in PowerShell set the same Supabase connection
string and run the migration:

```powershell
$env:DATABASE_URL = "paste-session-pooler-connection-string"
npm.cmd run db:migrate:postgres
Remove-Item Env:DATABASE_URL
```

The migration copies existing accounts, departments, people, slips, collections, and
audit records. Existing PostgreSQL rows are not overwritten. Do this once.

## 5. Install on a phone

- Android Chrome: browser menu → **Install app**.
- iPhone Safari: **Share → Add to Home Screen**.

## Free-tier limitations

Render sleeps an inactive free web service, so the first request after inactivity can
take approximately a minute. Supabase may pause an inactive free project. Data is in
PostgreSQL and therefore does not disappear when the Render service sleeps, restarts,
or redeploys. Free Supabase projects do not include automatic backups, so export the
database regularly.
