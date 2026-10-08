// Best-effort "what device/OS made this" label for bookmark titles — e.g.
// "webaudex win 11 21.42 19.09". Standard User-Agent sniffing can't tell
// Windows 10 from 11 (both report "Windows NT 10.0"); the accurate check
// needs the async, Chromium-only User-Agent Client Hints API. Since a
// bookmark's default title is needed SYNCHRONOUSLY (the moment the user
// opens the dialog, or the moment an auto-bookmark fires), the accurate
// label is resolved once in the background at module load and cached —
// bookmarkTitle() uses whatever's available at call time, falling back to
// a cruder synchronous guess until the real one lands (which is normally
// well before anyone actually creates a bookmark).

let cached: string | null = null;

function crudeGuess(): string {
  const ua = navigator.userAgent;
  if (/Windows/.test(ua)) return "Win";
  if (/Mac OS X/.test(ua)) return "Mac";
  if (/Android/.test(ua)) return "Android";
  if (/iPhone|iPad|iPod/.test(ua)) return "iOS";
  if (/Linux/.test(ua)) return "Linux";
  return "Unknown";
}

async function resolve(): Promise<string> {
  // Not in TS's lib.dom.d.ts yet — a real, shipping API in Chromium browsers.
  const uaData = (navigator as unknown as { userAgentData?: { platform?: string; getHighEntropyValues?: (hints: string[]) => Promise<{ platformVersion?: string }> } }).userAgentData;
  if (!uaData?.getHighEntropyValues) return crudeGuess();
  try {
    const info = await uaData.getHighEntropyValues(["platformVersion"]);
    if (uaData.platform === "Windows") {
      // Microsoft's own documented convention: platformVersion major >= 13
      // on the Windows Client Hints platform means Windows 11, despite the
      // UA string itself still saying "Windows NT 10.0" either way.
      const major = parseInt((info.platformVersion || "0").split(".")[0], 10);
      return major >= 13 ? "Win 11" : "Win 10";
    }
    return uaData.platform || crudeGuess();
  } catch {
    return crudeGuess();
  }
}

void resolve().then((label) => {
  cached = label;
});

function platformLabel(): string {
  return cached ?? crudeGuess();
}

/** The browser, from the User-Agent (order matters: Edge and Opera also say "Chrome"). */
function browserName(): string {
  const ua = navigator.userAgent;
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\/|Opera/.test(ua)) return "Opera";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Chrome\/|CriOS\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return "Browser";
}

/** "Chrome on Windows 11" — which browser and system a bookmark was made on, shown next to it in every app. */
export function deviceName(): string {
  const os = platformLabel().replace(/^Win\b/, "Windows").replace(/^Mac$/, "macOS");
  return `${browserName()} on ${os}`;
}
