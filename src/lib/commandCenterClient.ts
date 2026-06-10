// HTTP client for the Group Command Center task API.
// Base + key come from Vite env (VITE_-prefixed so they're exposed to client code).

const BASE_URL =
  (import.meta.env.VITE_COMMAND_CENTER_API_URL as string | undefined) ??
  "http://localhost:4501";
const API_KEY = import.meta.env.VITE_COMMAND_CENTER_API_KEY as string | undefined;

export type CommandCenterTask = {
  id: string;
  title: string;
  description?: string;
  business: string;
  agent?: string;
  source: string;
  escalation?: string;
  status?: string;
  assignedTo?: string;
  subject?: string;
  bodyText?: string;
  bodyHtml?: string;
  externalUrl?: string;
  proNumber?: string;
  notes?: string;
  receivedAt?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type ListTasksParams = {
  business?: string;
  assignedTo?: string;
  status?: string;
};

export type CreateTaskInput = {
  title: string;
  description?: string;
  business: string;
  agent?: string;
  source: string;
  escalation?: string;
  status?: string;
  assignedTo?: string;
  subject?: string;
  bodyText?: string;
  bodyHtml?: string;
  externalUrl?: string;
  proNumber?: string;
  notes?: string;
  receivedAt?: string;
};

export type TaskPatch = {
  status?: string;
  assignedTo?: string;
  notes?: string;
  builtLoadId?: string;
  proNumber?: string;
  actorName?: string;
  reassignedTo?: string;
};

function headers(extra?: Record<string, string>): HeadersInit {
  const h: Record<string, string> = { ...(extra ?? {}) };
  if (API_KEY) h["X-Api-Key"] = API_KEY;
  return h;
}

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`commandCenter ${res.status} ${res.statusText}: ${text}`);
  }
  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

export async function listTasks(
  params: ListTasksParams = {},
): Promise<CommandCenterTask[]> {
  const business = params.business ?? "bcat";
  const qs = new URLSearchParams();
  qs.set("business", business);
  if (params.assignedTo) qs.set("assignedTo", params.assignedTo);
  if (params.status) qs.set("status", params.status);
  const res = await fetch(`${BASE_URL}/api/tasks?${qs.toString()}`, {
    headers: headers(),
  });
  return asJson<CommandCenterTask[]>(res);
}

export async function getTask(id: string): Promise<CommandCenterTask> {
  const res = await fetch(`${BASE_URL}/api/tasks/${encodeURIComponent(id)}`, {
    headers: headers(),
  });
  return asJson<CommandCenterTask>(res);
}

export async function createTask(
  input: CreateTaskInput,
): Promise<CommandCenterTask> {
  const res = await fetch(`${BASE_URL}/api/tasks`, {
    method: "POST",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify(input),
  });
  return asJson<CommandCenterTask>(res);
}

export async function updateTask(
  id: string,
  patch: TaskPatch,
): Promise<CommandCenterTask> {
  const res = await fetch(`${BASE_URL}/api/tasks/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: headers({ "Content-Type": "application/json" }),
    body: JSON.stringify(patch),
  });
  return asJson<CommandCenterTask>(res);
}

export async function deleteTask(id: string): Promise<void> {
  const res = await fetch(`${BASE_URL}/api/tasks/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: headers(),
  });
  await asJson<void>(res);
}
