import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Task } from "./types.ts";

function preview(text: string) {
  return text.length <= 120 ? text : `${text.slice(0, 119)}…`;
}

function summarizeTask(task: Task, refreshedRegistration?: string) {
  const replies = new Map(
    task.replies.map((reply) => [reply.questionId, reply.status]),
  );
  const unanswered = task.questions.filter(
    (question) =>
      !question.supersededBy && replies.get(question.id) !== "queued",
  );
  const uncertainReplies = task.replies.filter(
    (reply) => reply.status !== "queued",
  );
  const nextQuestion =
    task.status !== "completed" &&
    task.ownerPajSessionId === refreshedRegistration
      ? unanswered.find((question) => !replies.has(question.id))
      : undefined;
  return {
    taskId: task.id,
    worker: preview(task.target.name),
    freshness:
      task.ownerPajSessionId === refreshedRegistration
        ? "refreshed"
        : "last_known",
    status: task.status === "completed" ? "result_reported" : task.status,
    assignment: preview(task.assignment),
    requestEnqueue: task.requestMessageId
      ? "enqueue_confirmed"
      : task.status === "prepared"
        ? "prepared"
        : "unknown",
    unansweredQuestions: unanswered.length,
    questionsTruncated: task.questionsTruncated === true,
    nextQuestion: nextQuestion
      ? { id: nextQuestion.id, text: preview(nextQuestion.text) }
      : null,
    uncertainReplies: uncertainReplies.length,
    nextUncertainReply: uncertainReplies[0]
      ? {
          questionId: uncertainReplies[0].questionId,
          status: uncertainReplies[0].status,
        }
      : null,
    reportedOutcome: task.result ? preview(task.result.text) : null,
  };
}

export function renderTaskView(
  header: object,
  tasks: Task[],
  refreshedRegistration?: string,
  task?: Task,
) {
  const maxBytes = 32768;
  const value = task ?? tasks;
  const raw = JSON.stringify(value, null, 2);
  const bytes = Buffer.byteLength(raw);
  const summaries = tasks.map((item) =>
    summarizeTask(item, refreshedRegistration),
  );
  const needsAttention = (row: (typeof summaries)[number]) =>
    Number(
      row.unansweredQuestions > 0 ||
        row.uncertainReplies > 0 ||
        row.requestEnqueue !== "enqueue_confirmed",
    );
  summaries.sort((a, b) => needsAttention(b) - needsAttention(a));
  const encode = (shown: number, extra: object = {}) =>
    JSON.stringify(
      {
        ...header,
        totalTasks: summaries.length,
        shownTasks: shown,
        tasks: summaries.slice(0, shown),
        ...extra,
      },
      null,
      2,
    );
  const inline = encode(summaries.length, task ? { detail: task } : {});
  if (bytes <= maxBytes && Buffer.byteLength(inline) <= maxBytes) {
    return {
      content: [{ type: "text" as const, text: inline }],
      details: value,
    };
  }
  let fullOutputPath: string | undefined;
  try {
    const file = join(
      mkdtempSync(join(tmpdir(), "paj-captain-output-")),
      "result.json",
    );
    writeFileSync(file, raw, { mode: 0o600, flag: "wx" });
    fullOutputPath = file;
  } catch {
    /* The summary is still useful if detail cannot be written. */
  }
  const fallback = {
    truncated: true,
    bytes,
    ...(fullOutputPath && Buffer.byteLength(fullOutputPath) <= 4096
      ? { fullOutputPath }
      : { detailUnavailable: true }),
  };
  let shown = summaries.length;
  let text = encode(shown, fallback);
  while (Buffer.byteLength(text) > maxBytes && shown > 0)
    text = encode(--shown, fallback);
  return { content: [{ type: "text" as const, text }], details: fallback };
}
