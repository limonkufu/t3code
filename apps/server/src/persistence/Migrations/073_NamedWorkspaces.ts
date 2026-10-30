import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE named_workspace_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      command_id TEXT NOT NULL UNIQUE,
      workspace_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      state_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX idx_named_workspace_latest
    ON named_workspace_events (workspace_id, sequence DESC)
  `;
});
