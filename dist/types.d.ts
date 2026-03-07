export type WorkflowStatus = "active" | "paused" | "completed" | "archived";
export type TaskStatus = "pending" | "in_progress" | "blocked" | "completed" | "cancelled";
export type TaskPriority = "low" | "medium" | "high" | "critical";
export type BlockerType = "dependency" | "waiting_on_human" | "technical" | "external" | "unclear_requirements" | "other";
export type BlockerStatus = "open" | "resolved" | "escalated";
export type RetrievalDepth = "minimal" | "standard" | "deep";
export interface Workflow {
    id: string;
    name: string;
    description: string | null;
    status: WorkflowStatus;
    git_branch_pattern: string | null;
    created_at: string;
    updated_at: string;
}
export interface Task {
    id: string;
    workflow_id: string;
    parent_task_id: string | null;
    title: string;
    description: string | null;
    completion_notes: string | null;
    status: TaskStatus;
    priority: TaskPriority;
    estimated_minutes: number | null;
    actual_minutes: number | null;
    started_at: string | null;
    completed_at: string | null;
    compressed: boolean;
    created_at: string;
    updated_at: string;
}
export interface Blocker {
    id: string;
    task_id: string | null;
    workflow_id: string;
    title: string;
    description: string | null;
    blocker_type: BlockerType;
    status: BlockerStatus;
    resolution: string | null;
    opened_at: string;
    resolved_at: string | null;
    resolution_minutes: number | null;
    created_at: string;
    updated_at: string;
}
export interface Decision {
    id: string;
    workflow_id: string;
    task_id: string | null;
    commit_hash: string | null;
    diff_stat: string | null;
    title: string;
    context: string | null;
    decision: string;
    rationale: string | null;
    alternatives_considered: string | null;
    trade_offs: string | null;
    tags: string | null;
    compressed: boolean;
    created_at: string;
    updated_at: string;
}
export interface EngineerPreference {
    id: string;
    engineer_id: string;
    retrieval_depth: RetrievalDepth;
    created_at: string;
    updated_at: string;
}
export interface WorkflowSummary extends Workflow {
    task_counts: {
        total: number;
        pending: number;
        in_progress: number;
        blocked: number;
        completed: number;
        cancelled: number;
    };
    open_blockers: number;
    decision_count: number;
    estimation_accuracy: number | null;
}
export interface SessionContext {
    workflow: Pick<Workflow, "id" | "name" | "status">;
    active_tasks: Pick<Task, "id" | "title" | "priority" | "status">[];
    open_blockers: Pick<Blocker, "id" | "title" | "blocker_type">[];
    recent_decisions: Pick<Decision, "id" | "title" | "decision">[];
    teammate_activity: TeammateActivity[];
    session_hint: string;
    retrieval_depth: RetrievalDepth;
}
export interface TeammateActivity {
    engineer_id: string;
    task_title: string;
    started_at: string;
}
export interface GitContext {
    branch: string | null;
    recent_files: string[];
    repo_root: string | null;
    engineer_id: string | null;
}
export interface PaginatedResult<T> {
    items: T[];
    total: number;
    offset: number;
    limit: number;
    has_more: boolean;
}
//# sourceMappingURL=types.d.ts.map