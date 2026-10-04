import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent, ReactNode, RefObject } from 'react';
import { parseShellCommandInput } from '@ai-harness/core/shell-input';
import type { AgentEvent, AgentRunSnapshot, EffectiveConfiguration, ExtensionInteractionSnapshot, Message, ModelCatalog, ProviderType, Session, TokenUsage } from '@ai-harness/core';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { AgentCapabilities, CommandSnapshot, ExtensionWidget, PaletteItem, SessionInfo } from '../services/api';
import type { DraftAttachment, StoredSession } from '../store/session-store';
import type { TranslationFunction } from '../i18n/types';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useI18n } from '../hooks/useI18n';
import { useSessionStore } from '../store/session-store';
import { usePreferences } from '../store/preferences';
import MarkdownContent from './MarkdownContent';
import { SubagentPanel } from './SubagentPanel';
import { publishNotice, type NoticeLevel } from '../services/notices';
import { useFocusTrap } from '../hooks/useFocusTrap';
import {
  cancelCommand,
  clearAgentQueue,
  compactSession,
  cloneSession,
  createSession as createApiSession,
  enqueueAgentMessage,
  forkSession,
  getAgentCapabilities,
  getAgentPalette,
  getAgentState,
  getEffectiveConfiguration,
  getExtensionWidgets,
  getPaletteResource,
  getSession,
  getSessionInfo,
  getSessionMessages,
  getSessionTree,
  reloadAgentResources,
  respondToExtensionInteraction,
  runExtensionCommand,
  searchFiles,
  startAgentRun,
  startCommand,
  stopAgentRun,
  streamAgentEvents,
  streamCommandEvents,
  updateSession,
} from '../services/api';

interface ChatViewProps {
  onStreamingUpdate?: (content: string) => void;
}

type QueueMode = 'steer' | 'follow-up';
const EMPTY_ATTACHMENTS: DraftAttachment[] = [];
const SESSION_SCROLL_PREFIX = 'ai-harness:scroll:v1:';
const SESSION_SCROLL_LIMIT = 24;
const SESSION_SCROLL_MAX_AGE_MS = 24 * 60 * 60 * 1_000;

interface SessionScrollPosition {
  top: number;
  fromBottom: number;
  anchorId?: string;
  anchorOffset?: number;
  updatedAt: number;
}

function scrollStorageKey(cwd: string): string {
  return `${SESSION_SCROLL_PREFIX}${encodeURIComponent(cwd)}`;
}

function normalizeSessionScroll(value: unknown): SessionScrollPosition | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const input = value as Partial<SessionScrollPosition>;
  if (!Number.isFinite(input.top) || !Number.isFinite(input.fromBottom) || !Number.isFinite(input.updatedAt)
    || Date.now() - input.updatedAt! > SESSION_SCROLL_MAX_AGE_MS) return undefined;
  return {
    top: Math.max(0, Math.min(1_000_000_000, input.top!)),
    fromBottom: Math.max(0, Math.min(1_000_000_000, input.fromBottom!)),
    ...(typeof input.anchorId === 'string' && input.anchorId.length <= 500 ? { anchorId: input.anchorId } : {}),
    ...(Number.isFinite(input.anchorOffset) ? { anchorOffset: Math.max(-1_000_000, Math.min(1_000_000, input.anchorOffset!)) } : {}),
    updatedAt: input.updatedAt!,
  };
}

function readSessionScroll(cwd: string, sessionId: string): SessionScrollPosition | undefined {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(scrollStorageKey(cwd)) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return normalizeSessionScroll((parsed as Record<string, unknown>)[sessionId]);
  } catch {
    return undefined;
  }
}

function captureSessionScroll(container: HTMLElement): SessionScrollPosition {
  const containerTop = container.getBoundingClientRect().top;
  const anchor = Array.from(container.querySelectorAll<HTMLElement>('article.message[id]'))
    .find(element => element.getBoundingClientRect().bottom >= containerTop);
  return {
    top: Math.max(0, container.scrollTop),
    fromBottom: Math.max(0, container.scrollHeight - container.scrollTop - container.clientHeight),
    anchorId: anchor?.id,
    anchorOffset: anchor ? anchor.getBoundingClientRect().top - containerTop : undefined,
    updatedAt: Date.now(),
  };
}

function writeSessionScroll(cwd: string, sessionId: string, position: SessionScrollPosition): void {
  try {
    const key = scrollStorageKey(cwd);
    const parsed = JSON.parse(sessionStorage.getItem(key) ?? '{}') as unknown;
    const previous = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? Object.entries(parsed as Record<string, unknown>)
      : [];
    const entries: Array<[string, SessionScrollPosition]> = [[sessionId, position]];
    for (const [id, value] of previous) {
      const normalized = normalizeSessionScroll(value);
      if (id !== sessionId && id.length <= 500 && normalized) entries.push([id, normalized]);
    }
    const bounded = Object.fromEntries(entries
      .sort(([, left], [, right]) => right.updatedAt - left.updatedAt)
      .slice(0, SESSION_SCROLL_LIMIT));
    sessionStorage.setItem(key, JSON.stringify(bounded));
  } catch {
    // Scroll restoration is a best-effort view preference.
  }
}

function isActivePhase(phase?: string): boolean {
  return Boolean(phase && !['completed', 'failed', 'stopped'].includes(phase));
}

interface FileSuggestion {
  path: string;
  isDirectory: boolean;
}

function rankFileSuggestions(items: FileSuggestion[], query: string): FileSuggestion[] {
  const normalized = query.toLocaleLowerCase();
  const scored = items.flatMap(item => {
    if (!normalized) return [{ item, score: item.isDirectory ? 0 : 1 }];
    const value = item.path.toLocaleLowerCase();
    const exact = value.indexOf(normalized);
    if (exact >= 0) return [{ item, score: exact * 2 + (item.isDirectory ? 0 : 1) }];
    let cursor = 0;
    let gaps = 0;
    for (const character of normalized) {
      const found = value.indexOf(character, cursor);
      if (found < 0) return [];
      gaps += found - cursor;
      cursor = found + 1;
    }
    return [{ item, score: 1_000 + gaps + (item.isDirectory ? 0 : 1) }];
  });
  return scored.sort((left, right) => left.score - right.score || left.item.path.localeCompare(right.item.path))
    .map(entry => entry.item);
}

function clipboardHtmlToMarkdown(html: string): string {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const convert = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (!(node instanceof HTMLElement)) return '';
    if (['script', 'style', 'template', 'iframe', 'object'].includes(node.tagName.toLowerCase())) return '';
    const content = [...node.childNodes].map(convert).join('');
    switch (node.tagName.toLowerCase()) {
      case 'h1': case 'h2': case 'h3': case 'h4': case 'h5': case 'h6':
        return `${'#'.repeat(Number(node.tagName.slice(1)))} ${content.trim()}\n\n`;
      case 'strong': case 'b': return `**${content}**`;
      case 'em': case 'i': return `*${content}*`;
      case 'code': return node.parentElement?.tagName.toLowerCase() === 'pre' ? content : `\`${content}\``;
      case 'pre': return `\n\`\`\`\n${content.replace(/\n+$/, '')}\n\`\`\`\n\n`;
      case 'a': {
        const href = node.getAttribute('href') ?? '';
        return /^(?:https?:|file:)/i.test(href) ? `[${content}](${href})` : content;
      }
      case 'li': return `- ${content.trim()}\n`;
      case 'blockquote': return `${content.trim().split('\n').map(line => `> ${line}`).join('\n')}\n\n`;
      case 'br': return '\n';
      case 'p': case 'div': return `${content.trim()}\n\n`;
      default: return content;
    }
  };
  return [...document.body.childNodes].map(convert).join('').replace(/\n{3,}/g, '\n\n').trim();
}

function locationMessageId(hash: string): string | undefined {
  if (!hash.startsWith('#') || hash.length < 2) return undefined;
  try { return decodeURIComponent(hash.slice(1)); } catch { return undefined; }
}

function historyGapMessageIds(session: StoredSession | undefined): Set<string> {
  const gaps = new Set<string>();
  const ranges = session?.messagePage?.loadedRanges ?? [];
  let offset = 0;
  ranges.forEach((range, index) => {
    if (index > 0 && session?.messages[offset]) gaps.add(session.messages[offset]!.id);
    offset += range.end - range.start;
  });
  return gaps;
}

function ChatView({ onStreamingUpdate }: ChatViewProps) {
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const sessions = useSessionStore(state => state.sessions);
  const currentSession = sessions.find(session => session.id === id);
  const workspace = useSessionStore(state => state.workspace);
  const activeProviderType = useSessionStore(state => state.providers.active);
  const providerConfig = useSessionStore(state => state.providers.available[activeProviderType]);
  const modelCatalog = useSessionStore(state => state.providers.catalog);
  const currentRun = useSessionStore(state => id ? state.runs[id] : undefined);
  const input = useSessionStore(state => id ? state.drafts[id] ?? '' : '');
  const attachments = useSessionStore(state => id ? state.attachments[id] ?? EMPTY_ATTACHMENTS : EMPTY_ATTACHMENTS);
  const setDraft = useSessionStore(state => state.setDraft);
  const createLocalSession = useSessionStore(state => state.createSession);
  const addAttachments = useSessionStore(state => state.addAttachments);
  const removeAttachment = useSessionStore(state => state.removeAttachment);
  const clearAttachments = useSessionStore(state => state.clearAttachments);
  const setActiveSession = useSessionStore(state => state.setActiveSession);
  const removeSession = useSessionStore(state => state.removeSession);
  const replaceSession = useSessionStore(state => state.replaceSession);
  const syncSession = useSessionStore(state => state.syncSession);
  const mergeMessagePage = useSessionStore(state => state.mergeMessagePage);
  const setRun = useSessionStore(state => state.setRun);
  const upsertAssistantMessage = useSessionStore(state => state.upsertAssistantMessage);
  const updateSessionSettings = useSessionStore(state => state.updateSessionSettings);
  const renameLocalSession = useSessionStore(state => state.renameSession);
  const { t } = useI18n();
  const [preferences] = usePreferences();
  const [starting, setStarting] = useState(false);
  const [queueMode, setQueueMode] = useState<QueueMode>('steer');
  const setNotice = (message?: string, level: NoticeLevel = 'error', options: { id?: string; progress?: number; timeoutMs?: number } = {}) => {
    if (message) publishNotice(message, { level, ...options });
  };
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [branches, setBranches] = useState<Array<{ id: string; title?: string; parentId?: string; depth: number }>>([]);
  const [info, setInfo] = useState<SessionInfo>();
  const [infoOpen, setInfoOpen] = useState(false);
  const [commandRun, setCommandRun] = useState<CommandSnapshot>();
  const [palette, setPalette] = useState<PaletteItem[]>([]);
  const [paletteIndex, setPaletteIndex] = useState(0);
  const [fileIndex, setFileIndex] = useState<{ items: FileSuggestion[]; truncated: boolean }>({ items: [], truncated: false });
  const [remoteFileSuggestions, setRemoteFileSuggestions] = useState<FileSuggestion[]>([]);
  const [nearBottom, setNearBottom] = useState(true);
  const [unseenMessages, setUnseenMessages] = useState(0);
  const [capabilities, setCapabilities] = useState<AgentCapabilities>();
  const [extensionWidgets, setExtensionWidgets] = useState<ExtensionWidget[]>([]);
  const [capabilitiesOpen, setCapabilitiesOpen] = useState(false);
  const [compacting, setCompacting] = useState(false);
  const [automaticCompacting, setAutomaticCompacting] = useState(false);
  const [effectiveConfiguration, setEffectiveConfiguration] = useState<EffectiveConfiguration>();
  const [selection, setSelection] = useState<{ text: string; x: number; y: number }>();
  const [copiedMessageId, setCopiedMessageId] = useState<string>();
  const [sessionUnavailable, setSessionUnavailable] = useState<string>();
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [minimapOpen, setMinimapOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const previousMessageCount = useRef(0);
  const readingBaselineCount = useRef(0);
  const pendingScrollAnchor = useRef<{
    messageId: string;
    offset: number;
    scrollTop: number;
    scrollHeight: number;
    messageCount: number;
  } | undefined>(undefined);
  const pendingSessionScroll = useRef<SessionScrollPosition | undefined>(undefined);
  const latestSessionScroll = useRef<{ cwd: string; sessionId: string; position: SessionScrollPosition } | undefined>(undefined);
  const scrollSaveTimer = useRef<number | undefined>(undefined);
  const requestedHistoryTarget = useRef<string | undefined>(undefined);
  const requestedScrollTarget = useRef<string | undefined>(undefined);
  const lastScrolledTarget = useRef<string | undefined>(undefined);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const compactionController = useRef<AbortController | undefined>(undefined);
  const settingMutationVersions = useRef(new Map<string, number>());
  const effectiveRefreshVersion = useRef(0);
  const composingRef = useRef(false);
  const streamContent = useRef(new Map<string, string>());
  const streamReasoning = useRef(new Map<string, string>());
  const mentionMatch = input.match(/(^|\s)@(?:"([^"]*)|([^\s"]*))$/);
  const mentionQuery = mentionMatch ? (mentionMatch[2] ?? mentionMatch[3] ?? '') : undefined;
  const targetMessageId = locationMessageId(location.hash);
  const targetMessageLoaded = Boolean(targetMessageId
    && currentSession?.messages.some(message => message.id === targetMessageId));
  const virtualized = (currentSession?.messages.length ?? 0) > 120;
  const messageVirtualizer = useVirtualizer({
    count: virtualized ? currentSession?.messages.length ?? 0 : 0,
    getScrollElement: () => messagesContainerRef.current,
    estimateSize: () => 148,
    overscan: 8,
    getItemKey: index => currentSession?.messages[index]?.id ?? index,
  });

  useEffect(() => {
    setSessionUnavailable(undefined);
    if (id) setActiveSession(id);
  }, [id, setActiveSession]);

  useEffect(() => {
    void getAgentPalette(workspace?.cwd, workspace?.id).then(result => {
      if (result.success && result.data) setPalette(result.data);
    });
  }, [workspace?.cwd, workspace?.id]);

  useEffect(() => {
    if (!currentSession || currentSession.draft) {
      setExtensionWidgets([]);
      return;
    }
    let current = true;
    void getExtensionWidgets(currentSession.id).then(result => {
      if (current && result.success && result.data) setExtensionWidgets(result.data);
    });
    return () => { current = false; };
  }, [currentSession?.draft, currentSession?.id]);

  useEffect(() => {
    let current = true;
    setAutomaticCompacting(false);
    if (!workspace?.id) {
      setEffectiveConfiguration(undefined);
      return () => { current = false; };
    }
    void getEffectiveConfiguration(
      workspace.id,
      currentSession?.draft ? undefined : currentSession?.id,
    ).then(result => {
      if (current && result.success && result.data) setEffectiveConfiguration(result.data);
    });
    return () => { current = false; };
  }, [currentSession?.draft, currentSession?.id, workspace?.id]);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(240, Math.max(44, textarea.scrollHeight))}px`;
  }, [input]);

  useEffect(() => {
    const focusPrompt = () => textareaRef.current?.focus();
    window.addEventListener('aih-focus-prompt', focusPrompt);
    return () => window.removeEventListener('aih-focus-prompt', focusPrompt);
  }, []);

  useEffect(() => () => compactionController.current?.abort(), [currentSession?.id]);

  useEffect(() => {
    if (!workspace?.trusted) {
      setFileIndex({ items: [], truncated: false });
      return;
    }
    const controller = new AbortController();
    void searchFiles(workspace.cwd, '', controller.signal).then(result => {
      if (controller.signal.aborted || !result.success || !result.data) return;
      setFileIndex({
        items: [
          ...(result.data.directories ?? []).map(path => ({ path, isDirectory: true })),
          ...result.data.files.map(path => ({ path, isDirectory: false })),
        ],
        truncated: result.data.truncated,
      });
    });
    return () => controller.abort();
  }, [workspace?.cwd, workspace?.trusted]);

  useEffect(() => {
    if (mentionQuery === undefined || !workspace?.trusted || !fileIndex.truncated || !mentionQuery) {
      setRemoteFileSuggestions([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void searchFiles(workspace.cwd, mentionQuery, controller.signal).then(result => {
        if (controller.signal.aborted || !result.success || !result.data) return;
        setRemoteFileSuggestions([
          ...(result.data.directories ?? []).map(path => ({ path, isDirectory: true })),
          ...result.data.files.map(path => ({ path, isDirectory: false })),
        ]);
      });
    }, 160);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [fileIndex.truncated, mentionQuery, workspace?.cwd, workspace?.trusted]);

  useLayoutEffect(() => {
    const sessionId = currentSession?.id;
    const cwd = workspace?.cwd;
    const saved = sessionId && cwd && !targetMessageId ? readSessionScroll(cwd, sessionId) : undefined;
    const startsNearBottom = !saved || saved.fromBottom < 96;
    latestSessionScroll.current = undefined;
    pendingSessionScroll.current = saved;
    nearBottomRef.current = startsNearBottom;
    previousMessageCount.current = currentSession?.messages.length ?? 0;
    readingBaselineCount.current = currentSession?.messages.length ?? 0;
    pendingScrollAnchor.current = undefined;
    requestedHistoryTarget.current = undefined;
    requestedScrollTarget.current = undefined;
    lastScrolledTarget.current = undefined;
    setNearBottom(startsNearBottom);
    setUnseenMessages(0);
    setLoadingHistory(false);
    setMinimapOpen(false);
    return () => {
      if (scrollSaveTimer.current !== undefined) {
        window.clearTimeout(scrollSaveTimer.current);
        scrollSaveTimer.current = undefined;
      }
      const latest = latestSessionScroll.current;
      if (latest && latest.sessionId === sessionId && latest.cwd === cwd) {
        writeSessionScroll(latest.cwd, latest.sessionId, latest.position);
      }
    };
  }, [currentSession?.id, workspace?.cwd]);

  useEffect(() => {
    const sessionId = currentSession?.id;
    const cwd = workspace?.cwd;
    if (!sessionId || !cwd) return;
    const save = () => {
      const container = messagesContainerRef.current;
      if (!container) return;
      const position = captureSessionScroll(container);
      latestSessionScroll.current = { cwd, sessionId, position };
      writeSessionScroll(cwd, sessionId, position);
    };
    window.addEventListener('pagehide', save);
    return () => window.removeEventListener('pagehide', save);
  }, [currentSession?.id, workspace?.cwd]);

  useLayoutEffect(() => {
    const count = currentSession?.messages.length ?? 0;
    const container = messagesContainerRef.current;
    const preserved = pendingScrollAnchor.current;
    const savedPosition = pendingSessionScroll.current;
    const savedAnchorLoaded = !savedPosition?.anchorId
      || Boolean(currentSession?.messages.some(message => message.id === savedPosition.anchorId));
    if (container && savedPosition && count > 0 && savedAnchorLoaded) {
      pendingSessionScroll.current = undefined;
      if (savedPosition.fromBottom < 96) {
        container.scrollTop = container.scrollHeight;
      } else {
        if (virtualized) messageVirtualizer.scrollToOffset(savedPosition.top, { align: 'start' });
        else container.scrollTop = savedPosition.top;
        const restoreSavedAnchor = (): boolean => {
          if (!savedPosition.anchorId) return false;
          const anchor = document.getElementById(savedPosition.anchorId);
          if (!anchor) return false;
          const currentOffset = anchor.getBoundingClientRect().top - container.getBoundingClientRect().top;
          const target = container.scrollTop + currentOffset - (savedPosition.anchorOffset ?? 0);
          if (virtualized) messageVirtualizer.scrollToOffset(target, { align: 'start' });
          else container.scrollTop = target;
          return true;
        };
        if (!restoreSavedAnchor() && virtualized && savedPosition.anchorId) {
          const index = currentSession?.messages.findIndex(message => message.id === savedPosition.anchorId) ?? -1;
          if (index >= 0) messageVirtualizer.scrollToIndex(index, { align: 'start' });
        }
        let attempts = 0;
        const finishSavedRestoration = () => {
          restoreSavedAnchor();
          if (++attempts < 10) window.requestAnimationFrame(finishSavedRestoration);
        };
        window.requestAnimationFrame(finishSavedRestoration);
        window.setTimeout(restoreSavedAnchor, 120);
        window.setTimeout(restoreSavedAnchor, 300);
        window.setTimeout(restoreSavedAnchor, 600);
      }
    } else if (savedPosition) {
      // Keep the position until cached or remote messages have been materialized.
    } else if (container && preserved && count !== preserved.messageCount) {
      const restoreAnchor = (): boolean => {
        const currentAnchor = document.getElementById(preserved.messageId);
        if (!currentAnchor) return false;
        const nextOffset = currentAnchor.getBoundingClientRect().top - container.getBoundingClientRect().top;
        const targetScrollTop = container.scrollTop + nextOffset - preserved.offset;
        if (virtualized) messageVirtualizer.scrollToOffset(targetScrollTop, { align: 'start' });
        else container.scrollTop = targetScrollTop;
        return true;
      };
      const finishRestoration = () => {
        window.requestAnimationFrame(() => window.requestAnimationFrame(restoreAnchor));
        window.setTimeout(restoreAnchor, 120);
      };
      if (restoreAnchor()) {
        pendingScrollAnchor.current = undefined;
        finishRestoration();
      } else if (virtualized) {
        const index = currentSession?.messages.findIndex(message => message.id === preserved.messageId) ?? -1;
        if (index >= 0) messageVirtualizer.scrollToIndex(index, { align: 'start' });
        let attempts = 0;
        const restoreMountedAnchor = () => {
          if (restoreAnchor()) {
            if (pendingScrollAnchor.current === preserved) pendingScrollAnchor.current = undefined;
            finishRestoration();
          } else if (++attempts < 5) window.requestAnimationFrame(restoreMountedAnchor);
          else {
            container.scrollTop = preserved.scrollTop + Math.max(0, container.scrollHeight - preserved.scrollHeight);
            if (pendingScrollAnchor.current === preserved) pendingScrollAnchor.current = undefined;
          }
        };
        window.requestAnimationFrame(restoreMountedAnchor);
      } else {
        container.scrollTop = preserved.scrollTop + Math.max(0, container.scrollHeight - preserved.scrollHeight);
        pendingScrollAnchor.current = undefined;
      }
    } else if (preserved) {
      // Keep the anchor until the requested page actually changes the message window.
    } else if (targetMessageId) {
      const targetKey = `${currentSession?.id ?? ''}:${targetMessageId}`;
      const target = document.getElementById(targetMessageId);
      if (target && lastScrolledTarget.current !== targetKey) {
        target.scrollIntoView({ block: 'center' });
        lastScrolledTarget.current = targetKey;
      } else if (virtualized && targetMessageLoaded && lastScrolledTarget.current !== targetKey) {
        const index = currentSession?.messages.findIndex(message => message.id === targetMessageId) ?? -1;
        if (index >= 0) {
          messageVirtualizer.scrollToIndex(index, { align: 'center' });
          window.requestAnimationFrame(() => {
            document.getElementById(targetMessageId)?.scrollIntoView({ block: 'center' });
            lastScrolledTarget.current = targetKey;
          });
        }
      } else if (!nearBottom) {
        setUnseenMessages(Math.max(0, count - readingBaselineCount.current));
      }
    } else if (nearBottomRef.current && nearBottom) {
      container?.scrollTo({ top: container.scrollHeight, behavior: previousMessageCount.current ? 'smooth' : 'auto' });
    } else if (!nearBottom) {
      setUnseenMessages(Math.max(0, count - readingBaselineCount.current));
    }
    previousMessageCount.current = count;
  }, [currentSession?.messages, messageVirtualizer, nearBottom, targetMessageId, targetMessageLoaded, virtualized]);

  useEffect(() => {
    if (!id || id.startsWith('draft:') || !targetMessageId || targetMessageLoaded) return;
    const requestKey = `${id}:${targetMessageId}`;
    if (requestedHistoryTarget.current === requestKey) return;
    requestedHistoryTarget.current = requestKey;
    const controller = new AbortController();
    setLoadingHistory(true);
    void getSessionMessages(id, { around: targetMessageId, limit: 80, signal: controller.signal }).then(result => {
      if (result.success && result.data) mergeMessagePage(id, result.data);
      else if (!controller.signal.aborted) {
        requestedHistoryTarget.current = undefined;
        setNotice(result.error || t('chat.historyLoadFailed'));
      }
      if (!controller.signal.aborted) setLoadingHistory(false);
    });
    return () => controller.abort();
  }, [id, mergeMessagePage, t, targetMessageId, targetMessageLoaded]);

  useEffect(() => {
    const saved = pendingSessionScroll.current;
    const anchorId = saved?.anchorId;
    if (!id || id.startsWith('draft:') || !anchorId
      || currentSession?.messages.some(message => message.id === anchorId)) return;
    const requestKey = `${id}:${anchorId}`;
    if (requestedScrollTarget.current === requestKey) return;
    requestedScrollTarget.current = requestKey;
    const controller = new AbortController();
    void getSessionMessages(id, { around: anchorId, limit: 80, signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      if (result.success && result.data) mergeMessagePage(id, result.data);
      else {
        pendingSessionScroll.current = { ...saved, anchorId: undefined, anchorOffset: undefined };
        setNotice(result.error || t('chat.historyLoadFailed'));
      }
    });
    return () => {
      controller.abort();
      if (requestedScrollTarget.current === requestKey) requestedScrollTarget.current = undefined;
    };
  }, [currentSession?.messages, id, mergeMessagePage, t]);

  useEffect(() => {
    if (!id || id.startsWith('draft:')) return;
    const controller = new AbortController();
    let mounted = true;
    let sequence = 0;

    const applyEvent = async (event: AgentEvent): Promise<void> => {
      sequence = Math.max(sequence, event.sequence);
      if (!mounted) return;
      const runId = event.runId;
      const patchRun = (changes: Partial<AgentRunSnapshot>): void => {
        const existing = useSessionStore.getState().runs[id];
        if (!existing || (runId && existing.id !== runId)) return;
        setRun(id, { ...existing, ...changes });
      };
      const eventData = event.data as { content?: unknown; messageId?: unknown };
      const messageId = typeof eventData.messageId === 'string'
        ? eventData.messageId
        : runId ? `stream:${runId}` : undefined;
      if (event.type === 'run.phase') {
        const phase = (event.data as { phase?: unknown }).phase;
        if (typeof phase === 'string') patchRun({ phase: phase as AgentRunSnapshot['phase'] });
      }
      if (event.type === 'message.start' && messageId) {
        streamContent.current.set(messageId, '');
        streamReasoning.current.set(messageId, '');
        patchRun({ phase: 'streaming', retry: undefined });
      }
      if (event.type === 'message.delta' && messageId) {
        const chunk = typeof eventData.content === 'string' ? eventData.content : '';
        const content = `${streamContent.current.get(messageId) ?? ''}${chunk}`;
        streamContent.current.set(messageId, content);
        upsertAssistantMessage(id, messageId, content, streamReasoning.current.get(messageId));
        onStreamingUpdate?.(content);
      }
      if (event.type === 'reasoning.delta' && messageId) {
        const chunk = typeof eventData.content === 'string' ? eventData.content : '';
        const reasoning = `${streamReasoning.current.get(messageId) ?? ''}${chunk}`;
        streamReasoning.current.set(messageId, reasoning);
        upsertAssistantMessage(id, messageId, streamContent.current.get(messageId) ?? '', reasoning);
      }
      if (event.type === 'retry.scheduled') {
        const retry = event.data as AgentRunSnapshot['retry'];
        if (retry && typeof retry.attempt === 'number' && typeof retry.max === 'number'
          && typeof retry.delayMs === 'number' && typeof retry.message === 'string') {
          patchRun({ retry });
        }
      }
      if (event.type === 'tool.started') {
        const tool = event.data as { id?: unknown; name?: unknown; input?: unknown };
        if (typeof tool.id === 'string' && typeof tool.name === 'string') patchRun({
          phase: 'tool',
          activeTool: { id: tool.id, name: tool.name, input: tool.input, startedAt: event.timestamp },
        });
      }
      if (event.type === 'tool.completed' || event.type === 'tool.failed') patchRun({ activeTool: undefined });
      if (event.type === 'extension.ui') {
        const data = event.data as { action?: unknown; request?: unknown };
        if (data.action === 'request' && data.request && typeof data.request === 'object') {
          const request = data.request as ExtensionInteractionSnapshot;
          patchRun({ extensionRequest: request });
          if (preferences.sound && preferences.soundEvents.attention) playCompletionSound(preferences.soundVolume, true);
          if (preferences.notifications && preferences.notificationEvents.attention
            && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
            new Notification(currentSession?.title || 'AiHarness', { body: request.message, tag: `agent:${id}:attention` });
          }
        } else if (data.action === 'resolved') patchRun({ extensionRequest: undefined });
      }
      if (event.type === 'notice') {
        const data = event.data as { message?: unknown; level?: unknown; progress?: unknown; id?: unknown };
        const level: NoticeLevel = ['info', 'success', 'warning', 'error'].includes(String(data.level))
          ? data.level as NoticeLevel
          : 'info';
        if (typeof data.message === 'string') setNotice(data.message, level, {
          id: typeof data.id === 'string' ? data.id : event.id,
          ...(typeof data.progress === 'number' ? { progress: data.progress } : {}),
        });
      }
      if (event.type === 'compaction.started' && (event.data as { automatic?: unknown }).automatic === true) {
        setAutomaticCompacting(true);
        setNotice(t('chat.status.compacting'), 'info', {
          id: `automatic-compaction:${id}`,
          progress: 0,
          timeoutMs: 0,
        });
      }
      if (event.type === 'compaction.completed' && (event.data as { automatic?: unknown }).automatic === true) {
        const statistics = event.data as { tokensBefore?: unknown; tokensAfter?: unknown; tokensSaved?: unknown };
        setAutomaticCompacting(false);
        setNotice(t('chat.compactComplete', {
          before: typeof statistics.tokensBefore === 'number' ? statistics.tokensBefore : 0,
          after: typeof statistics.tokensAfter === 'number' ? statistics.tokensAfter : 0,
          saved: typeof statistics.tokensSaved === 'number' ? statistics.tokensSaved : 0,
        }), 'success', {
          id: `automatic-compaction:${id}`,
          progress: 1,
        });
      }
      if (event.type === 'compaction.failed' && (event.data as { automatic?: unknown }).automatic === true) {
        const data = event.data as { message?: unknown; cancelled?: unknown };
        const cancelled = data.cancelled === true;
        setAutomaticCompacting(false);
        setNotice(cancelled
          ? t('chat.compactCancelled')
          : typeof data.message === 'string' ? data.message : t('chat.compactFailed'), cancelled ? 'warning' : 'error', {
          id: `automatic-compaction:${id}`,
        });
      }
      if (event.type === 'run.completed') {
        if (preferences.sound && preferences.soundEvents.completion) playCompletionSound(preferences.soundVolume);
        if (preferences.notifications && preferences.notificationEvents.completion
          && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
          const notification = new Notification(currentSession?.title || 'AiHarness', {
            body: t('chat.agentCompleted'),
            tag: `agent:${id}:${event.runId ?? ''}`,
          });
          notification.onclick = () => {
            window.focus();
            navigate(`/chat/${encodeURIComponent(id)}?cwd=${encodeURIComponent(workspace?.cwd ?? '')}`);
            notification.close();
          };
        }
      }
      if (event.type === 'run.failed') {
        const message = (event.data as { message?: unknown }).message;
        const detail = typeof message === 'string' ? message : t('chat.unexpectedError');
        patchRun({ phase: 'failed', error: typeof message === 'string' ? message : undefined, retry: undefined, activeTool: undefined });
        setNotice(detail);
        if (preferences.sound && preferences.soundEvents.attention) playCompletionSound(preferences.soundVolume, true);
        if (preferences.notifications && preferences.notificationEvents.attention
          && document.hidden && 'Notification' in window && Notification.permission === 'granted') {
          new Notification(currentSession?.title || 'AiHarness', { body: detail, tag: `agent:${id}:attention` });
        }
      }
      if (event.type === 'run.completed') patchRun({ phase: 'completed', retry: undefined, activeTool: undefined });
      if (event.type === 'run.stopped') patchRun({ phase: 'stopped', retry: undefined, activeTool: undefined });
      if (['run.completed', 'run.failed', 'run.stopped', 'tool.completed', 'tool.failed', 'compaction.completed', 'compaction.failed'].includes(event.type)) {
        const state = await getAgentState(id);
        if (state.success && state.data && mounted) {
          syncSession(state.data.session);
          if (state.data.run) setRun(id, state.data.run);
        }
      }
    };

    void (async () => {
      while (mounted && !controller.signal.aborted) {
        try {
          const state = await getAgentState(id);
          if (!state.success || !state.data) {
            if (/\b404\b|not found|introuvable/i.test(state.error ?? '')) {
              removeSession(id);
              setSessionUnavailable(state.error || t('chat.sessionUnavailable'));
              break;
            }
            throw new Error(state.error || t('chat.unexpectedError'));
          }
          setSessionUnavailable(undefined);
          syncSession(state.data.session);
          sequence = state.data.lastSequence;
          if (state.data.run) {
            setRun(id, state.data.run);
            if (state.data.run.partialMessage) {
              streamContent.current.set(state.data.run.partialMessage.id, state.data.run.partialMessage.content);
              streamReasoning.current.set(state.data.run.partialMessage.id, state.data.run.partialMessage.reasoning ?? '');
              upsertAssistantMessage(id, state.data.run.partialMessage.id, state.data.run.partialMessage.content, state.data.run.partialMessage.reasoning);
            }
          }
          for await (const record of streamAgentEvents(id, sequence, controller.signal)) {
            if (record.type === 'connection.ready') {
              sequence = Math.max(sequence, record.snapshot.lastSequence);
              if (record.snapshot.run) {
                setRun(id, record.snapshot.run);
                if (record.snapshot.run.partialMessage) {
                  streamContent.current.set(record.snapshot.run.partialMessage.id, record.snapshot.run.partialMessage.content);
                  streamReasoning.current.set(record.snapshot.run.partialMessage.id, record.snapshot.run.partialMessage.reasoning ?? '');
                  upsertAssistantMessage(id, record.snapshot.run.partialMessage.id, record.snapshot.run.partialMessage.content, record.snapshot.run.partialMessage.reasoning);
                }
              }
            } else await applyEvent(record.event);
          }
          // A real SSE response stays open. Avoid a hot reconnect loop when a proxy closes it cleanly.
          if (mounted && !controller.signal.aborted) await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
          if (controller.signal.aborted) break;
          const message = error instanceof Error ? error.message : t('chat.unexpectedError');
          if (/\b404\b|not found|introuvable/i.test(message)) {
            removeSession(id);
            setSessionUnavailable(message);
            break;
          }
          setNotice(message);
          await new Promise(resolve => setTimeout(resolve, 1_000));
        }
      }
    })();

    return () => {
      mounted = false;
      controller.abort();
    };
  }, [currentSession?.title, id, navigate, onStreamingUpdate, preferences.notificationEvents, preferences.notifications, preferences.sound, preferences.soundEvents, preferences.soundVolume, removeSession, setRun, syncSession, t, upsertAssistantMessage, workspace?.cwd]);

  const active = isActivePhase(currentRun?.phase);
  const modelLocked = effectiveConfiguration?.provenance.model?.scope === 'environment';
  const thinkingLocked = effectiveConfiguration?.provenance.thinking?.scope === 'environment';
  const toolPresetLocked = effectiveConfiguration?.provenance.toolPreset?.scope === 'environment';
  const autoCompactionLocked = effectiveConfiguration?.provenance.autoCompaction?.scope === 'environment';
  const model = (modelLocked ? effectiveConfiguration?.values.model : currentSession?.model)
    ?? effectiveConfiguration?.values.model
    ?? providerConfig?.model
    ?? '';
  const modelSupportsTools = modelCatalog?.providers
    .find(group => group.provider === activeProviderType)?.models
    .find(entry => entry.id === model)?.capabilities.toolCalls !== false;
  const thinking = (thinkingLocked ? effectiveConfiguration?.values.thinking : currentSession?.thinking)
    ?? effectiveConfiguration?.values.thinking
    ?? 'off';
  const toolPreset = (toolPresetLocked ? effectiveConfiguration?.values.toolPreset : currentSession?.toolPreset)
    ?? effectiveConfiguration?.values.toolPreset
    ?? 'default';
  const autoCompaction = (autoCompactionLocked ? effectiveConfiguration?.values.autoCompaction : currentSession?.autoCompaction)
    ?? effectiveConfiguration?.values.autoCompaction
    ?? true;
  const settingOverrides: Array<'model' | 'thinking' | 'toolPreset' | 'autoCompaction'> = [
    ...(currentSession?.model !== undefined ? ['model' as const] : []),
    ...(currentSession?.thinking !== undefined ? ['thinking' as const] : []),
    ...(currentSession?.toolPreset !== undefined ? ['toolPreset' as const] : []),
    ...(currentSession?.autoCompaction !== undefined ? ['autoCompaction' as const] : []),
  ];
  const settingScope = (
    key: 'model' | 'thinking' | 'toolPreset' | 'autoCompaction',
    explicit: boolean,
  ) => explicit && effectiveConfiguration?.provenance[key]?.scope !== 'environment'
    ? 'session'
    : effectiveConfiguration?.provenance[key]?.scope ?? 'default';
  const modelScope = settingScope('model', currentSession?.model !== undefined);
  const thinkingScope = settingScope('thinking', currentSession?.thinking !== undefined);
  const toolPresetScope = settingScope('toolPreset', currentSession?.toolPreset !== undefined);
  const autoCompactionScope = settingScope('autoCompaction', currentSession?.autoCompaction !== undefined);
  const slashQuery = input.startsWith('/') && !input.includes(' ') ? input.slice(1).toLocaleLowerCase() : undefined;
  const paletteResults = slashQuery === undefined ? [] : palette
    .filter(item => item.name.toLocaleLowerCase().includes(slashQuery))
    .slice(0, 10);
  const fileResults = mentionQuery === undefined ? [] : rankFileSuggestions(
    [...new Map([...fileIndex.items, ...remoteFileSuggestions].map(item => [item.path, item])).values()],
    mentionQuery,
  ).slice(0, 10);
  const suggestionCount = paletteResults.length || fileResults.length;
  const busyCompacting = compacting || automaticCompacting;
  const canSend = Boolean((input.trim() || attachments.length) && currentSession && workspace && !starting && !busyCompacting);
  const status = busyCompacting
    ? t('chat.status.compacting')
    : starting
    ? t('chat.status.starting')
    : currentRun?.retry
      ? t('chat.status.retrying', {
          attempt: currentRun.retry.attempt,
          max: currentRun.retry.max,
          message: currentRun.retry.message,
        })
      : currentRun?.phase === 'tool' && currentRun.activeTool
        ? t('chat.status.toolNamed', { tool: currentRun.activeTool.name })
        : active
          ? t(`chat.status.${currentRun?.phase}`)
          : undefined;
  const stopLabel = compacting
    ? t('chat.stop.compaction')
    : currentRun?.phase === 'tool'
      ? t('chat.stop.tool')
      : currentRun?.phase === 'command'
        ? t('chat.stop.command')
        : currentRun?.phase === 'streaming' || currentRun?.phase === 'prompting'
          ? t('chat.stop.model')
          : t('chat.stop');

  const attachImages = async (files: File[]) => {
    if (!currentSession) return;
    const images = files.filter(file => file.type.startsWith('image/'));
    if (images.length !== files.length) setNotice(t('chat.imagesOnly'), 'warning');
    if (attachments.length + images.length > 8) {
      setNotice(t('chat.imageCountLimit'), 'warning');
      return;
    }
    try {
      const prepared = await Promise.all(images.map(prepareImage));
      const totalSize = [...attachments, ...prepared].reduce((sum, image) => sum + image.size, 0);
      if (totalSize > 6 * 1024 * 1024) throw new Error(t('chat.imageTotalLimit'));
      addAttachments(currentSession.id, prepared);
      if (!['openai', 'anthropic', 'google', 'azure', 'vertex'].includes(activeProviderType)) {
        setNotice(t('chat.imageSupportWarning', { provider: activeProviderType }), 'warning');
      }
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('chat.imageFailed'));
    }
  };

  const executeSlashCommand = async (raw: string): Promise<boolean> => {
    if (!currentSession || !workspace || !raw.startsWith('/')) return false;
    const [name, ...parts] = raw.slice(1).trim().split(/\s+/);
    const argument = parts.join(' ');
    switch (name.toLocaleLowerCase()) {
      case 'auto-compact': {
        const mode = argument.trim().toLocaleLowerCase();
        if (!mode) {
          setNotice(t('chat.autoCompactStatus', { state: autoCompaction ? t('common.on') : t('common.off') }), 'info');
          return true;
        }
        if (!['auto', 'on', 'off'].includes(mode)) {
          setNotice(t('chat.autoCompactUsage'), 'warning');
          return true;
        }
        await changeSetting('autoCompaction', mode === 'auto' ? undefined : mode === 'on');
        setNotice(t('chat.autoCompactChanged', {
          state: mode === 'auto' ? t('chat.setting.auto') : mode === 'on' ? t('common.on') : t('common.off'),
        }), 'success');
        return true;
      }
      case 'compact': {
        if (currentSession.draft) {
          setNotice(t('chat.compactDraft'), 'warning');
          return true;
        }
        const controller = new AbortController();
        compactionController.current?.abort();
        compactionController.current = controller;
        setCompacting(true);
        try {
          const result = await compactSession({
            sessionId: currentSession.id,
            provider: activeProviderType,
            model: model || undefined,
            instruction: argument || undefined,
          }, controller.signal);
          if (controller.signal.aborted) setNotice(t('chat.compactCancelled'), 'info');
          else if (!result.success || !result.data) setNotice(result.error || t('chat.compactFailed'));
          else {
            syncSession(result.data.session);
            setNotice(t('chat.compactComplete', {
              before: result.data.tokensBefore,
              after: result.data.tokensAfter,
              saved: result.data.tokensSaved,
            }), 'success');
          }
        } finally {
          if (compactionController.current === controller) {
            compactionController.current = undefined;
            setCompacting(false);
          }
        }
        return true;
      }
      case 'clone': {
        if (currentSession.draft) return true;
        const result = await cloneSession(currentSession.id, argument || `${currentSession.title || t('sidebar.untitled')} (copy)`);
        if (!result.success || !result.data) setNotice(result.error || t('session.cloneFailed'));
        else {
          const loaded = await getSession(result.data.id);
          if (loaded.success && loaded.data) syncSession(loaded.data);
          navigate(`/chat/${encodeURIComponent(result.data.id)}?cwd=${encodeURIComponent(workspace.cwd)}`);
        }
        return true;
      }
      case 'copy': {
        const latest = [...currentSession.messages].reverse().find(message => message.role === 'assistant');
        if (latest) await navigator.clipboard?.writeText(latest.content);
        setNotice(latest ? t('chat.copied') : t('chat.noAssistantMessage'), latest ? 'success' : 'warning');
        return true;
      }
      case 'name': {
        if (!argument) {
          setNotice(t('chat.nameMissing'), 'warning');
          return true;
        }
        if (!currentSession.draft) {
          const result = await updateSession(currentSession.id, { title: argument });
          if (!result.success) {
            setNotice(result.error || t('session.renameFailed'));
            return true;
          }
        }
        renameLocalSession(currentSession.id, argument);
        return true;
      }
      case 'stats': {
        if (!currentSession.draft) {
          const result = await getSessionInfo(currentSession.id);
          if (result.success && result.data) {
            setInfo(result.data);
            setInfoOpen(true);
          }
        }
        return true;
      }
      case 'reload': {
        const reload = await reloadAgentResources({ cwd: workspace.cwd, projectId: workspace.id });
        if (!reload.success || !reload.data) {
          setNotice(reload.error || t('chat.resourceReloadFailed'));
          return true;
        }
        const [nextPalette, nextCapabilities, nextWidgets] = await Promise.all([
          getAgentPalette(workspace.cwd, workspace.id),
          currentSession.draft ? Promise.resolve(undefined) : getAgentCapabilities(currentSession.id),
          currentSession.draft ? Promise.resolve(undefined) : getExtensionWidgets(currentSession.id),
        ]);
        if (nextPalette.success && nextPalette.data) setPalette(nextPalette.data);
        if (nextCapabilities?.success && nextCapabilities.data) setCapabilities(nextCapabilities.data);
        if (nextWidgets?.success && nextWidgets.data) setExtensionWidgets(nextWidgets.data);
        setNotice(reload.data.errors.length
          ? reload.data.errors.map(error => `${error.path}: ${error.message}`).join('\n')
          : t('chat.resourcesReloaded'), reload.data.errors.length ? 'warning' : 'success');
        return true;
      }
      default: {
        const resource = palette.find(item => item.name === name && (item.source === 'prompt' || item.source === 'skill'));
        if (resource) {
          const loaded = await getPaletteResource(resource.source as 'prompt' | 'skill', name, workspace.cwd, workspace.id);
          if (!loaded.success || !loaded.data) setNotice(loaded.error || t('chat.paletteResourceFailed'));
          else {
            const expanded = loaded.data.content.includes('{{input}}')
              ? loaded.data.content.replaceAll('{{input}}', argument)
              : `${loaded.data.content}${argument ? `\n\n${argument}` : ''}`;
            setDraft(currentSession.id, expanded);
            window.setTimeout(() => textareaRef.current?.focus(), 0);
            setNotice(t('chat.paletteResourceLoaded', { source: loaded.data.source }), 'success');
          }
          return true;
        }
        const extension = palette.find(item => item.name === name && item.source === 'extension');
        if (extension && !currentSession.draft) {
          const result = await runExtensionCommand(currentSession.id, name, argument);
          if (!result.success) setNotice(result.error || t('chat.extensionCommandFailed'));
          else if (result.data?.output) setNotice(result.data.output, 'info', { timeoutMs: 10_000 });
          return true;
        }
        setNotice(t('chat.unknownCommand', { command: name }), 'warning');
        return true;
      }
    }
  };

  const runShellCommand = async (raw: string) => {
    if (!currentSession || !workspace) return;
    const parsed = parseShellCommandInput(raw);
    if (!parsed?.command) {
      setNotice(t('chat.commandMissing'), 'warning');
      return;
    }
    const { command, excludedFromContext } = parsed;
    let sessionId = currentSession.id;
    if (currentSession.draft) {
      const created = await createApiSession(command.slice(0, 50), workspace.cwd);
      if (!created.success || !created.data) {
        setNotice(created.error || t('chat.commandFailed'));
        return;
      }
      replaceSession(currentSession.id, created.data);
      sessionId = created.data.id;
      navigate(`/chat/${encodeURIComponent(sessionId)}?cwd=${encodeURIComponent(workspace.cwd)}`, { replace: true });
    }
    const started = await startCommand({ sessionId, command, cwd: workspace.cwd, excludedFromContext });
    if (!started.success || !started.data) {
      setNotice(started.error || t('chat.commandFailed'));
      return;
    }
    setCommandRun(started.data);
    const controller = new AbortController();
    try {
      for await (const record of streamCommandEvents(started.data.id, 0, controller.signal)) {
        if (record.snapshot) setCommandRun(record.snapshot);
        if (record.event?.type === 'output') {
          setCommandRun(previous => previous ? {
            ...previous,
            output: `${previous.output}${record.event?.data.chunk ?? ''}`,
            truncated: previous.truncated || Boolean(record.event?.data.truncated),
            lastSequence: record.event!.sequence,
          } : previous);
        }
        if (record.event && ['exit', 'error', 'cancelled'].includes(record.event.type)) {
          setCommandRun(previous => previous ? {
            ...previous,
            status: record.event!.type === 'cancelled' ? 'cancelled'
              : record.event!.type === 'error' || Number(record.event!.data.exitCode) !== 0 ? 'failed' : 'completed',
            exitCode: typeof record.event!.data.exitCode === 'number' ? record.event!.data.exitCode : previous.exitCode,
          } : previous);
          controller.abort();
          window.setTimeout(() => void getSession(sessionId).then(result => {
            if (result.success && result.data) syncSession(result.data);
          }), 50);
          break;
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) setNotice(error instanceof Error ? error.message : t('chat.commandFailed'));
    }
  };

  const sendMessage = async () => {
    if (!canSend || !currentSession || !workspace) return;
    const content = input.trim() || (attachments.length ? '[Image attachment]' : '');
    setDraft(currentSession.id, '');
    setHistory(previous => [content, ...previous.filter(item => item !== content)].slice(0, 100));
    setHistoryIndex(-1);
    setNotice(undefined);

    if (content.startsWith('/')) {
      await executeSlashCommand(content);
      return;
    }

    if (content.startsWith('!')) {
      await runShellCommand(content);
      return;
    }

    if (active && currentRun) {
      const queued = await enqueueAgentMessage(currentRun.id, queueMode, content, [
        { type: 'text', text: content },
        ...attachments.map(attachment => ({
          type: 'image' as const,
          mediaType: attachment.mediaType,
          name: attachment.name,
          size: attachment.size,
          url: attachment.url,
        })),
      ]);
      if (queued.success && queued.data) {
        setRun(currentSession.id, queued.data);
        clearAttachments(currentSession.id);
      }
      else {
        setDraft(currentSession.id, content);
        setNotice(queued.error || t('chat.queueFailed'));
      }
      return;
    }

    setStarting(true);
    const localId = currentSession.id;
    try {
      const result = await startAgentRun({
        ...(currentSession.draft ? {} : { sessionId: currentSession.id }),
        cwd: workspace.cwd,
        provider: activeProviderType,
        input: content,
        blocks: [
          { type: 'text', text: content },
          ...attachments.map(attachment => ({
            type: 'image' as const,
            mediaType: attachment.mediaType,
            name: attachment.name,
            size: attachment.size,
            url: attachment.url,
          })),
        ],
        // Keep explicit session values distinct from environment-locked effective
        // values; the server resolves the winner again before launching the run.
        model: (currentSession.model ?? model) || undefined,
        thinking: currentSession.thinking ?? thinking,
        toolPreset: currentSession.toolPreset ?? toolPreset,
        autoCompaction: currentSession.autoCompaction ?? autoCompaction,
        settingOverrides,
      });
      if (!result.success || !result.data) throw new Error(result.error || t('chat.unexpectedError'));
      replaceSession(localId, result.data.session);
      clearAttachments(result.data.session.id);
      if (localId !== result.data.session.id) clearAttachments(localId);
      setRun(result.data.session.id, result.data.run);
      if (localId !== result.data.session.id) {
        navigate(`/chat/${encodeURIComponent(result.data.session.id)}?cwd=${encodeURIComponent(workspace.cwd)}`, { replace: true });
      }
    } catch (error) {
      setDraft(localId, content);
      setNotice(error instanceof Error ? error.message : t('chat.unexpectedError'));
    } finally {
      setStarting(false);
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    await sendMessage();
  };

  const insertFileSuggestion = (suggestion: FileSuggestion) => {
    if (!currentSession || !mentionMatch) return;
    const leading = mentionMatch[1] ?? '';
    const start = (mentionMatch.index ?? 0) + leading.length;
    const escapedPath = suggestion.path.replace(/(["\\])/g, '\\$1');
    const mention = /\s/.test(suggestion.path) ? `@"${escapedPath}" ` : `@${escapedPath} `;
    setDraft(currentSession.id, `${input.slice(0, start)}${mention}`);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const selectSuggestion = () => {
    if (!currentSession) return;
    if (paletteResults.length) {
      const selected = paletteResults[paletteIndex] ?? paletteResults[0];
      if (selected) setDraft(currentSession.id, `/${selected.name} `);
      return;
    }
    const selected = fileResults[paletteIndex] ?? fileResults[0];
    if (selected) insertFileSuggestion(selected);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestionCount && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      setPaletteIndex(index => event.key === 'ArrowDown'
        ? (index + 1) % suggestionCount
        : (index - 1 + suggestionCount) % suggestionCount);
      return;
    }
    if (suggestionCount && (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !composingRef.current))) {
      event.preventDefault();
      selectSuggestion();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey && !composingRef.current) {
      event.preventDefault();
      void sendMessage();
      return;
    }
    if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !input.includes('\n') && history.length) {
      const next = event.key === 'ArrowUp'
        ? Math.min(history.length - 1, historyIndex + 1)
        : Math.max(-1, historyIndex - 1);
      if (next !== historyIndex) {
        event.preventDefault();
        setHistoryIndex(next);
        setDraft(currentSession!.id, next < 0 ? '' : history[next]);
      }
    }
  };

  async function changeSetting<K extends 'model' | 'thinking' | 'toolPreset' | 'autoCompaction'>(
    key: K,
    value: Pick<Session, K>[K] | undefined,
  ): Promise<void> {
    if (!currentSession) return;
    const sessionId = currentSession.id;
    const previous = currentSession[key];
    const mutationKey = `${sessionId}:${key}`;
    const mutationVersion = (settingMutationVersions.current.get(mutationKey) ?? 0) + 1;
    settingMutationVersions.current.set(mutationKey, mutationVersion);
    updateSessionSettings(sessionId, { [key]: value });
    if (!currentSession.draft) {
      const changes = { [key]: value === undefined ? null : value } as Parameters<typeof updateSession>[1];
      const result = await updateSession(sessionId, changes);
      if (settingMutationVersions.current.get(mutationKey) !== mutationVersion) return;
      if (!result.success || !result.data) {
        updateSessionSettings(sessionId, { [key]: previous });
        setNotice(result.error || t('session.updateFailed'));
        return;
      }
      // Apply only the acknowledged field: concurrent setting responses may contain
      // stale snapshots for the other selectors.
      updateSessionSettings(sessionId, { [key]: result.data[key] });
      const refreshVersion = ++effectiveRefreshVersion.current;
      const refreshedConfiguration = await getEffectiveConfiguration(workspace?.id, sessionId);
      if (refreshVersion === effectiveRefreshVersion.current
        && refreshedConfiguration.success && refreshedConfiguration.data) {
        setEffectiveConfiguration(refreshedConfiguration.data);
      }
      if (key === 'toolPreset' && capabilitiesOpen) {
        const refreshed = await getAgentCapabilities(sessionId);
        if (refreshed.success && refreshed.data) setCapabilities(refreshed.data);
        else setNotice(refreshed.error || t('chat.capabilitiesFailed'));
      }
    }
  }

  const branchFrom = async (messageId: string, content: string, edit = false) => {
    if (!currentSession || currentSession.draft || active) return;
    const result = await forkSession(currentSession.id, { messageId, title: `${currentSession.title || t('sidebar.untitled')} (branch)` });
    if (!result.success || !result.data) {
      setNotice(result.error || t('session.branchFailed'));
      return;
    }
    const loaded = await getSession(result.data.id);
    if (loaded.success && loaded.data) syncSession(loaded.data);
    await updateSession(currentSession.id, { activeLeafId: result.data.id });
    if (edit) setDraft(result.data.id, content);
    navigate(`/chat/${encodeURIComponent(result.data.id)}?cwd=${encodeURIComponent(workspace!.cwd)}`);
  };

  const cloneFrom = async (messageId: string) => {
    if (!currentSession || currentSession.draft || active) return;
    const result = await cloneSession(currentSession.id, `${currentSession.title || t('sidebar.untitled')} (copy)`, messageId);
    if (!result.success || !result.data) {
      setNotice(result.error || t('session.cloneFailed'));
      return;
    }
    const loaded = await getSession(result.data.id);
    if (loaded.success && loaded.data) syncSession(loaded.data);
    navigate(`/chat/${encodeURIComponent(result.data.id)}?cwd=${encodeURIComponent(workspace!.cwd)}`);
  };

  const toggleBranches = async () => {
    const next = !branchesOpen;
    setBranchesOpen(next);
    if (!next || !currentSession || currentSession.draft) return;
    const result = await getSessionTree(currentSession.branchId || currentSession.id);
    if (result.success && result.data) setBranches(result.data);
  };

  const toggleCapabilities = async () => {
    const next = !capabilitiesOpen;
    setCapabilitiesOpen(next);
    if (!next || !currentSession || currentSession.draft) return;
    const result = await getAgentCapabilities(currentSession.id);
    if (result.success && result.data) setCapabilities(result.data);
    else setNotice(result.error || t('chat.capabilitiesFailed'));
  };

  const toggleInfo = async () => {
    const next = !infoOpen;
    setInfoOpen(next);
    if (!next || !currentSession || currentSession.draft) return;
    const result = await getSessionInfo(currentSession.id);
    if (result.success && result.data) setInfo(result.data);
    else setNotice(result.error || t('session.infoFailed'));
  };

  const stop = async () => {
    if (compacting) {
      compactionController.current?.abort();
      return;
    }
    if (!currentRun) return;
    const result = await stopAgentRun(currentRun.id);
    if (!result.success) setNotice(result.error || t('chat.stopFailed'));
    else if (result.data) setRun(currentSession!.id, result.data);
  };

  const loadHistoryBefore = async (beforeMessageId?: string) => {
    if (!id || id.startsWith('draft:') || loadingHistory || !beforeMessageId) return;
    const container = messagesContainerRef.current;
    const anchor = document.getElementById(beforeMessageId);
    if (container && anchor) {
      pendingScrollAnchor.current = {
        messageId: beforeMessageId,
        offset: anchor.getBoundingClientRect().top - container.getBoundingClientRect().top,
        scrollTop: container.scrollTop,
        scrollHeight: container.scrollHeight,
        messageCount: currentSession?.messages.length ?? 0,
      };
    }
    setLoadingHistory(true);
    const result = await getSessionMessages(id, { before: beforeMessageId, limit: 80 });
    if (result.success && result.data) mergeMessagePage(id, result.data);
    else {
      pendingScrollAnchor.current = undefined;
      setNotice(result.error || t('chat.historyLoadFailed'));
    }
    setLoadingHistory(false);
  };

  const scrollToMessage = (messageId: string) => {
    lastScrolledTarget.current = undefined;
    navigate(`${location.pathname}${location.search}#${encodeURIComponent(messageId)}`, { replace: true });
    window.setTimeout(() => document.getElementById(messageId)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 0);
  };

  const scrollToBottom = () => {
    const container = messagesContainerRef.current;
    if (location.hash) navigate(`${location.pathname}${location.search}`, { replace: true });
    container?.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
    nearBottomRef.current = true;
    readingBaselineCount.current = currentSession?.messages.length ?? 0;
    setNearBottom(true);
    setUnseenMessages(0);
  };

  const scheduleScrollSave = (container: HTMLElement) => {
    if (!currentSession?.id || !workspace?.cwd) return;
    if (scrollSaveTimer.current !== undefined) window.clearTimeout(scrollSaveTimer.current);
    const sessionId = currentSession.id;
    const cwd = workspace.cwd;
    const position = captureSessionScroll(container);
    latestSessionScroll.current = { cwd, sessionId, position };
    scrollSaveTimer.current = window.setTimeout(() => {
      const latest = latestSessionScroll.current;
      if (latest && latest.sessionId === sessionId && latest.cwd === cwd) {
        writeSessionScroll(cwd, sessionId, latest.position);
      }
      scrollSaveTimer.current = undefined;
    }, 180);
  };

  const quoteSelection = (newChat: boolean) => {
    if (!selection) return;
    const quoted = `${selection.text.split('\n').map(line => `> ${line}`).join('\n')}\n\n`;
    if (newChat) {
      createLocalSession();
      const draftId = useSessionStore.getState().activeSessionId;
      if (draftId) {
        setDraft(draftId, quoted);
        navigate(`/chat/${encodeURIComponent(draftId)}?cwd=${encodeURIComponent(workspace?.cwd ?? '')}`);
      }
    } else setDraft(currentSession!.id, `${input}${input && !input.endsWith('\n') ? '\n\n' : ''}${quoted}`);
    window.getSelection()?.removeAllRanges();
    setSelection(undefined);
    window.setTimeout(() => textareaRef.current?.focus(), 0);
  };

  const copyMessage = async (message: Message) => {
    try {
      if (!navigator.clipboard) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(message.content);
      setCopiedMessageId(message.id);
      window.setTimeout(() => setCopiedMessageId(current => current === message.id ? undefined : current), 1_500);
    } catch {
      setNotice(t('chat.copyFailed'));
    }
  };

  const historyGaps = historyGapMessageIds(currentSession);
  const historyPage = currentSession?.messagePage;
  const sessionIndex = sessions.findIndex(session => session.id === currentSession?.id);
  const previousSession = sessionIndex > 0 ? sessions[sessionIndex - 1] : undefined;
  const nextSession = sessionIndex >= 0 && sessionIndex + 1 < sessions.length ? sessions[sessionIndex + 1] : undefined;
  const navigateToSession = (sessionId: string) => navigate(
    `/chat/${encodeURIComponent(sessionId)}?cwd=${encodeURIComponent(workspace?.cwd ?? '')}`,
  );

  if (!currentSession) {
    if (id && sessionUnavailable) {
      const fallback = sessions.find(session => session.id !== id);
      return <div className="chat-empty" role="alert">
        <h2>{t('chat.sessionUnavailable')}</h2>
        <p>{sessionUnavailable}</p>
        <button onClick={() => fallback ? navigateToSession(fallback.id) : navigate(`/?cwd=${encodeURIComponent(workspace?.cwd ?? '')}`)}>
          {fallback ? t('chat.openAvailableSession') : t('chat.returnToConversations')}
        </button>
      </div>;
    }
    if (id) return <div className="chat-empty" role="status">{t('common.loading')}…</div>;
    return (
      <div className="chat-empty">
        <h2>{t('chat.welcome')}</h2>
        <p>{t('chat.selectOrCreate')}</p>
      </div>
    );
  }

  const messageArticle = (message: Message) => <article id={message.id} className={`message ${message.role}`}
    aria-label={`${message.role}: ${message.content.slice(0, 80)}`}>
    <div className="message-role">
      {message.role === 'user' ? `👤 ${t('chat.role.user')}`
        : message.role === 'tool' ? `🔧 ${message.name || t('chat.role.tool')}`
          : message.role === 'system' ? t('chat.role.system')
            : `🤖 ${t('chat.role.assistant')}`}
    </div>
    <div className="message-content">{renderMessage(message, preferences.reasoningOpen, t)}</div>
    <footer className="message-meta">
      <time dateTime={message.timestamp.toISOString()}>{message.timestamp.toLocaleTimeString()}</time>
      {message.model && <span>{message.model}</span>}
      {message.usage && <span title={messageUsageDetails(message.usage)}>{messageUsageSummary(message.usage)}</span>}
      <button onClick={() => void copyMessage(message)} aria-live="polite">
        {copiedMessageId === message.id ? t('chat.copied') : t('chat.copy')}
      </button>
      {!currentSession.draft && !active && message.role === 'user' && (
        <>
          <button onClick={() => void branchFrom(message.id, message.content, true)}>{t('session.editFromHere')}</button>
          <button onClick={() => void cloneFrom(message.id)}>{t('session.newFromHere')}</button>
        </>
      )}
    </footer>
  </article>;

  const historyGap = (messageId: string) => historyGaps.has(messageId) && (
    <div className="history-gap" role="separator">
      <span>{t('chat.historyGap')}</span>
      <button disabled={loadingHistory} onClick={() => void loadHistoryBefore(messageId)}>
        {t('chat.loadMissing')}
      </button>
    </div>
  );

  return (
    <div className="chat-view">
      <header className="chat-toolbar">
        <div>
          <strong>{currentSession.title || t('sidebar.untitled')}</strong>
          <small>{workspace?.cwd}</small>
        </div>
        <div className="chat-toolbar-actions">
          {!currentSession.draft && sessions.length > 1 && <div className="session-navigation" role="group" aria-label={t('session.navigation')}>
            <button className="toolbar-button" disabled={!previousSession}
              onClick={() => previousSession && navigateToSession(previousSession.id)} aria-label={t('session.previous')}>←</button>
            <button className="toolbar-button" disabled={!nextSession}
              onClick={() => nextSession && navigateToSession(nextSession.id)} aria-label={t('session.next')}>→</button>
          </div>}
          <span className={`agent-phase ${active ? 'active' : ''}`} role="status">{status}</span>
          {!currentSession.draft && <SubagentPanel
            parentSessionId={currentSession.metadata?.subagent === true && currentSession.parentId
              ? currentSession.parentId
              : currentSession.id}
            parentLinkId={currentSession.metadata?.subagent === true ? currentSession.parentId : undefined} />}
          {!currentSession.draft && <button className="toolbar-button" onClick={() => void toggleBranches()}>{t('session.branches')}</button>}
          {!currentSession.draft && <button className="toolbar-button" onClick={() => void toggleCapabilities()}>{t('chat.context')}</button>}
          {!currentSession.draft && <button className="toolbar-button" onClick={() => void toggleInfo()}>{t('session.info')}</button>}
          {!currentSession.draft && (historyPage?.total ?? currentSession.messages.length) > 8 && (
            <button className="toolbar-button" aria-expanded={minimapOpen}
              onClick={() => setMinimapOpen(open => !open)}>{t('chat.minimap')}</button>
          )}
          {(active || compacting) && <button className="stop-button" onClick={() => void stop()}>{stopLabel}</button>}
        </div>
      </header>

      {currentRun?.retry && (
        <section className="retry-status" role="status">
          <strong>{t('chat.retryScheduled', { attempt: currentRun.retry.attempt, max: currentRun.retry.max })}</strong>
          <span>{currentRun.retry.message}</span>
        </section>
      )}

      {extensionWidgets.length > 0 && <aside className="extension-widgets" aria-label={t('chat.extensionWidgets')}>
        {extensionWidgets.map(widget => <details key={`${widget.extensionId}:${widget.name}`}>
          <summary>{widget.name}</summary><pre>{widget.content}</pre>
        </details>)}
      </aside>}

      {currentRun?.extensionRequest && <ExtensionInteractionDialog
        key={currentRun.extensionRequest.id}
        request={currentRun.extensionRequest}
        restoreFocusRef={textareaRef}
        onResolve={async result => {
          const response = await respondToExtensionInteraction(currentSession.id, currentRun.extensionRequest!.id, result);
          if (response.success && response.data) setRun(currentSession.id, response.data);
          else setNotice(response.error || t('chat.extensionInteractionFailed'));
          window.requestAnimationFrame(() => textareaRef.current?.focus());
        }} t={t} />}

      {!currentSession.draft && (
        <nav className="mobile-chat-actions" aria-label={t('chat.mobileActions')}>
          {sessions.length > 1 && <>
            <button disabled={!previousSession} onClick={() => previousSession && navigateToSession(previousSession.id)}>
              <span>{t('session.previous')}</span>
            </button>
            <button disabled={!nextSession} onClick={() => nextSession && navigateToSession(nextSession.id)}>
              <span>{t('session.next')}</span>
            </button>
          </>}
          <button onClick={() => void toggleBranches()}><span>{t('session.branches')}</span></button>
          <button onClick={() => void toggleCapabilities()}><span>{t('chat.context')}</span></button>
          <button onClick={() => void toggleInfo()}><span>{t('session.info')}</span></button>
          {(historyPage?.total ?? currentSession.messages.length) > 8 && (
            <button aria-expanded={minimapOpen} onClick={() => setMinimapOpen(open => !open)}><span>{t('chat.minimap')}</span></button>
          )}
        </nav>
      )}

      {branchesOpen && (
        <nav className="branch-panel" aria-label={t('session.branches')}>
          {branches.map(branch => (
            <button key={branch.id} style={{ paddingLeft: `${.6 + branch.depth * .8}rem` }}
              className={branch.id === currentSession.id ? 'active' : ''}
              onClick={() => navigate(`/chat/${encodeURIComponent(branch.id)}?cwd=${encodeURIComponent(workspace!.cwd)}`)}>
              {branch.title || t('sidebar.untitled')}
            </button>
          ))}
        </nav>
      )}

      {capabilitiesOpen && capabilities && (
        <section className="capabilities-panel">
          <details open>
            <summary>{t('chat.systemPrompt')}</summary>
            <pre>{capabilities.systemPrompt || t('chat.systemPromptEmpty')}</pre>
          </details>
          <details open>
            <summary>{t('chat.activeTools', { count: capabilities.tools.length })}</summary>
            {capabilities.tools.map(tool => (
              <details key={tool.name} className="tool-definition">
                <summary>{tool.name}</summary>
                <p>{tool.description}</p>
                <pre>{JSON.stringify(tool.parameters, null, 2)}</pre>
              </details>
            ))}
          </details>
        </section>
      )}

      {infoOpen && info && (
        <aside className="session-info" aria-label={t('session.info')}>
          <button className="info-close" onClick={() => setInfoOpen(false)} aria-label={t('common.close')}>×</button>
          <dl>
            <dt>ID</dt><dd>{info.id} <button onClick={() => void navigator.clipboard?.writeText(info.id)}>{t('chat.copy')}</button></dd>
            <dt>{t('session.file')}</dt><dd>{info.file} <button onClick={() => void navigator.clipboard?.writeText(info.file)}>{t('chat.copy')}</button></dd>
            <dt>{t('workspace.label')}</dt><dd>{info.cwd || '—'} {info.cwd && <button onClick={() => void navigator.clipboard?.writeText(info.cwd!)}>{t('chat.copy')}</button>}</dd>
            <dt>{t('session.gitBranch')}</dt><dd>{info.gitBranch || workspace?.git?.branch || '—'}</dd>
            <dt>{t('session.model')}</dt><dd>{[info.provider, info.model].filter(Boolean).join(' / ') || '—'}</dd>
            <dt>{t('session.duration')}</dt><dd>{formatDuration(info.durationMs)}</dd>
            <dt>{t('session.messages')}</dt><dd>{info.counts.total} ({info.counts.user} {t('session.users')} / {info.counts.assistant} {t('session.assistants')})</dd>
            <dt>{t('session.tools')}</dt><dd>{info.counts.toolCalls} / {info.counts.toolResults} {t('session.callsAndResults')}</dd>
            <dt>{t('session.tokens')}</dt><dd>{info.usage?.totalTokens ?? '—'} ({info.usage?.inputTokens ?? 0} / {info.usage?.outputTokens ?? 0})</dd>
            <dt>{t('session.contextWindow')}</dt><dd>{info.contextUsedTokens ?? '—'} / {info.contextWindowTokens ?? '—'}{info.contextUtilization === undefined ? '' : ` (${(info.contextUtilization * 100).toFixed(1)}%)`}</dd>
            <dt>{t('session.cache')}</dt><dd>{info.usage?.cacheReadTokens ?? 0} / {info.usage?.cacheWriteTokens ?? 0}{info.cacheHitRate === undefined ? '' : ` · ${(info.cacheHitRate * 100).toFixed(1)}%`}</dd>
            <dt>{t('session.cost')}</dt><dd>{info.usage?.costUsd === undefined ? '—' : `$${info.usage.costUsd.toFixed(6)}`}</dd>
          </dl>
          <a href={`/api/sessions/${encodeURIComponent(info.id)}/export?format=json`} download>{t('session.export')}</a>
        </aside>
      )}

      {minimapOpen && (
        <aside className="conversation-minimap" aria-label={t('chat.minimap')}>
          <header>
            <strong>{t('chat.minimap')}</strong>
            <span>{t('chat.historyLoaded', {
              loaded: currentSession.messages.length,
              total: historyPage?.total ?? currentSession.messages.length,
            })}</span>
            <button onClick={() => setMinimapOpen(false)} aria-label={t('common.close')}>×</button>
          </header>
          <nav>
            {currentSession.messages.map(message => {
              const tool = message.blocks?.find(block => block.type === 'tool_call' || block.type === 'tool_result');
              const kind = tool ? 'tool' : message.role;
              const preview = tool && 'name' in tool
                ? `${tool.type === 'tool_call' ? 'Tool' : 'Result'}: ${tool.name || message.name || 'tool'}`
                : message.content.replace(/\s+/g, ' ').slice(0, 44) || message.role;
              return (
                <Fragment key={`minimap:${message.id}`}>
                  {historyGaps.has(message.id) && <span className="minimap-gap" aria-label={t('chat.historyGap')}>⋯</span>}
                  <button className={`minimap-entry ${kind}`} onClick={() => scrollToMessage(message.id)}
                    aria-label={`${kind}: ${preview}`} title={message.content.slice(0, 160)}>
                    <span aria-hidden="true" />
                    <small>{preview}</small>
                  </button>
                </Fragment>
              );
            })}
          </nav>
          <footer>
            <button onClick={scrollToBottom}>{t('chat.latestMessages')}</button>
            <a href={`/api/sessions/${encodeURIComponent(currentSession.id)}/export?format=json`} download>{t('session.export')}</a>
          </footer>
        </aside>
      )}

      <div ref={messagesContainerRef} className="messages-container" role="log" aria-label={t('chat.conversation')}
        aria-live="polite" aria-relevant="additions" aria-busy={active} data-virtualized={virtualized}
        onScroll={event => {
          const element = event.currentTarget;
          const next = element.scrollHeight - element.scrollTop - element.clientHeight < 96;
          const wasNearBottom = nearBottomRef.current;
          nearBottomRef.current = next;
          setNearBottom(next);
          if (next) {
            readingBaselineCount.current = currentSession.messages.length;
            setUnseenMessages(0);
          } else if (wasNearBottom) {
            readingBaselineCount.current = currentSession.messages.length;
          }
          scheduleScrollSave(element);
        }} onMouseUp={() => {
        if (!preferences.selectionActions) return;
        const selected = window.getSelection();
        const text = selected?.toString().trim();
        if (!text || !selected?.rangeCount) {
          setSelection(undefined);
          return;
        }
        const rect = selected.getRangeAt(0).getBoundingClientRect();
        setSelection({ text: text.slice(0, 10_000), x: rect.left + rect.width / 2, y: rect.top });
      }}>
        {historyPage?.hasMoreBefore && currentSession.messages[0] && (
          <div className="history-page-control">
            <button disabled={loadingHistory}
              onClick={() => void loadHistoryBefore(currentSession.messages[0]!.id)}>
              {loadingHistory ? `${t('common.loading')}…` : t('chat.loadEarlier')}
            </button>
          </div>
        )}
        {virtualized ? (
          <div className="virtual-message-list" style={{ height: `${messageVirtualizer.getTotalSize()}px` }}>
            {messageVirtualizer.getVirtualItems().map(item => {
              const message = currentSession.messages[item.index]!;
              return <div key={item.key} data-index={item.index} ref={messageVirtualizer.measureElement}
                className="virtual-message-row" style={{ transform: `translateY(${item.start}px)` }}>
                {historyGap(message.id)}
                {messageArticle(message)}
              </div>;
            })}
          </div>
        ) : currentSession.messages.map(message => (
          <Fragment key={message.id}>
            {historyGap(message.id)}
            {messageArticle(message)}
          </Fragment>
        ))}
        {currentSession.commands?.map(command => (
          <article key={command.id} className="message command">
            <div className="message-role">⌘ {command.command}</div>
            <div className="message-content">
              <pre>{command.output || `[${command.status}]`}</pre>
            </div>
            <footer className="message-meta">
              <time dateTime={command.timestamp.toISOString()}>{command.timestamp.toLocaleTimeString()}</time>
              <span>{command.exitCode === undefined ? command.status : `exit ${command.exitCode}`}</span>
              <span>{command.excludedFromContext ? t('chat.commandExcluded') : t('chat.commandIncluded')}</span>
            </footer>
          </article>
        ))}
        <div ref={messagesEndRef} />
      </div>
      {!nearBottom && (
        <button className="scroll-bottom" onClick={scrollToBottom} aria-label={t('chat.backToBottom')}>
          ↓ {t('chat.backToBottom')}{unseenMessages ? ` (${unseenMessages})` : ''}
        </button>
      )}

      {selection && (
        <div className="selection-actions" role="toolbar" aria-label={t('chat.selectionActions')}
          style={{ left: selection.x, top: selection.y }}>
          <button onClick={() => quoteSelection(false)}>{t('chat.askHere')}</button>
          <button onClick={() => quoteSelection(true)}>{t('chat.askNew')}</button>
        </div>
      )}

      {commandRun && (
        <section className="command-run" aria-live="polite">
          <header><code>$ {commandRun.command}</code><span>{commandRun.status}</span>
            {commandRun.status === 'running' && <button onClick={() => void cancelCommand(commandRun.id).then(result => {
              if (result.success && result.data) setCommandRun(result.data);
            })}>{t('chat.stop.command')}</button>}
          </header>
          <pre>{commandRun.output || t('chat.commandWaiting')}</pre>
          <footer>{commandRun.exitCode === undefined ? '' : `exit ${commandRun.exitCode}`}{commandRun.excludedFromContext ? ` · ${t('chat.commandExcluded')}` : ` · ${t('chat.commandIncluded')}`}</footer>
        </section>
      )}

      {active && currentRun && (currentRun.steerQueue.length > 0 || currentRun.followUpQueue.length > 0) && (
        <div className="agent-queues" role="region" aria-label={t('chat.queues')}>
          {([
            [t('chat.steerQueue'), currentRun.steerQueue],
            [t('chat.followUpQueue'), currentRun.followUpQueue],
          ] as const).map(([label, queue]) => (
            <section key={label}>
              <strong>{label}: {queue.length}</strong>
              {queue.map(message => (
                <button key={message.id} title={t('chat.recallQueued')} onClick={() => {
                  setDraft(currentSession.id, message.content);
                  window.setTimeout(() => textareaRef.current?.focus(), 0);
                }}>{message.content}</button>
              ))}
            </section>
          ))}
          <button className="clear-queues" onClick={() => void clearAgentQueue(currentRun.id).then(result => {
            if (result.success && result.data) setRun(currentSession.id, result.data);
          })}>{t('chat.clearQueues')}</button>
        </div>
      )}

      <form onSubmit={handleSubmit} className="input-container"
        onDragOver={event => { if ([...event.dataTransfer.items].some(item => item.type.startsWith('image/'))) event.preventDefault(); }}
        onDrop={event => {
          const files = [...event.dataTransfer.files].filter(file => file.type.startsWith('image/'));
          if (files.length) {
            event.preventDefault();
            void attachImages(files);
          }
        }}>
        {paletteResults.length > 0 && (
          <div className="command-palette" role="listbox" aria-label={t('chat.commandPalette')}>
            {paletteResults.map((item, index) => (
              <button key={`${item.source}:${item.name}`} type="button" role="option"
                aria-selected={index === paletteIndex} className={index === paletteIndex ? 'active' : ''}
                onMouseDown={event => event.preventDefault()}
                onClick={() => setDraft(currentSession.id, `/${item.name} `)}>
                <strong>/{item.name}</strong><span>{item.description}</span><small>{item.source}</small>
              </button>
            ))}
          </div>
        )}
        {fileResults.length > 0 && (
          <div className="command-palette file-palette" role="listbox" aria-label={t('chat.filePalette')}>
            {fileResults.map((item, index) => (
              <button key={`${item.isDirectory ? 'directory' : 'file'}:${item.path}`} type="button" role="option"
                aria-selected={index === paletteIndex} className={index === paletteIndex ? 'active' : ''}
                onMouseDown={event => event.preventDefault()}
                onClick={() => insertFileSuggestion(item)}>
                <strong>{item.isDirectory ? '📁' : '📄'} {item.path}</strong>
                <small>{item.isDirectory ? t('files.directory') : t('files.file')}</small>
              </button>
            ))}
          </div>
        )}
        {attachments.length > 0 && (
          <div className="attachment-previews" aria-label={t('chat.attachments')}>
            {attachments.map(attachment => (
              <figure key={attachment.id}>
                <img src={attachment.url} alt={attachment.name} />
                <figcaption>{attachment.name}</figcaption>
                <button type="button" onClick={() => removeAttachment(currentSession.id, attachment.id)} aria-label={t('chat.removeAttachment', { name: attachment.name })}>×</button>
              </figure>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={input}
          onChange={event => {
            setDraft(currentSession.id, event.target.value);
            setPaletteIndex(0);
          }}
          onKeyDown={handleKeyDown}
          onPaste={event => {
            const files = [...event.clipboardData.files].filter(file => file.type.startsWith('image/'));
            if (files.length) {
              event.preventDefault();
              void attachImages(files);
              return;
            }
            const html = event.clipboardData.getData('text/html');
            if (html) {
              const markdown = clipboardHtmlToMarkdown(html);
              if (!markdown) return;
              event.preventDefault();
              const start = event.currentTarget.selectionStart;
              const end = event.currentTarget.selectionEnd;
              setDraft(currentSession.id, `${input.slice(0, start)}${markdown}${input.slice(end)}`);
            }
          }}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => { composingRef.current = false; }}
          placeholder={t('chat.inputPlaceholder', { provider: activeProviderType })}
          aria-label={t('chat.inputLabel')}
          autoFocus
          rows={1}
          disabled={starting || busyCompacting}
        />
        <div className="composer-controls">
          <input ref={imageInputRef} className="visually-hidden" type="file" accept="image/*" multiple
            aria-label={t('chat.addImage')}
            onChange={event => {
              const files = [...(event.target.files ?? [])];
              if (files.length) void attachImages(files);
              event.target.value = '';
            }} />
          <button type="button" className="attach-button" onClick={() => imageInputRef.current?.click()} aria-label={t('chat.addImage')}>＋📷</button>
          <label>
            <span className="visually-hidden">{t('settings.model')}</span>
            <input
              list="model-suggestions"
              value={modelLocked || currentSession.model === undefined ? '' : currentSession.model}
              placeholder={`${t('chat.setting.auto')} · ${model}`}
              title={t('chat.settingScope', { scope: t(`chat.scope.${modelScope}`) })}
              aria-label={t('settings.selectModel')}
              disabled={modelLocked}
              onChange={event => void changeSetting('model', event.target.value || undefined)}
            />
            <datalist id="model-suggestions">{modelSuggestions(activeProviderType, modelCatalog).map(item => <option key={item} value={item} />)}</datalist>
          </label>
          <select
            className="composer-setting"
            value={thinkingLocked || currentSession.thinking === undefined ? 'auto' : currentSession.thinking}
            title={t('chat.settingScope', { scope: t(`chat.scope.${thinkingScope}`) })}
            aria-label={t('chat.thinking')}
            disabled={thinkingLocked}
            onChange={event => void changeSetting('thinking', event.target.value === 'auto'
              ? undefined
              : event.target.value as Session['thinking'])}>
            <option value="auto">{t('chat.setting.auto')} · {thinking}</option>
            {['off', 'low', 'medium', 'high', 'xhigh', 'max'].map(level => <option key={level} value={level}>{level}</option>)}
          </select>
          <select
            className="composer-setting"
            value={toolPresetLocked || currentSession.toolPreset === undefined ? 'auto' : currentSession.toolPreset}
            title={modelSupportsTools
              ? t('chat.settingScope', { scope: t(`chat.scope.${toolPresetScope}`) })
              : t('chat.toolsUnsupported')}
            aria-label={t('chat.toolsPreset')}
            disabled={toolPresetLocked || !modelSupportsTools}
            onChange={event => void changeSetting('toolPreset', event.target.value === 'auto'
              ? undefined
              : event.target.value as Session['toolPreset'])}>
            <option value="auto">{t('chat.setting.auto')} · {toolPreset}</option>
            {['configured', 'chat-only', 'read-only', 'default', 'full'].map(preset => <option key={preset} value={preset}>{preset}</option>)}
          </select>
          <select
            className="composer-setting"
            value={autoCompactionLocked || currentSession.autoCompaction === undefined
              ? 'auto'
              : String(currentSession.autoCompaction)}
            title={t('chat.settingScope', { scope: t(`chat.scope.${autoCompactionScope}`) })}
            aria-label={t('chat.autoCompaction')}
            disabled={autoCompactionLocked}
            onChange={event => void changeSetting('autoCompaction', event.target.value === 'auto'
              ? undefined
              : event.target.value === 'true')}>
            <option value="auto">{t('chat.setting.auto')} · {autoCompaction ? t('common.on') : t('common.off')}</option>
            <option value="true">{t('common.on')}</option>
            <option value="false">{t('common.off')}</option>
          </select>
          {active && (
            <select className="queue-mode" value={queueMode} aria-label={t('chat.queueMode')} onChange={event => setQueueMode(event.target.value as QueueMode)}>
              <option value="steer">{t('chat.steer')}</option>
              <option value="follow-up">{t('chat.followUp')}</option>
            </select>
          )}
          <button type="submit" disabled={!canSend}>{starting ? '…' : active ? t('chat.queue') : t('chat.send')}</button>
        </div>
        <div className="composer-setting-scopes" aria-label={t('chat.settingScopes')}>
          <span>{t('settings.model')}: {t(`chat.scope.${modelScope}`)}</span>
          <span>{t('chat.thinking')}: {t(`chat.scope.${thinkingScope}`)}</span>
          <span>{t('chat.tools')}: {t(`chat.scope.${toolPresetScope}`)}</span>
          <span>{t('chat.autoCompaction')}: {t(`chat.scope.${autoCompactionScope}`)}</span>
        </div>
      </form>
    </div>
  );
}

function ExtensionInteractionDialog({ request, onResolve, restoreFocusRef, t }: {
  request: ExtensionInteractionSnapshot;
  onResolve(response: { cancelled: boolean; value?: unknown }): Promise<void>;
  restoreFocusRef: RefObject<HTMLElement | null>;
  t: TranslationFunction;
}) {
  const initial = request.kind === 'custom'
    ? Object.fromEntries((request.fields ?? []).map(field => [field.name,
        field.type === 'checkbox' ? false : field.type === 'select' && field.required ? field.options?.[0]?.value ?? '' : '']))
    : request.kind === 'select' ? request.options?.[0]?.value ?? '' : '';
  const [value, setValue] = useState<unknown>(initial);
  const [submitting, setSubmitting] = useState(false);
  const custom = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const resolve = async (response: { cancelled: boolean; value?: unknown }) => {
    if (submitting) return;
    setSubmitting(true);
    try { await onResolve(response); } finally { setSubmitting(false); }
  };
  const dialogRef = useRef<HTMLFormElement>(null);
  useFocusTrap(true, dialogRef, () => { void resolve({ cancelled: true }); }, restoreFocusRef);
  return <div className="modal-overlay extension-interaction-overlay" onMouseDown={event => {
    if (!submitting && event.target === event.currentTarget) void resolve({ cancelled: true });
  }}>
    <form ref={dialogRef} tabIndex={-1} className="extension-interaction" role="dialog" aria-modal="true" aria-labelledby={`extension-title-${request.id}`}
      onSubmit={event => { event.preventDefault(); void resolve({ cancelled: false, value: request.kind === 'confirm' ? true : value }); }}>
      <header><h3 id={`extension-title-${request.id}`}>{request.title}</h3></header>
      {request.message && <p>{request.message}</p>}
      {request.output && (/\u001b\[[0-9;]*m/.test(request.output)
        ? <AnsiOutput content={request.output} /> : <pre className="extension-output">{request.output}</pre>)}
      {request.kind === 'input' && <input data-autofocus required value={String(value)} placeholder={request.placeholder}
        onChange={event => setValue(event.target.value)} aria-label={request.title} />}
      {request.kind === 'editor' && <textarea data-autofocus required rows={10} value={String(value)} placeholder={request.placeholder}
        onChange={event => setValue(event.target.value)} aria-label={request.title} />}
      {request.kind === 'select' && <select data-autofocus value={String(value)} onChange={event => setValue(event.target.value)} aria-label={request.title}>
        {request.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>}
      {request.kind === 'custom' && <details className="extension-custom-panel" open>
        <summary>{t('chat.extensionInteraction.fields')}</summary>
        <div className="extension-fields">
          {request.fields?.map(field => <label key={field.name}>
            <span>{field.label}</span>
            {field.type === 'textarea' ? <textarea required={field.required} placeholder={field.placeholder}
              value={String(custom[field.name] ?? '')} onChange={event => setValue({ ...custom, [field.name]: event.target.value })} />
              : field.type === 'select' ? <select required={field.required} value={String(custom[field.name] ?? '')}
                onChange={event => setValue({ ...custom, [field.name]: event.target.value })}>
                {!field.required && <option value="" />}
                {field.options?.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
                : field.type === 'checkbox' ? <input type="checkbox" checked={custom[field.name] === true}
                  onChange={event => setValue({ ...custom, [field.name]: event.target.checked })} />
                  : <input required={field.required} placeholder={field.placeholder} value={String(custom[field.name] ?? '')}
                    onChange={event => setValue({ ...custom, [field.name]: event.target.value })} />}
          </label>)}
        </div>
      </details>}
      <footer>
        <button type="button" disabled={submitting} onClick={() => void resolve({ cancelled: true })}>{t('common.cancel')}</button>
        <button type="submit" disabled={submitting}>{request.kind === 'confirm' ? t('common.confirm') : t('common.submit')}</button>
      </footer>
    </form>
  </div>;
}

function renderMessage(message: Message, reasoningOpen: boolean, t: TranslationFunction): ReactNode {
  const reasoning = message.blocks?.filter(block => block.type === 'reasoning') ?? [];
  const images = message.blocks?.filter(block => block.type === 'image') ?? [];
  const toolBlocks = message.blocks?.filter(block => block.type === 'tool_call' || block.type === 'tool_result' || block.type === 'command') ?? [];
  const writtenFiles = findWrittenFiles(toolBlocks);
  const processCount = reasoning.length + toolBlocks.length;
  return (
    <>
      {processCount > 0 && <section className="agent-process" aria-label={t('chat.process')}>
        <header>
          <strong>{t('chat.process')}</strong>
          <span>{t('chat.processSteps', { count: processCount })}</span>
          {message.model && <code>{message.provider ? `${message.provider}/` : ''}{message.model}</code>}
          {message.durationMs !== undefined && <small>{Math.max(0, message.durationMs / 1_000).toFixed(2)}s</small>}
          {message.usage?.totalTokens !== undefined && <small>{message.usage.totalTokens.toLocaleString()} tokens</small>}
          {message.usage?.costUsd !== undefined && <small>${message.usage.costUsd.toFixed(6)}</small>}
        </header>
        {reasoning.map((block, index) => block.type === 'reasoning' && (
          <ProcessBlock className="reasoning-block" key={`reasoning-${index}`}
            summary={t('chat.reasoning')} content={block.text} defaultOpen={reasoningOpen}
            filename={`reasoning-${message.id}.txt`} t={t} />
        ))}
        {toolBlocks.map((block, index) => {
          const content = block.type === 'tool_call' ? JSON.stringify(block.input, null, 2)
            : (block.type === 'tool_result' ? block.content : block.output) ?? '';
          const fullContent = block.type === 'tool_result' ? block.fullContent : undefined;
          const summary = block.type === 'tool_call' ? `${t('chat.toolCall')}: ${block.name}`
            : block.type === 'tool_result' ? `${block.isError ? t('chat.toolError') : t('chat.toolResult')}: ${block.name || ''}`
              : `${t('chat.command')}: ${block.command}`;
          return <ProcessBlock className="tool-block" key={`tool-${index}`} summary={summary}
            content={content} fullContent={fullContent} truncated={block.type === 'tool_result' && block.truncated}
            filename={`${block.type === 'command' ? 'command' : block.type === 'tool_call' ? block.name : block.name || 'tool-result'}-${message.id}.txt`}
            error={block.type === 'tool_result' && block.isError} t={t} />;
        })}
      </section>}
      {(message.content || images.length > 0) && <section className="message-output" aria-label={message.role === 'assistant' ? t('chat.response') : undefined}>
        {message.content && renderMessageContent(message.content)}
        {images.map((block, index) => block.type === 'image' && (
          <a className="message-image" href={block.url} target="_blank" rel="noopener noreferrer" key={`image-${index}`}>
            <img src={block.url} alt={block.name || 'Attachment'} loading="lazy" />
          </a>
        ))}
      </section>}
      {writtenFiles.length > 0 && <div className="files-written" aria-label={t('chat.filesWritten')}>
        <strong>{t('chat.filesWritten')}</strong>
        {writtenFiles.map(file => <button key={file} onClick={() => openWorkspaceFile(file)}>{file}</button>)}
      </div>}
    </>
  );
}

const PROCESS_PREVIEW_LENGTH = 8_000;

function ProcessBlock({ className, summary, content, fullContent, truncated, filename, defaultOpen, error, t }: {
  className: string;
  summary: string;
  content: string;
  fullContent?: string;
  truncated?: boolean;
  filename: string;
  defaultOpen?: boolean;
  error?: boolean;
  t: TranslationFunction;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const complete = fullContent ?? content;
  const long = truncated === true || complete.length > PROCESS_PREVIEW_LENGTH;
  const visible = expanded
    ? complete
    : content.length > PROCESS_PREVIEW_LENGTH ? `${content.slice(0, PROCESS_PREVIEW_LENGTH)}\n…` : content;
  const copy = async () => {
    await navigator.clipboard?.writeText(complete);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1_500);
  };
  return <details className={`${className}${error ? ' error' : ''}`} open={defaultOpen}>
    <summary>{summary}{truncated && <span className="truncated-badge">{t('chat.truncated')}</span>}</summary>
    <div className="process-block-actions" role="toolbar" aria-label={t('chat.blockActions')}>
      <button type="button" onClick={() => void copy()}>{copied ? t('chat.copied') : t('common.copy')}</button>
      {long && <button type="button" onClick={() => setExpanded(value => !value)}>
        {expanded ? t('chat.collapseOutput') : t('chat.expandOutput')}
      </button>}
      {long && <button type="button" onClick={() => downloadText(complete, filename)}>{t('common.download')}</button>}
    </div>
    {/\u001b\[[0-9;]*m/.test(visible) ? <AnsiOutput content={visible} /> : <ToolOutput content={visible} />}
  </details>;
}

function downloadText(content: string, rawFilename: string): void {
  const filename = rawFilename.replace(/[^a-z0-9._-]+/gi, '-').slice(0, 160) || 'output.txt';
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function AnsiOutput({ content }: { content: string }) {
  const colors: Record<number, string> = {
    30: 'black', 31: 'red', 32: 'green', 33: 'yellow', 34: 'blue', 35: 'magenta', 36: 'cyan', 37: 'white',
    90: 'bright-black', 91: 'bright-red', 92: 'bright-green', 93: 'bright-yellow', 94: 'bright-blue',
    95: 'bright-magenta', 96: 'bright-cyan', 97: 'bright-white',
  };
  let color = '';
  let bold = false;
  let cursor = 0;
  const segments: ReactNode[] = [];
  for (const match of content.matchAll(/\u001b\[([0-9;]*)m/g)) {
    if (match.index! > cursor) segments.push(<span key={cursor} className={[color && `ansi-${color}`, bold && 'ansi-bold'].filter(Boolean).join(' ')}>{content.slice(cursor, match.index)}</span>);
    for (const code of (match[1] || '0').split(';').map(Number)) {
      if (code === 0) { color = ''; bold = false; }
      else if (code === 1) bold = true;
      else if (colors[code]) color = colors[code];
    }
    cursor = match.index! + match[0].length;
  }
  if (cursor < content.length) segments.push(<span key={cursor} className={[color && `ansi-${color}`, bold && 'ansi-bold'].filter(Boolean).join(' ')}>{content.slice(cursor)}</span>);
  return <pre className="tool-output ansi-output">{segments}</pre>;
}

function findWrittenFiles(blocks: NonNullable<Message['blocks']>): string[] {
  const files = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value !== 'string') return;
    const candidate = value.trim().replace(/(?:[:#]L?\d+)$/i, '');
    if (/^(?:\.{0,2}\/)?(?:[\w@.+-]+\/)*[\w@.+ -]+\.[a-z0-9]+$/i.test(candidate)) files.add(candidate);
  };
  for (const block of blocks) {
    if (block.type === 'tool_call' && /(?:write|edit|patch|create|save)/i.test(block.name)) {
      const input = block.input as Record<string, unknown>;
      for (const [key, value] of Object.entries(input)) {
        if (/(?:path|file|target|destination)/i.test(key)) add(value);
      }
    } else if (block.type === 'tool_result' && /(?:write|edit|patch|create|save)/i.test(block.name ?? '')) {
      const pattern = /((?:\.{0,2}\/)?(?:[\w@.+-]+\/)*[\w@.+ -]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|css|scss|html|py|rb|rs|go|java|kt|sh|bash|yml|yaml|toml))(?:[:#]L?(\d+))?/gi;
      for (const match of block.content.matchAll(pattern)) add(match[1]);
    }
  }
  return [...files];
}

function openWorkspaceFile(path: string, line?: number): void {
  window.dispatchEvent(new CustomEvent('aih-show-files'));
  window.setTimeout(() => window.dispatchEvent(new CustomEvent('aih-open-file', { detail: { path, line } })), 0);
}

function ToolOutput({ content }: { content: string }) {
  const pathPattern = /((?:\.{0,2}\/)?(?:[\w@.+-]+\/)*[\w@.+ -]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|mdx|css|scss|html|py|rb|rs|go|java|kt|sh|bash|yml|yaml|toml))(?:[:#]L?(\d+))?/gi;
  return <pre className="tool-output">{content.split(pathPattern).map((part, index, values) => {
    if (index % 3 !== 1) return index % 3 === 2 ? null : <Fragment key={index}>{part}</Fragment>;
    const line = values[index + 1] ? Number(values[index + 1]) : undefined;
    return <button key={index} onClick={() => openWorkspaceFile(part, line)}>{part}{line ? `:${line}` : ''}</button>;
  })}</pre>;
}

function renderMessageContent(content: string): ReactNode {
  return <MarkdownContent content={content} />;
}

async function fileDataUrl(file: Blob): Promise<string> {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('Image read failed'));
    reader.readAsDataURL(file);
  });
}

async function prepareImage(file: File): Promise<DraftAttachment> {
  if (file.size > 10 * 1024 * 1024) throw new Error(`Image too large: ${file.name}`);
  let blob: Blob = file;
  if (!['image/gif', 'image/svg+xml'].includes(file.type)) {
    try {
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const compressed = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', .86));
      if (compressed && compressed.size < file.size) blob = compressed;
    } catch { /* Keep the original when browser image decoding is unavailable. */ }
  }
  if (blob.size > 4 * 1024 * 1024) throw new Error(`Compressed image is still too large: ${file.name}`);
  return {
    id: crypto.randomUUID(),
    name: file.name,
    mediaType: blob.type || file.type,
    size: blob.size,
    url: await fileDataUrl(blob),
  };
}

function playCompletionSound(volume = 0.25, attention = false): void {
  try {
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = attention ? 420 : 660;
    gain.gain.setValueAtTime(Math.max(0.001, Math.min(1, volume) * .32), context.currentTime);
    gain.gain.exponentialRampToValueAtTime(.001, context.currentTime + .18);
    oscillator.connect(gain).connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + .18);
    oscillator.addEventListener('ended', () => void context.close());
  } catch { /* Audio is best effort and may require a user gesture. */ }
}

function messageUsageSummary(usage: TokenUsage): string {
  const hasTokens = usage.totalTokens !== undefined || usage.inputTokens !== undefined || usage.outputTokens !== undefined;
  const tokens = usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  return [hasTokens ? `${tokens.toLocaleString()} tokens` : '', usage.costUsd !== undefined ? `$${usage.costUsd.toFixed(4)}` : '']
    .filter(Boolean).join(' · ');
}

function messageUsageDetails(usage: TokenUsage): string {
  return [
    usage.inputTokens !== undefined ? `${usage.inputTokens.toLocaleString()} input` : '',
    usage.outputTokens !== undefined ? `${usage.outputTokens.toLocaleString()} output` : '',
    usage.cacheReadTokens !== undefined ? `${usage.cacheReadTokens.toLocaleString()} cache read` : '',
    usage.cacheWriteTokens !== undefined ? `${usage.cacheWriteTokens.toLocaleString()} cache write` : '',
  ].filter(Boolean).join(' · ');
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1_000));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  return `${hours ? `${hours}h ` : ''}${minutes}m ${seconds % 60}s`;
}

function modelSuggestions(type: ProviderType, catalog?: ModelCatalog): string[] {
  const group = catalog?.providers.find(provider => provider.provider === type);
  if (group) return group.models.filter(model => model.enabled && model.available).map(model => model.id);
  const models: Partial<Record<ProviderType, string[]>> = {
    openai: ['gpt-4o', 'gpt-4.1', 'o3'],
    anthropic: ['claude-3-7-sonnet-latest', 'claude-3-5-haiku-latest'],
    google: ['gemini-2.5-pro', 'gemini-2.0-flash'],
    vertex: ['gemini-2.5-pro', 'gemini-2.0-flash'],
    local: ['local-model'],
    mock: ['mock-model'],
  };
  return models[type] ?? [];
}

export default ChatView;
