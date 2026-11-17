const API_EVENT = 'paj-voice:api:v1';
const STATE_EVENT = 'paj-voice:state:v1';
const INSTRUCTIONS = 'While voice is enabled, use voice_speak for concise, meaningful Captain orchestration reports. '
  + 'Normally speak one sentence of about 30 words or fewer. Essential questions, blockers and results deserve speech. '
  + 'In eyes-free mode, also speak brief meaningful assignment and progress updates even when Captain reporting.progress is false. '
  + 'Select semantic updates deliberately; never narrate tools or read raw worker reports aloud. '
  + 'Own orchestration reporting instead of adding duplicate generic completion summaries. '
  + 'Keep normal detailed screen answers unchanged. Never send the full response as a speech fallback; '
  + 'the voice runtime enforces the maximum spoken length.';

export function createCaptainVoice(events) {
  let enabled = false;
  let listening;
  let api;
  let unregister;
  let syncing = false;

  const release = () => {
    const cleanup = unregister;
    unregister = undefined;
    api = undefined;
    try { cleanup?.(); } catch {}
  };
  const refresh = () => {
    if (!enabled || syncing || !events) return;
    syncing = true;
    try {
      let candidate;
      let querying = true;
      try {
        events.emit(API_EVENT, { reply(value) { if (querying) candidate = value; } });
      } finally { querying = false; }
      if (candidate?.version !== 1 || typeof candidate.getState !== 'function'
        || typeof candidate.registerReporter !== 'function') {
        release();
        return;
      }
      if (candidate === api && unregister) return;
      release();
      const cleanup = candidate.registerReporter({ id: 'paj-captain', instructions: INSTRUCTIONS });
      if (typeof cleanup !== 'function') return;
      api = candidate;
      unregister = cleanup;
    } catch {
      release();
    } finally { syncing = false; }
  };

  return {
    refresh,
    setEnabled(next) {
      enabled = next;
      if (!next) {
        const stop = listening;
        listening = undefined;
        try { stop?.(); } catch {}
        release();
        return;
      }
      if (!listening && events) {
        try { listening = events.on(STATE_EVENT, refresh); } catch {}
      }
      refresh();
    },
  };
}
