// @effect-diagnostics nodeBuiltinImport:off -- synthetic SQLite file fixture only.
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { classifyImessageDbError, openImessageChatDb } from "./imessageChatDb.ts";

describe("iMessage read-only chat database", () => {
  it("orders rows, bounds scans, and counts joins without write access", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-imsg-db-"));
    const path = NodePath.join(dir, "fixture.sqlite");
    try {
      const writer = new NodeSqlite.DatabaseSync(path);
      writer.exec(`CREATE TABLE message (guid TEXT, text TEXT, attributedBody BLOB, handle_id INTEGER,
        is_from_me INTEGER, date INTEGER, date_read INTEGER, cache_roomnames TEXT,
        associated_message_type INTEGER, item_type INTEGER, balloon_bundle_id TEXT);
        CREATE TABLE handle (id TEXT, service TEXT);
        CREATE TABLE chat (guid TEXT, chat_identifier TEXT, style INTEGER);
        CREATE TABLE chat_message_join (message_id INTEGER, chat_id INTEGER);`);
      writer.exec(
        "INSERT INTO handle VALUES ('+15550000000','iMessage'); INSERT INTO chat VALUES ('iMessage;-;+15550000000','+15550000000',45);",
      );
      for (let i = 1; i <= 3; i++)
        writer
          .prepare(
            "INSERT INTO message (guid,text,handle_id,is_from_me,date,item_type) VALUES (?,?,?,?,?,?)",
          )
          .run("g" + i, "hello", 1, 0, 0, 0);
      writer.exec(
        "INSERT INTO chat_message_join VALUES (2,1); INSERT INTO chat_message_join VALUES (3,1); INSERT INTO chat_message_join VALUES (3,1);",
      );
      writer.close();
      const reader = openImessageChatDb(path);
      expect(reader.maxRowId()).toBe(3);
      expect(reader.rowsAfter(0, 2).map((row) => row.rowid)).toEqual([1, 2]);
      expect(reader.rowById(1)?.chat_join_count).toBe(0);
      expect(reader.rowById(2)?.chat_join_count).toBe(1);
      expect(reader.rowById(3)?.chat_join_count).toBe(2);
      const readonly = new NodeSqlite.DatabaseSync(path, { readOnly: true });
      expect(() => readonly.exec("DELETE FROM message")).toThrow();
      readonly.close();
      reader.close();
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
  it("classifies inaccessible and unsupported schema separately", () => {
    expect(classifyImessageDbError({ code: "EACCES" })).toBe("database_unavailable");
    expect(classifyImessageDbError(new Error("no such column: h.service"))).toBe(
      "schema_unsupported",
    );
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-imsg-schema-"));
    const path = NodePath.join(dir, "empty.sqlite");
    try {
      const writer = new NodeSqlite.DatabaseSync(path);
      writer.close();
      expect(() => openImessageChatDb(path)).toThrow("schema_unsupported");
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});
