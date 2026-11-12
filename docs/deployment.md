# Deploy the Canteen Ledger PWA on Render

The application needs a Node web service and persistent storage for its SQLite
database. A static host or an ephemeral filesystem will not preserve canteen records.

## Create the service

1. Sign in to Render and select **New → Web Service**.
2. Connect the GitHub repository `adrianjoseph840-ship-it/Grocery-Store-Management-System`.
3. Select the `main` branch and Node runtime.
4. Use `npm install` as the build command and `npm start` as the start command.
5. Choose a paid service plan that supports a persistent disk.
6. In **Advanced**, add a disk named `canteen-data`, mount it at
   `/opt/render/project/src/data`, and start with the smallest suitable size.
7. Set the health check path to `/api/health`.

## Environment variables

Add these variables in the Render dashboard:

| Variable | Value |
| --- | --- |
| `HOST` | `0.0.0.0` |
| `CANTEEN_DATA_DIR` | `/opt/render/project/src/data` |
| `COOKIE_SECURE` | `1` |
| `CANTEEN_ADMIN_PASSWORD` | A unique password of at least 12 characters |

`PORT` is supplied by Render. Do not set it manually unless Render support asks you
to do so. The administrator password is used only when the persistent database is
created for the first time.

## Deploy and install

1. Select **Create Web Service** and wait for the health check to pass.
2. Open the assigned `https://...onrender.com` address.
3. Log in as `admin` with the administrator password configured above.
4. On Android Chrome, open the browser menu and select **Install app**.
5. On iPhone Safari, select **Share → Add to Home Screen**.

## Existing local database

For a new empty online system, no transfer is required. To retain local records, stop
the local and hosted services before copying `data/canteen.sqlite` to the persistent
disk. Copy the database together with any `canteen.sqlite-wal` and
`canteen.sqlite-shm` files if they exist, then restart the hosted service. Never copy a
SQLite database while the application is writing to it.

## Backups

Render disk snapshots provide platform recovery, but periodically download a separate
copy of the SQLite database while the service is stopped. Test restoring a backup
before relying on it for financial records.
