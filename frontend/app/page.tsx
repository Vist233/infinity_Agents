"use client";

import React, { useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { SendHorizontal, User, Bot, Plus, MessageSquare } from "lucide-react";

interface Session {
  session_id: string;  
  title: string;       
  created_at: string; 
  updated_at: string;    
}

interface Message {
  message_id?: number;  
  session_id?: string;   
  role: "user" | "assistant" | "system"; 
  content: string;       
  created_at?: string;   
}

export default function ChatPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [assistantDone, setAssistantDone] = useState(false);
  const [tokenInfo, setTokenInfo] = useState<{ prompt: number, response: number, total: number } | null>(null);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);

  //自动滚动
  useEffect(() => {
    if (scrollRef.current) {
      const scrollContainer = scrollRef.current.querySelector('[data-radix-scroll-area-viewport]');
      if (scrollContainer) {
        scrollContainer.scrollTo({ top: scrollContainer.scrollHeight, behavior: "smooth" });
      }
    }
  }, [messages]);
  
  // 获取会话列表
  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch("http://localhost:8000/api/sessions");
      if (res.ok) {
        const data = await res.json();
        setSessions(data);
      }
    } catch (e) {
      console.error("Failed to fetch sessions", e);
    }
  }, []);

  // 创建新会话
  const createNewSession = useCallback(async (shouldRefreshList = true) => {
    try {
      const res = await fetch("http://localhost:8000/api/sessions", { method: "POST" });
      const data = await res.json();

      setSessionId(data.session_id); 

      if (shouldRefreshList) {
        await fetchSessions(); 
      }

      return data.session_id;
    } catch (e) {
      console.error("Failed to create session", e);
      return null;
    }
  }, [fetchSessions]); 

  // 初始化逻辑 
  useEffect(() => {
    const init = async () => {
      const res = await fetch("http://localhost:8000/api/sessions");
      if (res.ok) {
        const data = await res.json();
        setSessions(data);
      // 如果有历史记录，自动选中第一个
      if (data.length > 0) {
        setSessionId(data[0].session_id); 
        loadSession(data[0].session_id); 
        } else {
        // 只有列表为空时，才创建新会话
        await createNewSession(false);
        }
      }
    };
    init();
  }, []); 


  const handleNewChat = async () => {
    setMessages([]);
    setTokenInfo(null);
    setAssistantDone(false);
    setInput("");
  
    await createNewSession(true);
  };

  const loadSession = async (id: string) => {
    if (id === sessionId) return;

    setSessionId(id);
    setMessages([]);
    setTokenInfo(null);
    setAssistantDone(false);

    try {
      const res = await fetch(`http://localhost:8000/api/sessions/${id}/messages`);
      if (res.ok) {
        const history = await res.json();
        setMessages(history);
      }
    } catch (e) {
      console.error("Failed to load session history", e);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    let currentId = sessionId;
    if (!currentId) {
      currentId = await createNewSession(true);
      if (!currentId) return; 
    }

    if (!input.trim() || isLoading) return;

    const userMsg: Message = { role: "user", content: input };
    const payloadMessages = [...messages, userMsg];

    // 更新 UI
    setMessages(payloadMessages);
    setInput("");
    setIsLoading(true);
    setAssistantDone(false);
    setTokenInfo(null);
    setMessages((prev) => [...prev, { role: "assistant", content: "" }]);

    try {
      const response = await fetch("http://localhost:8000/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session_id: currentId,
          messages: payloadMessages, 
        }),
      });

      // 发送成功后刷新列表（更新 updatedAt）
      fetchSessions();

      if (!response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      let accumulatedResponse = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        
        // 处理 [DONE] 标记的逻辑
        const doneRegex = /\[DONE\].*prompt:\s*(\d+),\s*response:\s*(\d+),\s*total:\s*(\d+)/s;
        const doneMatch = chunk.match(doneRegex);

        if (doneMatch) {
          const prompt = parseInt(doneMatch[1], 10);
          const responseTokens = parseInt(doneMatch[2], 10);
          const total = parseInt(doneMatch[3], 10);
          setTokenInfo({ prompt, response: responseTokens, total });

          // 移除 [DONE] 标记部分，保留前面的内容
          const cleaned = chunk.replace(doneRegex, ""); 
          accumulatedResponse += cleaned;
          
          // 最后一次更新消息
          setMessages((prev) => {
            const newMsgs = [...prev];
            newMsgs[newMsgs.length - 1] = { role: "assistant", content: accumulatedResponse };
            return newMsgs;
          });

          setIsLoading(false);
          setAssistantDone(true);
          break; 
        }

        // 普通流式内容
        accumulatedResponse += chunk;
        setMessages((prev) => {
            const newMsgs = [...prev];
            // 总是更新最后一条消息
            newMsgs[newMsgs.length - 1] = { role: "assistant", content: accumulatedResponse };
            return newMsgs;
        });
      }
    } catch (error) {
      console.error("Failed to fetch:", error);
      setIsLoading(false);
    }
  };

  return (
    <div className="flex h-screen bg-white text-zinc-900 font-sans">
      
      {/* 侧边栏 */}
      <div className="w-[260px] bg-zinc-50 border-r border-zinc-200 hidden md:flex flex-col p-3 h-full">
        {/* New Chat 按钮 */}
        <Button 
          onClick={handleNewChat}
          variant="outline" 
          className="justify-start gap-2 bg-white border-zinc-200 shadow-sm hover:bg-zinc-100 mb-4 shrink-0"
        >
          <Plus size={16} />
          New Chat
        </Button>

        {/* 会话列表区域 - 关键：flex-1 和 overflow-y-auto 确保只有这里滚动 */}
        <div className="flex-1 overflow-y-auto -mx-2 px-2 space-y-1 custom-scrollbar">
            {sessions.length === 0 && (
                <div className="text-xs text-zinc-400 text-center py-4">No history yet</div>
            )}
            {sessions.map((session) => (
                <button
                    key={session.session_id}
                    onClick={() => loadSession(session.session_id)}
                    className={`w-full flex items-center gap-3 px-3 py-3 text-sm rounded-md transition-colors text-left group
                        ${sessionId === session.session_id 
                            ? "bg-zinc-200 text-zinc-900 font-medium" 
                            : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-900"
                        }`}
                >
                    <MessageSquare size={14} className={`shrink-0 ${sessionId === session.session_id ? "text-zinc-800" : "text-zinc-400 group-hover:text-zinc-600"}`} />
                    <span className="truncate w-full block">{session.title || "New Chat"}</span>
                </button>
            ))}
        </div>

        {/* 底部信息 */}
        <div className="p-2 text-xs text-zinc-400 text-center tracking-tighter mt-2 border-t border-zinc-200 pt-4 shrink-0">
          v1.0.0 @ 2026
        </div>
      </div>

      {/* 主对话区 */}
      <main className="flex-1 flex flex-col relative h-full overflow-hidden">
        {/* Header */}
        <header className="h-14 border-b border-zinc-100 flex items-center px-4 justify-between sticky top-0 bg-white/80 backdrop-blur-md z-10 shrink-0">
          <div className="text-sm font-semibold tracking-tight text-zinc-500 flex items-center gap-2">
             <span>{sessions.find(s => s.session_id === sessionId)?.title || "Paper Agent"}</span>
             {tokenInfo && (
               <span className="text-[10px] px-1.5 py-0.5 bg-zinc-100 border rounded text-zinc-400 font-normal">
                 {tokenInfo.total} tokens
               </span>
             )}
          </div>
        </header>

        {/* ScrollArea - 占据剩余空间 */}
        <ScrollArea className="flex-1" ref={scrollRef}>
          <div className="max-w-3xl mx-auto w-full px-4 pt-10 pb-32">
            {messages.length === 0 ? (
              // 初始状态
              <div className="h-[60vh] flex flex-col items-center justify-center space-y-4 animate-in fade-in duration-500">
                <div className="w-12 h-12 rounded-full border border-zinc-200 flex items-center justify-center shadow-sm bg-white">
                  <Bot size={24} className="text-zinc-700" />
                </div>
                <h2 className="text-xl font-medium tracking-tight text-zinc-700">Research Assistant</h2>
                <div className="flex gap-2">
                    {["CRISPR Review", "Analyze PDF"].map(tag => (
                        <span key={tag} onClick={() => setInput(tag)} className="text-xs border px-2 py-1 rounded-full cursor-pointer hover:bg-zinc-50 text-zinc-400 transition-colors">
                            {tag}
                        </span>
                    ))}
                </div>
              </div>
            ) : (
              // 消息列表
              <div className="space-y-8">
                {messages.map((m, i) => (
                  <div key={i} className={`flex gap-4 ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                    <div className={`flex w-full max-w-3xl gap-4 ${m.role === "user" ? "flex-row-reverse" : ""}`}>
                      <Avatar className={`h-8 w-8 shrink-0 border ${m.role === 'user' ? 'border-zinc-300' : 'border-zinc-200 bg-zinc-900 text-white'}`}>
                        <AvatarFallback className="bg-transparent">
                          {m.role === "user" ? <User size={16} /> : <Bot size={16} className="text-zinc-100" />}
                        </AvatarFallback>
                      </Avatar>
                      <div className="flex flex-col gap-1.5 grow min-w-0">
                        <span className="text-xs font-bold text-zinc-400 uppercase tracking-widest px-1">
                          {m.role === "user" ? "You" : "Assistant"}
                        </span>
                        <div className={`text-[15px] leading-7 whitespace-pre-wrap ${m.role === "user" ? "text-zinc-700 bg-zinc-50 px-3 py-2 rounded-lg" : "text-zinc-900"}`}>
                          {m.content}
                          {isLoading && i === messages.length - 1 && (
                            <span className="inline-block w-1.5 h-4 bg-zinc-900 animate-pulse ml-1 align-middle" />
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Input - 绝对定位底部 */}
        <div className="absolute bottom-0 left-0 w-full bg-gradient-to-t from-white via-white to-transparent pt-10 z-20">
          <div className="max-w-3xl mx-auto px-4 pb-8">
            <form onSubmit={handleSubmit} className="relative group">
              <div className="relative flex items-center shadow-sm rounded-2xl bg-white">
                <textarea
                  rows={1}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      handleSubmit(e);
                    }
                  }}
                  placeholder="Ask a research question..."
                  className="w-full bg-zinc-50 border border-zinc-200 rounded-2xl py-4 pl-4 pr-12 text-sm focus:outline-none focus:ring-1 focus:ring-zinc-400 transition-all resize-none"
                />
                <Button 
                  type="submit" 
                  size="icon" 
                  disabled={isLoading || !input.trim()} 
                  className="absolute right-2 top-1/2 -translate-y-1/2 h-8 w-8 rounded-xl bg-zinc-800 hover:bg-black disabled:bg-zinc-200 transition-all active:scale-95"
                >
                  <SendHorizontal className="h-4 w-4 text-white" />
                </Button>
              </div>
            </form>
          </div>
        </div>
      </main>
    </div>
  );
}