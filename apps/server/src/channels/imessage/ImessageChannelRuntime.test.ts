// @effect-diagnostics nodeBuiltinImport:off -- synthetic SQLite and filesystem fixture only.
import * as NodeSqlite from "node:sqlite";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ChannelGatewayError,
  type ChannelIdentityLinkConsumeInput,
  type ChannelInboundMessage,
  type ChannelIngestResult,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as ChannelLedger from "../ChannelLedger.ts";
import * as ChannelGateway from "../ChannelGateway.ts";
import * as ChannelBotHome from "../ChannelBotHome.ts";
import * as ChannelTransport from "../ChannelTransport.ts";
import { deliveryIdFor } from "../channelIds.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { IMESSAGE_SETTINGS_FILE, type ImessageSettingsFile } from "./ImessageChannelSettings.ts";
import { makeImessageChannelRuntime } from "./ImessageChannelRuntime.ts";

const file: ImessageSettingsFile = {
  version: 1,
  enabled: true,
  connectionId: "imessage-000000000001",
  allowedHandles: ["+15550000000"],
  ownHandles: [],
  owner: {
    ownerId: "owner",
    principalId: "local-cli",
    displayName: "Owner",
    grantedScopes: ["orchestration:operate"],
    runtimeModeCeiling: "approval-required",
  },
};

describe("iMessage owner poll", () => {
  it.effect("starts at max, checkpoints skips and admits only new direct text", () =>
    Effect.gen(function* () {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-imsg-poll-"));
      const path = NodePath.join(dir, "fixture.sqlite");
      const writer = new NodeSqlite.DatabaseSync(path);
      try {
        NodeFS.writeFileSync(NodePath.join(dir, IMESSAGE_SETTINGS_FILE), JSON.stringify(file));
        writer.exec(`CREATE TABLE message (guid TEXT, text TEXT, attributedBody BLOB, handle_id INTEGER,
        is_from_me INTEGER, date INTEGER, date_read INTEGER, cache_roomnames TEXT,
        associated_message_type INTEGER, item_type INTEGER, balloon_bundle_id TEXT);
        CREATE TABLE handle (id TEXT, service TEXT);
        CREATE TABLE chat (guid TEXT, chat_identifier TEXT, style INTEGER);
        CREATE TABLE chat_message_join (message_id INTEGER, chat_id INTEGER);
        INSERT INTO handle VALUES ('+15550000000','iMessage');
        INSERT INTO chat VALUES ('iMessage;-;+15550000000','+15550000000',45);`);
        const insert = (id: string, own = 0, text = id, joined = true) => {
          const row = writer
            .prepare(
              "INSERT INTO message (guid,text,handle_id,is_from_me,date,item_type) VALUES (?,?,?,?,?,?)",
            )
            .run(id, text, 1, own, 0, 0);
          if (joined)
            writer.prepare("INSERT INTO chat_message_join VALUES (?,1)").run(row.lastInsertRowid);
          return Number(row.lastInsertRowid);
        };
        insert("history");
        const accepted: ChannelInboundMessage[] = [];
        let clock = 1_000_000;
        const layer = Layer.mergeAll(
          ChannelLedger.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
          ChannelTransport.layer,
        ).pipe(Layer.provide(NodeServices.layer));
        yield* Effect.gen(function* () {
          const ledger = yield* ChannelLedger.ChannelLedger;
          yield* ledger.claimOwnership({
            token: "owner-a",
            now: "2026-10-19T00:00:00.000Z",
            staleBefore: "2026-10-18T00:00:00.000Z",
          });
          const gateway = {
            ingest: (message: ChannelInboundMessage) =>
              Effect.gen(function* () {
                if (message.externalMessageId === "failed")
                  return yield* new ChannelGatewayError({ reason: "persistence_failed" });
                accepted.push(message);
                return {} as ChannelIngestResult;
              }),
            linkIdentity: (message: ChannelIdentityLinkConsumeInput) =>
              Effect.gen(function* () {
                const causeKey = "link:" + message.connectionId + ":" + message.idempotencyKey;
                const deliveryId = deliveryIdFor(causeKey);
                yield* ledger.enqueueDeliveries(
                  [
                    {
                      deliveryId,
                      causeKey,
                      message: {
                        deliveryId,
                        destination: message.replyAddress,
                        kind: "receipt",
                        text: "Invalid link",
                      },
                    },
                  ],
                  "2026-10-19T00:00:00.000Z",
                );
                return yield* new ChannelGatewayError({ reason: "forbidden" });
              }),
          } as unknown as ChannelGateway.ChannelGateway["Service"];
          let homeAvailable = true;
          const home = {
            requireHome: Effect.suspend(() =>
              homeAvailable
                ? Effect.void
                : Effect.fail(new ChannelGatewayError({ reason: "not_home" })),
            ),
          } as ChannelBotHome.ChannelBotHome["Service"];
          const registry = yield* ChannelTransport.ChannelTransportRegistry;
          const scope = yield* Scope.make();
          const runtime = makeImessageChannelRuntime({
            stateDir: dir,
            platform: "darwin",
            dbPath: path,
            ledger,
            gateway,
            home,
            registry,
            scope,
            now: () => clock,
          });
          expect(yield* runtime.pollDue("owner-a")).toBe(0);
          expect(Option.isSome(yield* registry.resolve("imessage"))).toBe(true);
          expect((yield* ledger.getImessageCursor(file.connectionId))?.cursor).toBe(1);
          insert("own", 1);
          insert("new");
          clock += 5_000;
          expect(yield* runtime.pollDue("owner-a")).toBe(2);
          expect(accepted.map((message) => message.externalMessageId)).toEqual(["new"]);
          expect((yield* ledger.getImessageCursor(file.connectionId))?.cursor).toBe(3);
          insert("bad-link", 0, "link 000000");
          insert("after");
          clock += 5_000;
          expect(yield* runtime.pollDue("owner-a")).toBe(2);
          expect(accepted.map((message) => message.externalMessageId)).toEqual(["new", "after"]);
          expect((yield* ledger.getImessageCursor(file.connectionId))?.cursor).toBe(5);
          const late = insert("late", 0, "late", false);
          clock += 5_000;
          expect(yield* runtime.pollDue("owner-a")).toBe(1);
          expect((yield* ledger.getImessageCursor(file.connectionId))?.pendingRowIds).toEqual([
            late,
          ]);
          writer.prepare("INSERT INTO chat_message_join VALUES (?,1)").run(late);
          clock += 5_000;
          expect(yield* runtime.pollDue("owner-a")).toBe(1);
          expect(accepted.map((message) => message.externalMessageId)).toEqual([
            "new",
            "after",
            "late",
          ]);
          expect((yield* ledger.getImessageCursor(file.connectionId))?.pendingRowIds).toEqual([]);
          insert("failed");
          clock += 5_000;
          expect((yield* Effect.result(runtime.pollDue("owner-a")))._tag).toBe("Failure");
          expect((yield* ledger.getImessageCursor(file.connectionId))?.cursor).toBe(late);
          homeAvailable = false;
          clock += 5_000;
          expect(yield* runtime.pollDue("owner-a")).toBe(0);
          const transport = Option.getOrThrow(yield* registry.resolve("imessage"));
          const blocked = yield* Effect.result(
            transport.send({
              deliveryId: "delivery" as never,
              destination: {
                kind: "imessage",
                connectionId: file.connectionId,
                chatGuid: "iMessage;-;+15550000000",
              },
              kind: "receipt",
              text: "No real send",
            }),
          );
          expect(blocked._tag).toBe("Failure");
          yield* Scope.close(scope, Exit.void);
          expect(Option.isNone(yield* registry.resolve("imessage"))).toBe(true);
          const otherScope = yield* Scope.make();
          const nonMac = makeImessageChannelRuntime({
            stateDir: dir,
            platform: "linux",
            dbPath: path,
            ledger,
            gateway,
            home,
            registry,
            scope: otherScope,
            now: () => clock,
          });
          expect(yield* nonMac.pollDue("owner-a")).toBe(0);
          expect(Option.isNone(yield* registry.resolve("imessage"))).toBe(true);
          yield* Scope.close(otherScope, Exit.void);
          NodeFS.writeFileSync(
            NodePath.join(dir, IMESSAGE_SETTINGS_FILE),
            JSON.stringify({ ...file, enabled: false }),
          );
          homeAvailable = true;
          expect(yield* runtime.pollDue("owner-a")).toBe(0);
          clock += 5_000;
          expect(yield* runtime.pollDue("other-owner")).toBe(0);
        }).pipe(Effect.provide(layer), Effect.scoped);
      } finally {
        writer.close();
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }
    }),
  );
});
