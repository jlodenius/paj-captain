export interface WorkspacePolicy {
  allow: readonly string[];
  exclude: readonly string[];
}

export interface CaptainConfig {
  version: 1;
  workspaces: { allow: string[]; exclude: string[] };
  reporting: { progress: boolean; verbosity: "brief" | "detailed" };
}

export interface PajSession {
  id: string;
  name: string;
  piSessionId?: string | null;
  parentPiSessionId?: string | null;
  role: string;
  projectId: string;
  projectRoot: string;
  status: "idle" | "busy";
}

export type MessageKind =
  "request" | "question" | "answer" | "update" | "result";

export interface PajMessage {
  id: string;
  from: { id: string; name: string };
  to: string;
  text: string;
  kind: MessageKind;
  createdAtMs: number;
  taskId?: string;
  inReplyTo?: string;
  senderTaskId?: string | null;
  recipientTaskId?: string | null;
  supersedes?: string;
  supersededBy?: string;
}

export type DeliveryStatus = "prepared" | "queued" | "delivery_unknown";
export type TaskStatus = DeliveryStatus | "waiting_for_answer" | "completed";

export interface TaskReply {
  questionId: string;
  text: string;
  status: DeliveryStatus;
  createdAtMs: number;
  messageId?: string;
  deliveryError?: string;
}

export interface Task {
  id: string;
  requestId: string;
  ownerPiSessionId: string;
  ownerPajSessionId: string;
  target: PajSession;
  assignment: string;
  status: TaskStatus;
  createdAtMs: number;
  updatedAtMs: number;
  requestMessageId: string | null;
  questions: PajMessage[];
  events: PajMessage[];
  replies: TaskReply[];
  result: PajMessage | null;
  seenMessageIds: string[];
  questionsTruncated?: boolean;
  deliveryError?: string;
}

export interface PajCheckpoint {
  registration: string;
  cursor: string;
}

export interface Ledger {
  version: 1;
  tasks: Task[];
  pajCheckpoints?: PajCheckpoint[];
}

export interface LaunchRequest {
  workspace: string;
  name?: string;
  model?: string;
  requestId: string;
}

export interface LaunchPayload {
  workspace: string;
  policy: WorkspacePolicy;
  home: string;
  agentName: string;
  model?: string;
  piExecutable: string;
  environment: NodeJS.ProcessEnv;
}

export interface CommandResult {
  stdout: string;
  stderr?: string;
  exitCode?: number;
  exit_code?: number;
}

export type RunCommand = (
  command: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    cwd?: string;
    timeout: number;
    maxBuffer: number;
    encoding?: "utf8";
  },
) => Promise<CommandResult>;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function errorCode(error: unknown): string {
  return isRecord(error) && typeof error.code === "string" ? error.code : "";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
