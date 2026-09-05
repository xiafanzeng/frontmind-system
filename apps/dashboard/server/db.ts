import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { createPool } from "mysql2";
import { InsertUser, users } from "../drizzle/schema";
import { ENV } from "./_core/env";
import { resolveFrontMindRuntimeRole } from "./_core/runtime-role";

let _db: ReturnType<typeof drizzle> | null = null;

// Lazily create the drizzle instance so local tooling can run without a DB.
export async function getDb() {
  if (!_db && process.env.DATABASE_URL) {
    try {
      const pool = createPool({
        uri: process.env.DATABASE_URL,
        timezone: "Z",
        // The SiteOps process performs bounded, long-running projections and
        // must never consume the public web process' whole connection budget.
        connectionLimit:
          resolveFrontMindRuntimeRole() === "siteops-worker" ? 3 : 10,
        waitForConnections: true,
        queueLimit:
          resolveFrontMindRuntimeRole() === "siteops-worker" ? 24 : 96,
      });
      pool.on("connection", (connection) => {
        connection.query("SET SESSION time_zone = '+00:00'", (error) => {
          if (!error) return;
          console.error("[Database] UTC session initialization failed", {
            code: "DATABASE_UTC_SESSION_INIT_FAILED",
          });
          connection.destroy();
        });
      });
      _db = drizzle(pool);
    } catch (error) {
      console.warn("[Database] Failed to connect:", error);
      _db = null;
    }
  }
  return _db;
}

/** Close only the lazily-owned pool of a terminating one-shot maintenance CLI. */
export async function closeDbForOneShotMaintenance() {
  const db = _db;
  _db = null;
  if (!db) return;
  const client = db.$client as unknown as {
    end?: (callback: (error: Error | null) => void) => void;
  };
  if (typeof client.end !== "function") {
    throw new Error("DATABASE_CLIENT_CLOSE_UNAVAILABLE");
  }
  await new Promise<void>((resolve, reject) => {
    client.end!((error) => (error ? reject(error) : resolve()));
  });
}

export async function upsertUser(user: InsertUser): Promise<void> {
  if (!user.openId) {
    throw new Error("User openId is required for upsert");
  }

  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot upsert user: database not available");
    return;
  }

  try {
    const values: InsertUser = {
      openId: user.openId,
    };
    const updateSet: Record<string, unknown> = {};

    const textFields = ["name", "email", "loginMethod"] as const;
    type TextField = (typeof textFields)[number];

    const assignNullable = (field: TextField) => {
      const value = user[field];
      if (value === undefined) return;
      const normalized = value ?? null;
      values[field] = normalized;
      updateSet[field] = normalized;
    };

    textFields.forEach(assignNullable);

    if (user.lastSignedIn !== undefined) {
      values.lastSignedIn = user.lastSignedIn;
      updateSet.lastSignedIn = user.lastSignedIn;
    }
    if (user.role !== undefined) {
      values.role = user.role;
      updateSet.role = user.role;
    } else if (user.openId === ENV.ownerOpenId) {
      values.role = "admin";
      updateSet.role = "admin";
    }

    if (!values.lastSignedIn) {
      values.lastSignedIn = new Date();
    }

    if (Object.keys(updateSet).length === 0) {
      updateSet.lastSignedIn = new Date();
    }

    await db.insert(users).values(values).onDuplicateKeyUpdate({
      set: updateSet,
    });
  } catch (error) {
    console.error("[Database] Failed to upsert user:", error);
    throw error;
  }
}

export async function getUserByOpenId(openId: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db
    .select()
    .from(users)
    .where(eq(users.openId, openId))
    .limit(1);

  return result.length > 0 ? result[0] : undefined;
}

export async function getUserByUsername(username: string) {
  const db = await getDb();
  if (!db) {
    console.warn("[Database] Cannot get user: database not available");
    return undefined;
  }

  const result = await db
    .select()
    .from(users)
    .where(eq(users.username, username))
    .limit(1);

  return result[0];
}

// TODO: add feature queries here as your schema grows.
