"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  listDocuments,
  uploadDocument,
  deleteDocument,
  listConversations,
  createConversation,
  getConversation,
  deleteConversation,
  askQuestion,
  getSuggestions,
  login,
  getSession,
  setSession,
  clearSession,
  RateLimitError,
  AuthError,
  type DocumentDto,
  type SourceDto,
  type ConversationDto,
} from "../lib/api";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  sources?: SourceDto[];
  degraded?: string;
}

const THEME_KEY = "docqa-theme";

/** Render [n] citation markers as styled badges. */
function renderContent(text: string) {
  const parts = text.split(/(\[\d{1,2}\])/g);
  return parts.map((part, i) => {
    const m = part.match(/^\[(\d{1,2})\]$/);
    return m ? (
      <sup className="cite" key={i}>
        {m[1]}
      </sup>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    );
  });
}

function LoginCard({ onSuccess }: { onSuccess: (username: string) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await login(username.trim(), password);
      setSession(res.token, res.user.username);
      onSuccess(res.user.username);
    } catch (err) {
      setError(err instanceof Error ? err.message : "login failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="login-card" onSubmit={onSubmit}>
        <h1>
          <span className="logo">◆</span> DocQA
        </h1>
        <p className="tagline">Sign in to your workspace.</p>
        <input
          placeholder="Username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoFocus
        />
        <input
          placeholder="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <div className="login-error">{error}</div>}
        <button className="primary" type="submit" disabled={busy || !username || !password}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
        <p className="demo-hint">
          Demo accounts: <code>alice</code>, <code>bob</code>, or <code>charlie</code> — password{" "}
          <code>demo1234</code>
        </p>
      </form>
    </div>
  );
}

export default function Home() {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<string | null>(null);
  const [documents, setDocuments] = useState<DocumentDto[]>([]);
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [activeConvo, setActiveConvo] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const bottomRef = useRef<HTMLDivElement>(null);

  function logout() {
    clearSession();
    setUser(null);
    setDocuments([]);
    setConversations([]);
    setMessages([]);
    setActiveConvo(null);
  }

  const guard = useCallback((err: unknown, fallback: string) => {
    if (err instanceof AuthError) {
      logout();
      return;
    }
    setBanner(err instanceof Error ? err.message : fallback);
  }, []);

  const refreshDocuments = useCallback(async () => {
    try {
      setDocuments(await listDocuments());
      setBanner((b) => (b === "API unreachable — is the server running?" ? null : b));
    } catch (err) {
      if (err instanceof AuthError) logout();
      else setBanner("API unreachable — is the server running?");
    }
  }, []);

  const refreshConversations = useCallback(async () => {
    try {
      setConversations(await listConversations());
    } catch (err) {
      if (err instanceof AuthError) logout();
    }
  }, []);

  useEffect(() => {
    setTheme((document.documentElement.dataset.theme as "light" | "dark") ?? "dark");
    const session = getSession();
    if (session) setUser(session.username);
    setReady(true);
  }, []);

  useEffect(() => {
    if (!user) return;
    void refreshDocuments();
    void refreshConversations();
  }, [user, refreshDocuments, refreshConversations]);

  function toggleTheme() {
    const next = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.dataset.theme = next;
    localStorage.setItem(THEME_KEY, next);
  }

  // Poll while any document is still ingesting.
  useEffect(() => {
    if (!documents.some((d) => d.status === "queued" || d.status === "processing")) return;
    const t = setTimeout(() => void refreshDocuments(), 2500);
    return () => clearTimeout(t);
  }, [documents, refreshDocuments]);

  // Refresh suggested questions once all ingestion has settled.
  useEffect(() => {
    if (!user) return;
    if (!documents.some((d) => d.status === "ready")) {
      setSuggestions([]);
      return;
    }
    if (documents.some((d) => d.status === "queued" || d.status === "processing")) return;
    void getSuggestions().then(setSuggestions).catch(() => setSuggestions([]));
  }, [user, documents]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  function newChat() {
    setActiveConvo(null);
    setMessages([]);
    setBanner(null);
  }

  async function openConversation(id: string) {
    if (streaming) return;
    setBanner(null);
    try {
      const convo = await getConversation(id);
      if (!convo) {
        await refreshConversations();
        return;
      }
      setActiveConvo(id);
      setMessages(convo.messages.map((m) => ({ role: m.role, content: m.content })));
    } catch (err) {
      guard(err, "failed to load conversation");
    }
  }

  async function removeConversation(id: string) {
    await deleteConversation(id).catch(() => {});
    if (id === activeConvo) newChat();
    await refreshConversations();
  }

  async function onUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setBanner(null);
    try {
      await uploadDocument(file);
      await refreshDocuments();
    } catch (err) {
      guard(err, "upload failed");
    }
  }

  async function ask(qRaw: string) {
    const q = qRaw.trim();
    if (!q || streaming) return;
    setQuestion("");
    setBanner(null);
    setStreaming(true);
    setMessages((m) => [...m, { role: "user", content: q }, { role: "assistant", content: "" }]);

    try {
      let convoId = activeConvo;
      if (!convoId) {
        const convo = await createConversation();
        convoId = convo.id;
        setActiveConvo(convoId);
      }
      await askQuestion(convoId, q, {
        onSources: (sources) =>
          setMessages((m) => {
            const copy = [...m];
            copy[copy.length - 1] = { ...copy[copy.length - 1]!, sources };
            return copy;
          }),
        onToken: (text) =>
          setMessages((m) => {
            const copy = [...m];
            const last = copy[copy.length - 1]!;
            copy[copy.length - 1] = { ...last, content: last.content + text };
            return copy;
          }),
        onDone: () => {},
        onDegraded: (message) =>
          setMessages((m) => {
            const copy = [...m];
            copy[copy.length - 1] = { ...copy[copy.length - 1]!, degraded: message };
            return copy;
          }),
      });
      await refreshConversations(); // pick up the auto-title
    } catch (err) {
      setMessages((m) => m.slice(0, -1)); // drop empty assistant bubble
      if (err instanceof RateLimitError) {
        setBanner(`Rate limit reached — try again in ${Math.ceil(err.retryAfterSec / 60)} min.`);
      } else {
        guard(err, "request failed");
      }
    } finally {
      setStreaming(false);
    }
  }

  function onAsk(e: React.FormEvent) {
    e.preventDefault();
    void ask(question);
  }

  if (!ready) return null;
  if (!user) return <LoginCard onSuccess={(u) => setUser(u)} />;

  const lastIdx = messages.length - 1;

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">
          <h1>
            <span className="logo">◆</span> DocQA
          </h1>
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            type="button"
          >
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
        </div>
        <p className="tagline">
          Signed in as <b>{user}</b> ·{" "}
          <a className="logout" onClick={logout}>
            sign out
          </a>
        </p>

        <button className="primary" onClick={newChat} disabled={streaming} type="button">
          + New chat
        </button>

        <div className="section">Chats</div>
        <div className="convolist">
          {conversations.map((c) => (
            <div
              key={c.id}
              className={`convo ${c.id === activeConvo ? "active" : ""}`}
              onClick={() => void openConversation(c.id)}
            >
              <span className="title">{c.title ?? "New conversation"}</span>
              <button
                className="del"
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  void removeConversation(c.id);
                }}
              >
                ✕
              </button>
            </div>
          ))}
          {conversations.length === 0 && <p className="tagline">No chats yet.</p>}
        </div>

        <div className="section">Documents</div>
        <label className="upload">
          Upload a document
          <span className="hint">PDF or text · up to 20 MB</span>
          <input type="file" accept=".pdf,.txt,.md" onChange={onUpload} hidden />
        </label>

        <div className="doclist">
          {documents.map((d) => (
            <div className="doc" key={d.id} title={d.error ?? undefined}>
              <span className="title">{d.title}</span>
              <span className={`status ${d.status}`}>{d.status}</span>
              <button className="del" onClick={() => void deleteDocument(d.id).then(refreshDocuments)}>
                ✕
              </button>
            </div>
          ))}
          {documents.length === 0 && <p className="tagline">No documents yet.</p>}
        </div>
      </aside>

      <main className="chat">
        <div className="messages">
          {messages.length === 0 && (
            <div className="empty">
              <div className="big">◆</div>
              <p>
                Upload a document, wait for it to turn <b>ready</b>,
                <br />
                then ask anything about it.
              </p>
              {suggestions.length > 0 && (
                <div className="chips">
                  <span className="chips-label">Try asking:</span>
                  {suggestions.map((q) => (
                    <button key={q} className="chip" type="button" onClick={() => void ask(q)}>
                      {q}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>
              {m.role === "assistant" && !m.content && streaming && i === lastIdx ? (
                <span className="thinking">
                  <span />
                  <span />
                  <span />
                </span>
              ) : (
                renderContent(m.content)
              )}
              {m.degraded && <div className="banner">{m.degraded}</div>}
              {m.sources && m.sources.length > 0 && (
                <details className="sources">
                  <summary>{m.sources.length} sources</summary>
                  <ol>
                    {m.sources.map((s) => (
                      <li key={s.chunkId}>{s.preview}…</li>
                    ))}
                  </ol>
                </details>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
        {banner && <div className="banner">{banner}</div>}
        <form className="composer" onSubmit={onAsk}>
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask a question about your documents…"
            disabled={streaming}
          />
          <button className="primary" type="submit" disabled={streaming || !question.trim()}>
            {streaming ? "Streaming…" : "Ask"}
          </button>
        </form>
      </main>
    </div>
  );
}
