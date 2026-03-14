import { newId } from "./db.js";
/**
 * Emit an activity event into the activity_stream table.
 */
export async function emitActivity(event, db) {
    await db.query(`INSERT INTO activity_stream
     (id, developer_id, agent_id, session_id, workflow_id, event_type,
      subject_type, subject_id, subject_title, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [
        newId(),
        event.developer_id ?? null,
        event.agent_id ?? null,
        event.session_id ?? null,
        event.workflow_id ?? null,
        event.event_type,
        event.subject_type ?? null,
        event.subject_id ?? null,
        event.subject_title ?? null,
        event.detail ? JSON.stringify(event.detail) : null,
    ]);
}
/**
 * Prune activity events older than 30 days. Called on daemon start.
 */
export async function pruneActivityStream(db) {
    const result = await db.query(`WITH deleted AS (
       DELETE FROM activity_stream
       WHERE created_at < NOW() - INTERVAL '30 days'
       RETURNING id
     )
     SELECT COUNT(*) as count FROM deleted`);
    const count = parseInt(result.rows[0]?.count ?? "0");
    if (count > 0) {
        process.stderr.write(`[cph] Pruned ${count} activity events older than 30 days\n`);
    }
    return count;
}
//# sourceMappingURL=activity.js.map