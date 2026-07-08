/** Thin API client incl. an SSE-over-fetch reader for the chat stream. */

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export interface DocumentDto {
  id: string;
  title: string;
  byteSize: number;
  status: "queued" | "processing" | "ready" | "failed";
  error: string | null;
  createdAt: string;
}

export interface SourceDto {
  marker: number;
  chunkId: string;
  documentId: string;
  seq: number;
  preview: string;
  content: string;
}

export interface CitationDto {
  marker: number;
  chunkId: string;
  content: string | null;
  seq: number | null;
  documentId: string | null;
}

export interface MessageDto {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: CitationDto[];
  createdAt: string;
}

export class RateLimitError extends Error {
  constructor(public retryAfterSec: number) {
    super(`rate limited, retry in ${retryAfterSec}s`);
  }
}

export class AuthError extends Error {
  constructor() {
    super("session expired — please sign in again");
  }
}

/* ---------- session token ---------- */

const TOKEN_KEY = "docqa-token";
const USER_KEY = "docqa-user";

export function getSession(): { token: string; username: string } | null {
  const token = localStorage.getItem(TOKEN_KEY);
  const username = localStorage.getItem(USER_KEY);
  return token && username ? { token, username } : null;
}

export function setSession(token: string, username: string): void {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, username);
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem(TOKEN_KEY);
  return token ? { authorization: `Bearer ${token}` } : {};
}

export async function login(
  username: string,
  password: string,
): Promise<{ token: string; user: { username: string } }> {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { title?: string } | null;
    throw new Error(body?.title ?? "login failed");
  }
  return res.json();
}

async function ok(res: Response): Promise<Response> {
  if (res.status === 401) {
    clearSession();
    throw new AuthError();
  }
  if (res.status === 429) {
    throw new RateLimitError(Number(res.headers.get("retry-after") ?? 60));
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { title?: string } | null;
    throw new Error(body?.title ?? `request failed (${res.status})`);
  }
  return res;
}

export async function listDocuments(): Promise<DocumentDto[]> {
  return (await ok(await fetch(`${API_URL}/documents`, { headers: authHeaders() }))).json();
}

export async function uploadDocument(file: File): Promise<DocumentDto> {
  const form = new FormData();
  form.append("file", file);
  return (
    await ok(
      await fetch(`${API_URL}/documents`, { method: "POST", body: form, headers: authHeaders() }),
    )
  ).json();
}

export async function deleteDocument(id: string): Promise<void> {
  await ok(await fetch(`${API_URL}/documents/${id}`, { method: "DELETE", headers: authHeaders() }));
}

export interface ConversationDto {
  id: string;
  title: string | null;
  createdAt: string;
}

export async function listConversations(): Promise<ConversationDto[]> {
  return (await ok(await fetch(`${API_URL}/conversations`, { headers: authHeaders() }))).json();
}

export async function deleteConversation(id: string): Promise<void> {
  await ok(
    await fetch(`${API_URL}/conversations/${id}`, { method: "DELETE", headers: authHeaders() }),
  );
}

export async function createConversation(): Promise<{ id: string }> {
  return (
    await ok(
      await fetch(`${API_URL}/conversations`, {
        method: "POST",
        headers: { "content-type": "application/json", ...authHeaders() },
        body: "{}",
      }),
    )
  ).json();
}

export async function getConversation(
  id: string,
): Promise<{ id: string; messages: MessageDto[] } | null> {
  const res = await fetch(`${API_URL}/conversations/${id}`, { headers: authHeaders() });
  if (res.status === 404) return null;
  return (await ok(res)).json();
}

export async function getSuggestions(): Promise<string[]> {
  const res = await ok(await fetch(`${API_URL}/suggestions`, { headers: authHeaders() }));
  const body = (await res.json()) as { questions: string[] };
  return body.questions;
}

export interface StreamHandlers {
  onSources(sources: SourceDto[]): void;
  onToken(text: string): void;
  onDone(messageId: string): void;
  onDegraded(message: string): void;
}

export async function askQuestion(
  conversationId: string,
  question: string,
  handlers: StreamHandlers,
): Promise<void> {
  const res = await ok(
    await fetch(`${API_URL}/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...authHeaders() },
      body: JSON.stringify({ question }),
    }),
  );

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split("\n\n");
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      if (!block.startsWith("data: ")) continue;
      const event = JSON.parse(block.slice(6)) as
        | { type: "sources"; sources: SourceDto[] }
        | { type: "token"; text: string }
        | { type: "done"; messageId: string }
        | { type: "degraded"; message: string };
      if (event.type === "sources") handlers.onSources(event.sources);
      else if (event.type === "token") handlers.onToken(event.text);
      else if (event.type === "done") handlers.onDone(event.messageId);
      else if (event.type === "degraded") handlers.onDegraded(event.message);
    }
  }
}
