import * as NodeSqlite from "node:sqlite";

export interface ImessageRow {
  readonly rowid: number;
  readonly guid: string | null;
  readonly text: string | null;
  readonly attributedBody: Uint8Array | null;
  readonly handle_id: number | null;
  readonly is_from_me: number;
  readonly date: number;
  readonly date_read: number | null;
  readonly cache_roomnames: string | null;
  readonly associated_message_type: number | null;
  readonly item_type: number | null;
  readonly balloon_bundle_id: string | null;
  readonly sender_handle: string | null;
  readonly sender_service: string | null;
  readonly chat_rowid: number | null;
  readonly chat_guid: string | null;
  readonly chat_identifier: string | null;
  readonly style: number | null;
  readonly chat_join_count: number;
}

export interface ImessageChatDb {
  readonly maxRowId: () => number;
  readonly rowsAfter: (cursor: number, limit: number) => ReadonlyArray<ImessageRow>;
  readonly rowById: (rowId: number) => ImessageRow | undefined;
  readonly close: () => void;
}

const select = `SELECT m.ROWID AS rowid, m.guid, m.text, m.attributedBody, m.handle_id,
  m.is_from_me, m.date, m.date_read, m.cache_roomnames, m.associated_message_type,
  m.item_type, m.balloon_bundle_id, h.id AS sender_handle, h.service AS sender_service,
  c.ROWID AS chat_rowid, c.guid AS chat_guid, c.chat_identifier, c.style,
  (SELECT COUNT(*) FROM chat_message_join AS j WHERE j.message_id = m.ROWID) AS chat_join_count
  FROM message AS m
  LEFT JOIN handle AS h ON h.ROWID = m.handle_id
  LEFT JOIN chat AS c ON c.ROWID = (
    SELECT MIN(j.chat_id) FROM chat_message_join AS j WHERE j.message_id = m.ROWID
  )`;

export class ImessageDbError extends Error {
  readonly category: "database_unavailable" | "schema_unsupported" | "query_failed";
  constructor(category: "database_unavailable" | "schema_unsupported" | "query_failed") {
    super("iMessage database " + category);
    this.category = category;
  }
}

export function classifyImessageDbError(cause: unknown): ImessageDbError["category"] {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : "";
  const message = cause instanceof Error ? cause.message : "";
  if (
    /EACCES|EPERM|SQLITE_CANTOPEN/.test(code) ||
    /unable to open|authorization denied/i.test(message)
  )
    return "database_unavailable";
  if (/no such table|no such column/i.test(message)) return "schema_unsupported";
  return "query_failed";
}

export function openImessageChatDb(path: string): ImessageChatDb {
  let db: NodeSqlite.DatabaseSync | undefined;
  try {
    db = new NodeSqlite.DatabaseSync(path, { readOnly: true });
    db.prepare("SELECT MAX(ROWID) AS max FROM message").get();
  } catch (cause) {
    db?.close();
    throw new ImessageDbError(classifyImessageDbError(cause));
  }
  const connection = db;
  const query = <T>(run: () => T): T => {
    try {
      return run();
    } catch (cause) {
      throw new ImessageDbError(classifyImessageDbError(cause));
    }
  };
  return {
    maxRowId: () =>
      query(() =>
        Number(
          (
            connection.prepare("SELECT MAX(ROWID) AS max FROM message").get() as {
              max: number | null;
            }
          ).max ?? 0,
        ),
      ),
    rowsAfter: (cursor, limit) =>
      query(
        () =>
          connection
            .prepare(select + " WHERE m.ROWID > ? ORDER BY m.ROWID ASC LIMIT ?")
            .all(cursor, limit) as unknown as ImessageRow[],
      ),
    rowById: (rowId) =>
      query(
        () =>
          connection.prepare(select + " WHERE m.ROWID = ?").get(rowId) as unknown as
            | ImessageRow
            | undefined,
      ),
    close: () => connection.close(),
  };
}
