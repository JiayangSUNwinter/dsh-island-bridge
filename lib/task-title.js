/** Expand only DSH's first-prompt fallback; preserve deliberate session names. */
export function taskTitle(snapshot, firstPrompt) {
  const title = typeof snapshot?.title === 'string' ? snapshot.title : '';
  if (snapshot?.source?.kind !== 'fallback' || typeof firstPrompt !== 'string') return title;
  const text = firstPrompt
    .replace(/(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu, '')
    .replace(/(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/\u001B[@-_]/gu, '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu, '')
    .replace(/\s+/gu, ' ').trim();
  return text || title;
}
