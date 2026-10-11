# Chapters — names, numbers and skipping, the same in Audex (Android) and Webdex (web)

> Kept identical in `jonsjsj/audex-web` (`docs/CHAPTERS.md`) and `jonsjsj/codexaudio`
> (`docs/17-chapters.md`). Change it in both, or neither.

## What is shown

A chapter reads **`Chapter 33: The Gate`** — on the player's title screen (the chapter playing now), in the chapter
list, on the mini player, on the book page's chapter list and (Webdex) on the lock-screen / media-session card.
Front and back matter — opening credits, contents, dedication, prologue, epilogue, acknowledgements — stays in the
list as its own named entry **without a number**, like the contents of a printed book.

## The number is the book's, not the row's

Audiobook chapter lists hold front matter that the book's own numbering doesn't count, so numbering by position
made the book's Chapter 25 show as 26. Rules (`lib/chapters.ts` / `ChapterLabels` in `:core:domain`, tested with
the same cases in both repos), applied top to bottom of the list:

1. A title that is front/back matter (case-insensitive, whole title): opening/end credits, credits, title page,
   copyright, dedication, contents / table of contents, epigraph, foreword, preface, prologue, introduction,
   map(s), acknowledg(e)ments, about the author, author's note, epilogue, afterword, glossary, cast (of
   characters), also by…, excerpt…, preview…, appendix…, the end, "Part One/Two/…/N/IV" → label is the title,
   no number.
2. A title that already names a number — `Chapter 33`, `Chapter 33: Name`, `Chapter 33 - Name`, `Ch. 33`,
   `Chapter Thirty-Three`, `33. Name`, `33: Name`, `33` → that number; the rest is the name.
3. Any other title (`The Gate`) → the next number after the previous chapter (starts at 1; continues from an
   explicit number, so `Chapter 7` followed by `The next one` gives 8).

Label: `Chapter <n>: <name>`, or `Chapter <n>` when there is no name.

## Heard from the audio (preferred when available)

The rules above guess from the titles in the file, which are often wrong (`Salvation's Reach - Introduction` made every
real chapter number one too high; `Prologue: Day at the Beach` got a number). So Codex also **listens**: the align
service cuts a short clip at the start of every chapter, has Whisper transcribe it and reads out what the narrator says
("Chapter four. The Long Road", "Epilogue", "This is Audible…"). Codex serves the result at
`GET /audex/chapters/{audiobookshelf item id}` as, per chapter, `{index, start, end, label, kind, number, name, source}`.

* `source` is `heard` (the narrator said it), `inferred` (nobody announced it, but the neighbours leave exactly one
  number: 3, ?, 5 → 4) or `file` (nothing was said — the file's own title, no better than the rules above).
* The apps use the heard label only for `heard`/`inferred` chapters that sit at the same start time (±2 s) as the
  chapter in their own list; every other chapter keeps the title-based label. A book Codex hasn't listened to yet looks
  exactly as before.
* Front/back matter heard in the audio (`prologue`, `epilogue`, `intro`, `opening_credits`, `end_credits`…) gets no number.
* Audex keeps the labels with a downloaded book, so they are there offline; Webdex asks Codex when a book is opened.

## Skipping chapters

Next to the 30-second skip buttons (both back and forward) there are **previous chapter** and **next chapter**
buttons: `[ ⏮ ] [ ⟲30 ] [ ▶ ] [ ⟳30 ] [ ⏭ ]`.

* **Next** goes to the start of the next chapter (disabled on the last one).
* **Previous** goes to the start of the current chapter — or, within its first 3 seconds, to the one before.
* A book with no chapters: both disabled. Webdex also wires the OS media-session previous/next track to these.
* A jump of 2 minutes or more drops the usual automatic "Left off" bookmark (see BOOKMARKS.md).

The ebook reader's own chapter list is the book's table of contents and is shown as the book has it.
