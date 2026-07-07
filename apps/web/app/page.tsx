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
  RateLimitError,
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

export default function Home() {
  const [documents, setDocuments] = useState<DocumentDto[]>([]);
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [activeConvo, setActiveConvo] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [question, setQuestion] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);
  const [theme, setTheme] = useState<"light" | "dark">("dark");
  const bottomRef = useRef<HTMLDivElement>(null);

  const refreshDocuments = useCallback(async () => {
    try {
      setDocuments(await listDocuments());
      setBanner((b) => (b === "API unreachable — is the server running?" ? null : b));
    } catch {
      setBanner("API unreachable — is the server running?");
    }
  }, []);

  const refreshConversations = useCallback(async () => {
    try {
      setConversations(await listConversations());
    } catch {
      /* banner already handled by documents fetch */
    }
  }, []);

  useEffect(() => {
    setTheme((document.documentElement.dataset.theme as "light" | "dark") ?? "dark");
    void refreshDocuments();
    void refreshConversations();
  }, [refreshDocuments, refreshConversations]);

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
    const convo = await getConversation(id);
    if (!convo) {
      await refreshConversations();
      return;
    }
    setActiveConvo(id);
    setMessages(convo.messages.map((m) => ({ role: m.role, content: m.content })));
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
      setBanner(err instanceof Error ? err.message : "upload failed");
    }
  }

  async function onAsk(e: React.FormEvent) {
    e.preventDefault();
    const q = question.trim();
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
        setBanner(err instanceof Error ? err.message : "request failed");
      }
    } finally {
      setStreaming(false);
    }
  }

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
        <p className="tagline">Ask questions about your documents, with citations.</p>

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
