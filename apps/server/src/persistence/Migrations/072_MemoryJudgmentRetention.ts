import * as M from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE memory_payloads AS p SET
    resolved_at=coalesce(resolved_at,(SELECT applied_at FROM memory_resolutions r WHERE r.space=p.space AND r.judgment_payload_ref=p.payload_ref)),
    revert_deadline=coalesce(revert_deadline,(SELECT revert_deadline FROM memory_resolutions r WHERE r.space=p.space AND r.judgment_payload_ref=p.payload_ref)),
    purge_eligible_after=(SELECT applied_at+${M.MEMORY_REPLACED_PAYLOAD_RETENTION_MS} FROM memory_resolutions r WHERE r.space=p.space AND r.judgment_payload_ref=p.payload_ref)
    WHERE purge_eligible_after IS NULL AND EXISTS (SELECT 1 FROM memory_resolutions r WHERE r.space=p.space AND r.judgment_payload_ref=p.payload_ref)`;
});
