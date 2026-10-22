# Page ⇄ audio, in step (on this device)

The reader and the player keep the **page** and the **audio** together, in both directions, with no word-by-word
highlighting needed — only the read-along map (docs/SYNC_API.md §3) for sentence accuracy.

* **Audio → page.** While the book's audio plays, the page turns to where the narration has got to (the "Keep the page and
  the audiobook together" switch in the reader's read-along panel; on by default).
* **Page → audio.** Turn a page by hand (swipe, tap, key, scrubber) and the audio moves to the **first words on that page**:
  the reader notes the first text on the page and the map finds the sentence that begins with it (`timeAtPage`); without a
  map it is proportional to the book's length when the audio is loaded. Playing, it carries on from there; paused, it waits
  there. Quick page flips count once (450 ms), and a page change that following the audio caused is recognised so the two
  never chase each other.
* **Switching screens.** Whichever of the two moved last leaves the place in this browser (`localStorage`,
  `audexweb.pos.<audio item id>`, see `lib/localSync.ts`): `{audioS, progress, by: "reader" | "player", at}`.
  Opening the player starts the audio at the reader's page; opening the reader opens on the sentence the player is on —
  instantly, without waiting for the server round trip that later carries the position to Audiobookshelf and Codex.
  A record older than 6 hours is ignored (the server's position wins), and another tab of the same site follows through the
  `storage` event.

Per-device convenience only: where storage is blocked everything above simply does nothing and the server positions are used
as before.
