import type { TranscriptBlock, RawCaptionEntry, MeetingSession } from '@/utils/types';
import type { ExtensionMessage } from '@/utils/messaging';

// --- Storage helper types ---

interface SessionIndexEntry {
  sessionId: string;
  meetingCode: string;
  meetingTitle: string;
  startTimestamp: string;
  endTimestamp: string;
}

// --- Storage helpers ---

async function loadSessionIndex(): Promise<SessionIndexEntry[]> {
  const result = await browser.storage.local.get('sessions-index');
  return (result['sessions-index'] as SessionIndexEntry[]) ?? [];
}

async function saveSessionIndex(index: SessionIndexEntry[]): Promise<void> {
  await browser.storage.local.set({ 'sessions-index': index });
}

async function saveSession(session: MeetingSession): Promise<void> {
  const storageKey = `session-${session.sessionId}`;
  await browser.storage.local.set({ [storageKey]: session });

  const index = await loadSessionIndex();
  const entry: SessionIndexEntry = {
    sessionId: session.sessionId,
    meetingCode: session.meetingCode,
    meetingTitle: session.meetingTitle,
    startTimestamp: session.startTimestamp,
    endTimestamp: session.endTimestamp,
  };

  const existingIdx = index.findIndex((e) => e.sessionId === session.sessionId);
  if (existingIdx >= 0) {
    index[existingIdx] = entry;
  } else {
    index.push(entry);
  }

  await saveSessionIndex(index);
}

async function loadSession(sessionId: string): Promise<MeetingSession | null> {
  const storageKey = `session-${sessionId}`;
  const result = await browser.storage.local.get(storageKey);
  return (result[storageKey] as MeetingSession) ?? null;
}

async function deleteSessionFromStorage(sessionId: string): Promise<void> {
  const storageKey = `session-${sessionId}`;
  await browser.storage.local.remove(storageKey);

  const index = await loadSessionIndex();
  const filtered = index.filter((e) => e.sessionId !== sessionId);
  await saveSessionIndex(filtered);
}

async function enforceSessionLimit(maxSessions: number): Promise<void> {
  const index = await loadSessionIndex();
  if (index.length <= maxSessions) return;

  // Sort by startTimestamp ascending (oldest first)
  const sorted = [...index].sort(
    (a, b) => new Date(a.startTimestamp).getTime() - new Date(b.startTimestamp).getTime(),
  );

  const toDelete = sorted.slice(0, sorted.length - maxSessions);
  for (const entry of toDelete) {
    await deleteSessionFromStorage(entry.sessionId);
  }
}

// --- In-memory state ---

const sessionBuffer = new Map<string, MeetingSession>();
const tabToSession = new Map<number, string>();

// --- Helper to flush and end a session ---

async function flushAndEndSession(sessionId: string): Promise<void> {
  const session = sessionBuffer.get(sessionId);
  if (!session) {
    console.warn('[MTC:BG:DEBUG] flushAndEndSession: session not found in buffer:', sessionId);
    return;
  }

  console.log('[MTC:BG:DEBUG] flushAndEndSession: saving session', sessionId, 'with', session.transcript.length, 'transcript blocks');
  session.endTimestamp = new Date().toISOString();
  await saveSession(session);
  console.log('[MTC:BG:DEBUG] flushAndEndSession: saveSession completed for', sessionId);
  await browser.alarms.clear(`persist-${sessionId}`);
  sessionBuffer.delete(sessionId);

  // Clean up tab mapping
  for (const [tabId, sid] of tabToSession.entries()) {
    if (sid === sessionId) {
      tabToSession.delete(tabId);
      break;
    }
  }

  await enforceSessionLimit(10);
}

// --- Background entry point ---

export default defineBackground(() => {
  // Message handler
  browser.runtime.onMessage.addListener(
    (
      message: ExtensionMessage,
      sender: Browser.runtime.MessageSender,
      sendResponse: (response: unknown) => void,
    ) => {
      const handleMessage = async () => {
        switch (message.type) {
          case 'MEETING_STARTED': {
            const { sessionId, meetingCode, meetingTitle, startTimestamp } = message.payload;
            console.log('[MTC:BG:DEBUG] MEETING_STARTED received:', { sessionId, meetingCode, meetingTitle });

            const session: MeetingSession = {
              sessionId,
              meetingCode,
              meetingTitle,
              startTimestamp,
              endTimestamp: '',
              transcript: [],
              rawTranscript: [],
            };

            sessionBuffer.set(sessionId, session);

            // Track tab association
            if (sender.tab?.id != null) {
              tabToSession.set(sender.tab.id, sessionId);
            }

            // Persist immediately so the session exists in storage
            // even if no TRANSCRIPT_UPDATE arrives before the worker dies
            await saveSession(session);

            // Set up periodic persistence alarm (every 1 minute)
            await browser.alarms.create(`persist-${sessionId}`, {
              periodInMinutes: 1,
            });

            return { success: true, sessionId };
          }

          case 'TRANSCRIPT_UPDATE': {
            const { sessionId, blocks, rawEntries } = message.payload;
            console.log('[MTC:BG:DEBUG] TRANSCRIPT_UPDATE received, sessionId:', sessionId, 'blocks:', blocks.length, 'rawEntries:', rawEntries.length);
            const session = sessionBuffer.get(sessionId);
            if (!session) {
              console.warn('[MTC:BG:DEBUG] Session NOT found in buffer! Available sessions:', [...sessionBuffer.keys()]);
              return { success: false, error: 'Session not found in buffer' };
            }

            session.transcript.push(...blocks);
            session.rawTranscript.push(...rawEntries);
            console.log('[MTC:BG:DEBUG] Session transcript count now:', session.transcript.length, 'raw count:', session.rawTranscript.length);

            // Persist to storage on every update so data survives
            // even if MEETING_ENDED never arrives
            await saveSession(session);
            return { success: true };
          }

          case 'MEETING_ENDED': {
            const { sessionId } = message.payload;
            const endingSession = sessionBuffer.get(sessionId);
            console.log('[MTC:BG:DEBUG] MEETING_ENDED received, sessionId:', sessionId, 'transcript count before save:', endingSession?.transcript.length ?? 'SESSION NOT FOUND');
            await flushAndEndSession(sessionId);
            return { success: true };
          }

          case 'GET_SESSIONS': {
            const index = await loadSessionIndex();
            console.log('[MTC:BG:DEBUG] GET_SESSIONS, index entries:', index.length);
            // Sort by startTimestamp descending (newest first)
            const sorted = [...index].sort(
              (a, b) =>
                new Date(b.startTimestamp).getTime() - new Date(a.startTimestamp).getTime(),
            );

            // Return metadata with transcriptCount instead of full transcript
            const sessions = await Promise.all(
              sorted.map(async (entry) => {
                const session = await loadSession(entry.sessionId);
                if (!session) {
                  console.log('[MTC:BG:DEBUG] GET_SESSIONS: session not found in storage:', entry.sessionId);
                  return {
                    ...entry,
                    transcriptCount: 0,
                  };
                }
                const { transcript, ...metadata } = session;
                console.log('[MTC:BG:DEBUG] GET_SESSIONS: session', entry.sessionId, 'transcriptCount:', transcript.length);
                return {
                  ...metadata,
                  transcriptCount: transcript.length,
                };
              }),
            );

            return { sessions };
          }

          case 'GET_TRANSCRIPT': {
            const { sessionId } = message.payload;
            const session = await loadSession(sessionId);
            return { session };
          }

          case 'DELETE_SESSION': {
            const { sessionId } = message.payload;
            await deleteSessionFromStorage(sessionId);
            return { success: true };
          }

          default:
            return { error: 'Unknown message type' };
        }
      };

      // Execute async handler and send response
      handleMessage()
        .then(sendResponse)
        .catch((err) => {
          console.error('Background message handler error:', err);
          sendResponse({ error: String(err) });
        });

      // Return true to indicate async sendResponse usage
      return true;
    },
  );

  // Periodic persistence via alarms
  browser.alarms.onAlarm.addListener(async (alarm) => {
    if (!alarm.name.startsWith('persist-')) return;

    const sessionId = alarm.name.replace('persist-', '');
    const session = sessionBuffer.get(sessionId);
    if (session) {
      await saveSession(session);
      console.log(`Auto-saved session ${sessionId}`);
    }
  });

  // Tab close protection
  browser.tabs.onRemoved.addListener(async (tabId: number) => {
    const sessionId = tabToSession.get(tabId);
    if (!sessionId) return;

    console.log(`Tab ${tabId} closed, flushing session ${sessionId}`);
    await flushAndEndSession(sessionId);
  });

  console.log('Background script initialized', { id: browser.runtime.id });
});
