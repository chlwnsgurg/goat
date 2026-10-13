import type { OrchestrationV2CloudTask } from "@goat/contracts";
import { presentCloudTask } from "@goat/client-runtime/state/cloud-task";

export function CloudTaskStatus({ task }: { readonly task: OrchestrationV2CloudTask }) {
  const view = presentCloudTask(task);
  return (
    <section aria-label="Cloud task" className="mx-4 my-2 rounded-lg border p-3 text-sm">
      <p role="status">{view.label}</p>
      {task.title ? <p>{task.title}</p> : null}
      <p>Project files and terminal show the local source, not cloud changes.</p>
      <p className="text-muted-foreground">
        {task.source.repository} · {task.source.branch}
      </p>
      {task.localChangesExcluded ? <p>local changes are not included</p> : null}
      {task.progress ? <p>{task.progress}</p> : null}
      {task.summary ? <p className="whitespace-pre-wrap">{task.summary}</p> : null}
      {task.error ? <p role="alert">{task.error}</p> : null}
      {task.branch ? <p>Branch: {task.branch}</p> : null}
      <div className="flex gap-3">
        {view.taskUrl ? (
          <a href={view.taskUrl} target="_blank" rel="noopener noreferrer">
            Open cloud task
          </a>
        ) : null}
        {view.prUrl ? (
          <a href={view.prUrl} target="_blank" rel="noopener noreferrer">
            Open pull request
          </a>
        ) : null}
      </div>
    </section>
  );
}
