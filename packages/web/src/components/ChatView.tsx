// ============================================================
// Chat View Component
// ============================================================

import { useState, useRef, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import { useSessionStore } from '../store/session-store';

function ChatView() {
  const { id } = useParams<{ id: string }>();
  const currentSession = useSessionStore((state) =>
    state.sessions.find((s) => s.id === (id || '')),
  );
  const addMessage = useSessionStore((state) => state.addMessage);

  const [input, setInput] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [currentSession?.messages]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !id) return;

    // Add user message
    addMessage(id, { role: 'user', content: input });
    setInput('');

    // TODO: Call AI provider and get response
    await new Promise((resolve) => setTimeout(resolve, 500));
    
    const mockResponse = `This is a placeholder response to: "${input}"`;
    addMessage(id, { role: 'assistant', content: mockResponse });
  };

  if (!currentSession) {
    return (
      <div className="chat-empty">
        <h2>Welcome to AiHarness</h2>
        <p>Select a conversation or create a new one.</p>
      </div>
    );
  }

  return (
    <div className="chat-view">
      <div className="messages-container">
        {currentSession.messages.map((msg) => (
          <div key={msg.id} className={`message ${msg.role}`}>
            <div className="message-content">{msg.content}</div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSubmit} className="input-container">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Type your message..."
          autoFocus
        />
        <button type="submit" disabled={!input.trim()}>
          Send
        </button>
      </form>
    </div>
  );
}

export default ChatView;
