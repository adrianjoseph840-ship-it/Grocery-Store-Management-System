# Active account database

The running app stores accounts in `data/canteen.sqlite`, or in the folder named by
`CANTEEN_DATA_DIR` if that variable is set. The account table is `users`. Its
important columns are:

| Column | Meaning |
| --- | --- |
| `name` | Person's full name |
| `username` | Email or username used to sign in |
| `password_hash` | One-way hash of the password, never plain text |
| `role` | ADMIN, CASHIER, GUARD, or BUYER |
| `active` | Whether the account can sign in |
| `must_change_password` | 1 until the person chooses their own password |

Create an account manually with `node scripts/create-account.js`. The command
asks for the email or username, name, role, and temporary password. It saves a password hash
and sets `must_change_password` to 1. Use a different temporary password for each
person. To check accounts, use `node scripts/list-accounts.js`. The password
cannot be recovered; set a new temporary password through the admin Accounts
screen if someone forgets it.

`docs/schema.sql` is an older PostgreSQL design reference and is not executed
by this app. Do not use a Microsoft SQL Server extension to execute that file.
