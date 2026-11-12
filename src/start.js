await import(process.env.DATABASE_URL ? "./server-postgres.js" : "./server.js");
